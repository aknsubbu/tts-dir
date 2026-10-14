import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { cleanText } from './text.js';

// Control characters wrap matches in search snippets. The client splits on them
// and renders <mark> elements, so no HTML is ever injected.
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS generations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  source_name     TEXT,
  text            TEXT NOT NULL,
  text_hash       TEXT NOT NULL,
  config_hash     TEXT NOT NULL,
  char_count      INTEGER NOT NULL,
  word_count      INTEGER NOT NULL,
  voice_id        TEXT NOT NULL,
  voice_name      TEXT,
  model_id        TEXT NOT NULL,
  settings_json   TEXT NOT NULL,
  status          TEXT NOT NULL,
  progress_done   INTEGER NOT NULL DEFAULT 0,
  progress_total  INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  audio_bytes     INTEGER,
  duration_sec    REAL,
  favorite        INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_config ON generations(config_hash);
CREATE INDEX IF NOT EXISTS idx_gen_text ON generations(text_hash);
CREATE INDEX IF NOT EXISTS idx_gen_status ON generations(status);

CREATE VIRTUAL TABLE IF NOT EXISTS gen_fts USING fts5(
  title, text, tags,
  content='generations', content_rowid='seq',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS gen_ai AFTER INSERT ON generations BEGIN
  INSERT INTO gen_fts(rowid, title, text, tags) VALUES (new.seq, new.title, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS gen_ad AFTER DELETE ON generations BEGIN
  INSERT INTO gen_fts(gen_fts, rowid, title, text, tags) VALUES ('delete', old.seq, old.title, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS gen_au AFTER UPDATE OF title, text, tags ON generations BEGIN
  INSERT INTO gen_fts(gen_fts, rowid, title, text, tags) VALUES ('delete', old.seq, old.title, old.text, old.tags);
  INSERT INTO gen_fts(rowid, title, text, tags) VALUES (new.seq, new.title, new.text, new.tags);
END;

-- What deleted lessons cost, kept so deleting a lesson (or a profile) cannot reset the month's cap.
CREATE TABLE IF NOT EXISTS cost_ledger (
  profile_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  cost_usd    REAL NOT NULL
);

-- Each version of a lesson: what made it, what it cost, and whether it was built.
-- Its files are a snapshot in the project's versions/NNN/ folder.
CREATE TABLE IF NOT EXISTS versions (
  generation_id   TEXT NOT NULL,
  n               INTEGER NOT NULL,
  source          TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  cost_usd        REAL,
  usage_json      TEXT,
  check_ok        INTEGER,
  warnings        INTEGER,
  built_at        INTEGER,
  quality         TEXT,
  duration_sec    REAL,
  video_bytes     INTEGER,
  render_kept     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (generation_id, n)
);
`;

// Added after the first release; older libraries gain them on start.
// kind is 'audio' or 'video'. stage says what a lesson is doing while Claude writes it.
const MIGRATIONS = [
  ['kind', "ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio'"],
  ['stage', 'ALTER TABLE generations ADD COLUMN stage TEXT'],
  // The version a lesson is on, and the one its library video shows. A lesson being revised or
  // rebuilt keeps playing the built one.
  ['version', 'ALTER TABLE generations ADD COLUMN version INTEGER NOT NULL DEFAULT 0'],
  ['built_version', 'ALTER TABLE generations ADD COLUMN built_version INTEGER NOT NULL DEFAULT 0'],
  // Whose lesson it is. Rows from before profiles are '' until the Owner profile exists and takes them.
  ['profile_id', "ALTER TABLE generations ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''"],
];

const UPDATABLE = new Set([
  'title',
  'tags',
  'favorite',
  'status',
  'progress_done',
  'progress_total',
  'error',
  'audio_bytes',
  'duration_sec',
  'finished_at',
  'voice_name',
  'stage',
  'version',
  'built_version',
  // A lesson starts as the brief and becomes the narration once Claude has written it.
  'text',
  'char_count',
  'word_count',
  'settings_json',
]);

/** Turn free text into a safe FTS5 prefix query: every word must match, as a prefix. */
export function buildFtsQuery(q) {
  const tokens = String(q ?? '').match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' ');
}

export function toApi(row, { withText = false } = {}) {
  if (!row) return null;
  // A video plays once it is done, and a lesson keeps playing its last built version while a
  // newer one is written, checked or built.
  const playable = row.kind === 'video' && (row.status === 'done' || row.built_version > 0);
  const out = {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    // Cards show a readable preview: markdown stripped, whitespace collapsed.
    preview: cleanText(row.text.slice(0, 1200)).replace(/\s+/g, ' ').slice(0, 240).trim(),
    charCount: row.char_count,
    wordCount: row.word_count,
    voiceId: row.voice_id,
    voiceName: row.voice_name,
    modelId: row.model_id,
    settings: JSON.parse(row.settings_json),
    status: row.status,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    error: row.error,
    stage: row.stage || null,
    audioBytes: row.audio_bytes,
    durationSec: row.duration_sec,
    kind: row.kind || 'audio',
    favorite: !!row.favorite,
    tags: row.tags ? row.tags.split(',') : [],
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    version: row.version || 0,
    builtVersion: row.built_version || 0,
    audioUrl: row.status === 'done' && row.kind !== 'video' ? `/api/generations/${row.id}/audio` : null,
    videoUrl: playable ? `/api/generations/${row.id}/video` : null,
    posterUrl: playable ? `/api/generations/${row.id}/poster` : null,
  };
  if (withText) out.text = row.text;
  if (row.snip !== undefined) {
    out.snippet = row.snip && row.snip.includes(MARK_START) ? row.snip : null;
    out.titleSnippet =
      row.title_snip && row.title_snip.includes(MARK_START) ? row.title_snip : null;
  }
  return out;
}

export function createStore(dataDir) {
  const audioDir = path.join(dataDir, 'audio');
  const previewDir = path.join(dataDir, 'previews');
  const videoDir = path.join(dataDir, 'video');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'studio.db'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const columns = new Set(db.prepare('PRAGMA table_info(generations)').all().map((c) => c.name));
  for (const [column, sql] of MIGRATIONS) if (!columns.has(column)) db.exec(sql);
  db.exec('CREATE INDEX IF NOT EXISTS idx_gen_profile ON generations(profile_id, created_at DESC)');

  const insertStmt = db.prepare(`
    INSERT INTO generations (
      id, profile_id, kind, title, source_name, text, text_hash, config_hash, char_count, word_count,
      voice_id, voice_name, model_id, settings_json, status, tags, created_at
    ) VALUES (
      @id, @profile_id, @kind, @title, @source_name, @text, @text_hash, @config_hash, @char_count, @word_count,
      @voice_id, @voice_name, @model_id, @settings_json, @status, @tags, @created_at
    )`);
  const getStmt = db.prepare('SELECT * FROM generations WHERE id = ?');
  // Anything that changes an item is announced, for the page's live updates: 'change' with its id.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const deleteStmt = db.prepare('DELETE FROM generations WHERE id = ?');
  const ownerStmt = db.prepare('SELECT profile_id FROM generations WHERE id = ?');
  const findByConfigStmt = db.prepare(
    `SELECT * FROM generations
     WHERE profile_id = ? AND config_hash = ? AND status IN ('queued','processing','done')
     ORDER BY created_at DESC LIMIT 1`,
  );

  const audioPath = (id) => path.join(audioDir, `${id}.mp3`);
  const previewPath = (voiceId) => path.join(previewDir, `${voiceId}.mp3`);
  /** A built video, its captions and its poster: ext is mp4, srt, vtt or jpg. */
  const videoPath = (id, ext = 'mp4') => path.join(videoDir, `${id}.${ext}`);

  function update(id, patch) {
    const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE generations SET ${set} WHERE id = @id`).run({ ...patch, id });
    events.emit('change', id, ownerStmt.get(id)?.profile_id);
  }

  // What a revision asked for and changed, on versions made before it existed too.
  const versionColumns = new Set(db.prepare('PRAGMA table_info(versions)').all().map((c) => c.name));
  if (!versionColumns.has('details_json')) db.exec('ALTER TABLE versions ADD COLUMN details_json TEXT');
  // How much of a version's cost the host's own Claude sign-in or keys paid, which the Owner may limit per profile.
  if (!versionColumns.has('host_usd')) db.exec('ALTER TABLE versions ADD COLUMN host_usd REAL');
  if (!db.prepare('PRAGMA table_info(cost_ledger)').all().some((c) => c.name === 'host_usd')) db.exec('ALTER TABLE cost_ledger ADD COLUMN host_usd REAL');
  const versionStmts = {
    insert: db.prepare(`INSERT INTO versions (generation_id, n, source, note, created_at, cost_usd, host_usd, usage_json, check_ok, warnings, details_json)
                        VALUES (@generation_id, @n, @source, @note, @created_at, @cost_usd, @host_usd, @usage_json, @check_ok, @warnings, @details_json)`),
    list: db.prepare('SELECT * FROM versions WHERE generation_id = ? ORDER BY n DESC'),
    get: db.prepare('SELECT * FROM versions WHERE generation_id = ? AND n = ?'),
    next: db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM versions WHERE generation_id = ?'),
    remove: db.prepare('DELETE FROM versions WHERE generation_id = ?'),
  };
  const VERSION_FIELDS = new Set(['built_at', 'quality', 'duration_sec', 'video_bytes', 'render_kept', 'note']);
  const versions = {
    next: (id) => versionStmts.next.get(id).n,
    insert: (row) => versionStmts.insert.run({ note: null, cost_usd: null, host_usd: null, usage_json: null, check_ok: null, warnings: null, details_json: null, ...row }),
    list: (id) => versionStmts.list.all(id),
    get: (id, n) => versionStmts.get.get(id, n),
    update(id, n, patch) {
      const keys = Object.keys(patch).filter((k) => VERSION_FIELDS.has(k));
      if (!keys.length) return;
      db.prepare(`UPDATE versions SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE generation_id = @id AND n = @n`).run({ ...patch, id, n });
    },
    removeAll: (id) => versionStmts.remove.run(id),
  };

  /** Every read that returns many lessons takes the profile whose library it is: never optional. */
  const need = (profileId) => {
    if (!profileId) throw new Error('A library read needs a profile.');
    return profileId;
  };

  function list(profileId, { q, status, voiceId, favorite, tag, kind, sort, limit = 30, offset = 0 } = {}) {
    const fts = buildFtsQuery(q);
    const where = ['g.profile_id = ?'];
    const args = [need(profileId)];
    let from = 'generations g';
    let cols = 'g.*';
    if (fts) {
      from = 'gen_fts JOIN generations g ON g.seq = gen_fts.rowid';
      cols = `g.*,
        snippet(gen_fts, 1, '${MARK_START}', '${MARK_END}', '…', 24) AS snip,
        snippet(gen_fts, 0, '${MARK_START}', '${MARK_END}', '…', 12) AS title_snip`;
      where.push('gen_fts MATCH ?');
      args.push(fts);
    }
    if (status) {
      where.push('g.status = ?');
      args.push(status);
    }
    if (voiceId) {
      where.push('g.voice_id = ?');
      args.push(voiceId);
    }
    if (kind) {
      where.push('g.kind = ?');
      args.push(kind);
    }
    if (favorite) where.push('g.favorite = 1');
    if (tag) {
      where.push("instr(',' || g.tags || ',', ?) > 0");
      args.push(`,${String(tag).toLowerCase()},`);
    }
    const orders = {
      new: 'g.created_at DESC',
      old: 'g.created_at ASC',
      longest: 'COALESCE(g.duration_sec, 0) DESC, g.created_at DESC',
      title: 'g.title COLLATE NOCASE ASC',
      relevance: fts ? 'gen_fts.rank, g.created_at DESC' : 'g.created_at DESC',
    };
    const key = !sort || sort === 'relevance' ? 'relevance' : orders[sort] ? sort : 'new';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...args).n;
    const rows = db
      .prepare(`SELECT ${cols} FROM ${from} ${whereSql} ORDER BY ${orders[key]} LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
    return { total, items: rows.map((r) => toApi(r)) };
  }

  /**
   * What a lesson has cost that no version holds yet: an outline or a narration waiting to be approved, and an
   * attempt that failed. It is spent all the same, so the caps count it, and a deleted lesson leaves it in the ledger.
   */
  function unbilled(settingsJson, version) {
    const l = JSON.parse(settingsJson || '{}').lesson || {};
    const waiting = version ? 0 : 1; // once a version holds the earlier phases' cost, they are not counted twice
    return {
      usd: (Number(l.failedUsd) || 0) + waiting * ((Number(l.scriptCostUsd) || 0) + (Number(l.outlineCostUsd) || 0)),
      host: (Number(l.failedHostUsd) || 0) + waiting * ((Number(l.scriptHostUsd) || 0) + (Number(l.outlineHostUsd) || 0)),
    };
  }

  function stats(profileId, { excludeId = null } = {}) {
    need(profileId);
    const done = db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(char_count), 0) AS chars,
                COALESCE(SUM(duration_sec), 0) AS seconds,
                COALESCE(SUM(audio_bytes), 0) AS bytes
         FROM generations WHERE profile_id = ? AND status = 'done'`,
      )
      .get(profileId);
    const active = db
      .prepare(`SELECT COUNT(*) AS n FROM generations WHERE profile_id = ? AND status IN ('queued','processing')`)
      .get(profileId).n;
    const awaiting = db.prepare(`SELECT COUNT(*) AS n FROM generations WHERE profile_id = ? AND status = 'awaiting'`).get(profileId).n;
    // What writing lessons cost this calendar month, from every version made in it.
    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    const claude = db
      .prepare(
        `SELECT COALESCE(SUM(v.cost_usd), 0) AS usd, COUNT(*) AS n FROM versions v
         JOIN generations g ON g.id = v.generation_id WHERE g.profile_id = ? AND v.created_at >= ?`,
      )
      .get(profileId, month.getTime());
    const gone = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM cost_ledger WHERE profile_id = ? AND created_at >= ?').get(profileId, month.getTime()).usd;
    claude.usd += gone;
    let pendingUsd = 0;
    let pendingHost = 0;
    for (const r of db.prepare("SELECT id, version, settings_json FROM generations WHERE profile_id = ? AND settings_json LIKE '%\"lesson\"%'").all(profileId)) {
      if (r.id === excludeId) continue; // a lesson being retried is held to its own cap with its earlier attempts included
      const u = unbilled(r.settings_json, r.version);
      pendingUsd += u.usd;
      pendingHost += u.host;
    }
    claude.usd += pendingUsd;
    const hostUsd =
      db.prepare('SELECT COALESCE(SUM(v.host_usd), 0) AS usd FROM versions v JOIN generations g ON g.id = v.generation_id WHERE g.profile_id = ? AND v.created_at >= ?').get(profileId, month.getTime()).usd +
      db.prepare('SELECT COALESCE(SUM(host_usd), 0) AS usd FROM cost_ledger WHERE profile_id = ? AND created_at >= ?').get(profileId, month.getTime()).usd +
      pendingHost;
    const voices = db
      .prepare(
        `SELECT voice_id AS voiceId, COALESCE(MAX(voice_name), voice_id) AS name, COUNT(*) AS n
         FROM generations WHERE profile_id = ? GROUP BY voice_id ORDER BY n DESC`,
      )
      .all(profileId);
    return { ...done, active, awaiting, voices, costThisMonthUsd: Math.round(claude.usd * 100) / 100, hostSpentThisMonthUsd: Math.round(hostUsd * 100) / 100 };
  }

  function tags(profileId) {
    const counts = new Map();
    for (const { tags: t } of db.prepare("SELECT tags FROM generations WHERE profile_id = ? AND tags != ''").all(need(profileId))) {
      for (const tag of t.split(',')) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  }

  /** Jobs that were running when the server stopped cannot continue; flag them so they can be retried. */
  function markInterrupted() {
    return db
      .prepare(
        `UPDATE generations SET status = 'error', error = 'Interrupted by a server restart. Press Retry.',
                finished_at = ? WHERE status IN ('queued','processing')`,
      )
      .run(Date.now()).changes;
  }

  return {
    db,
    dataDir,
    audioPath,
    previewPath,
    videoPath,
    insert: (row) => {
      if (!row.profile_id) throw new Error('A lesson is inserted for a profile.');
      const out = insertStmt.run({ kind: 'audio', ...row });
      events.emit('change', row.id, row.profile_id);
      return out;
    },
    getRaw: (id) => getStmt.get(id),
    get: (id, opts) => toApi(getStmt.get(id), opts),
    findByConfig: (profileId, hash) => findByConfigStmt.get(need(profileId), hash),
    /** A lesson only if it is this profile's. Anyone else's is the same as none. */
    getOwned: (id, profileId, opts) => {
      const row = getStmt.get(id);
      return row && row.profile_id === profileId ? toApi(row, opts) : null;
    },
    getRawOwned: (id, profileId) => {
      const row = getStmt.get(id);
      return row && row.profile_id === profileId ? row : null;
    },
    /** Every lesson a profile has, as rows. */
    rowsOf: (profileId) => db.prepare('SELECT * FROM generations WHERE profile_id = ?').all(need(profileId)),
    update,
    remove: (id) => {
      const owner = ownerStmt.get(id)?.profile_id;
      if (owner !== undefined) {
        db.prepare('INSERT INTO cost_ledger (profile_id, created_at, cost_usd, host_usd) SELECT ?, created_at, cost_usd, host_usd FROM versions WHERE generation_id = ? AND cost_usd > 0').run(owner, id);
      }
      const gone = getStmt.get(id);
      if (gone) {
        const u = unbilled(gone.settings_json, gone.version);
        if (u.usd > 0) db.prepare('INSERT INTO cost_ledger (profile_id, created_at, cost_usd, host_usd) VALUES (?, ?, ?, ?)').run(gone.profile_id, Date.now(), u.usd, u.host);
      }
      versions.removeAll(id);
      const n = deleteStmt.run(id).changes;
      if (n) events.emit('change', id, owner);
      return n;
    },
    versions,
    events,
    // Across every profile on purpose: a folder is removed only when nobody's lesson still uses it.
    /** Which profiles have a lesson built from each project folder: name -> Set of profile ids. */
    projectOwners: () => {
      const owners = new Map();
      for (const r of db.prepare("SELECT DISTINCT source_name, profile_id FROM generations WHERE source_name LIKE 'video/projects/%'").all()) {
        const name = r.source_name.slice('video/projects/'.length);
        owners.set(name, (owners.get(name) || new Set()).add(r.profile_id));
      }
      return owners;
    },
    countBySource: (source) => db.prepare('SELECT COUNT(*) AS n FROM generations WHERE source_name = ?').get(source).n,
    list,
    stats,
    tags,
    markInterrupted,
    close: () => db.close(),
  };
}
