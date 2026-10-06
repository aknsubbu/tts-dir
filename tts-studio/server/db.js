import Database from 'better-sqlite3';
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
`;

// Added after the first release; older libraries gain them on start.
// kind is 'audio' or 'video'. stage says what a lesson is doing while Claude writes it.
const MIGRATIONS = [
  ['kind', "ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio'"],
  ['stage', 'ALTER TABLE generations ADD COLUMN stage TEXT'],
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
    audioUrl: row.status === 'done' && row.kind !== 'video' ? `/api/generations/${row.id}/audio` : null,
    videoUrl: row.status === 'done' && row.kind === 'video' ? `/api/generations/${row.id}/video` : null,
    posterUrl: row.status === 'done' && row.kind === 'video' ? `/api/generations/${row.id}/poster` : null,
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

  const insertStmt = db.prepare(`
    INSERT INTO generations (
      id, kind, title, source_name, text, text_hash, config_hash, char_count, word_count,
      voice_id, voice_name, model_id, settings_json, status, tags, created_at
    ) VALUES (
      @id, @kind, @title, @source_name, @text, @text_hash, @config_hash, @char_count, @word_count,
      @voice_id, @voice_name, @model_id, @settings_json, @status, @tags, @created_at
    )`);
  const getStmt = db.prepare('SELECT * FROM generations WHERE id = ?');
  const deleteStmt = db.prepare('DELETE FROM generations WHERE id = ?');
  const findByConfigStmt = db.prepare(
    `SELECT * FROM generations
     WHERE config_hash = ? AND status IN ('queued','processing','done')
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
  }

  function list({ q, status, voiceId, favorite, tag, kind, sort, limit = 30, offset = 0 } = {}) {
    const fts = buildFtsQuery(q);
    const where = [];
    const args = [];
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

  function stats() {
    const done = db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(char_count), 0) AS chars,
                COALESCE(SUM(duration_sec), 0) AS seconds,
                COALESCE(SUM(audio_bytes), 0) AS bytes
         FROM generations WHERE status = 'done'`,
      )
      .get();
    const active = db
      .prepare(`SELECT COUNT(*) AS n FROM generations WHERE status IN ('queued','processing')`)
      .get().n;
    const voices = db
      .prepare(
        `SELECT voice_id AS voiceId, COALESCE(MAX(voice_name), voice_id) AS name, COUNT(*) AS n
         FROM generations GROUP BY voice_id ORDER BY n DESC`,
      )
      .all();
    return { ...done, active, voices };
  }

  function tags() {
    const counts = new Map();
    for (const { tags: t } of db.prepare("SELECT tags FROM generations WHERE tags != ''").all()) {
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
    audioPath,
    previewPath,
    videoPath,
    insert: (row) => insertStmt.run({ kind: 'audio', ...row }),
    getRaw: (id) => getStmt.get(id),
    get: (id, opts) => toApi(getStmt.get(id), opts),
    findByConfig: (hash) => findByConfigStmt.get(hash),
    update,
    remove: (id) => deleteStmt.run(id).changes,
    list,
    stats,
    tags,
    markInterrupted,
    close: () => db.close(),
  };
}
