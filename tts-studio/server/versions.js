import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_NAME } from './video.js';

const SOURCES = ['script.txt', 'scenes.py', 'project.json', 'outline.json'];
const CHAPTER = /^\d{2}-[a-z0-9-]{1,48}$/;

/** The chapters a lesson's project.json lists, as folder names; [] for a lesson in one piece. */
export function chaptersOf(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).chapters;
    return Array.isArray(list) ? list.filter((c) => CHAPTER.test(String(c))) : [];
  } catch {
    return [];
  }
}

/** Where one chapter's files are: the lesson's folder or a snapshot's, then chapters/<id>. */
export const chapterDir = (dir, chapter) => (chapter ? path.join(dir, 'chapters', chapter) : dir);

/**
 * Copy a lesson's sources between its working copy and a snapshot, each chapter's too, with the
 * storyboard each was last checked with. `boards` says which way the storyboards go:
 * 'out' from build/check into storyboard/, 'in' back again.
 */
export function copySources(from, to, boards) {
  const one = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of SOURCES) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    const [bFrom, bTo] = boards === 'out' ? [path.join(src, 'build', 'check'), path.join(dest, 'storyboard')] : [path.join(src, 'storyboard'), path.join(dest, 'build', 'check')];
    const board = path.join(bFrom, 'storyboard.json');
    if (!fs.existsSync(board)) return;
    if (boards === 'out') fs.rmSync(bTo, { recursive: true, force: true });
    fs.mkdirSync(path.join(bTo, 'frames'), { recursive: true });
    fs.copyFileSync(board, path.join(bTo, 'storyboard.json'));
    let listed;
    try {
      listed = stillsOf(JSON.parse(fs.readFileSync(board, 'utf8')));
    } catch {
      listed = new Set();
    }
    for (const file of listed) {
      const still = path.join(bFrom, 'frames', file);
      if (fs.existsSync(still)) fs.copyFileSync(still, path.join(bTo, 'frames', file));
    }
  };
  one(from, to);
  for (const c of chaptersOf(from)) one(path.join(from, 'chapters', c), path.join(to, 'chapters', c));
}
export const RENDER_EXTS = ['mp4', 'srt', 'vtt', 'jpg', 'words.json', 'chapters.vtt'];
const pad = (n) => String(n).padStart(3, '0');

/**
 * Versions of a lesson.
 *
 * The project folder's script.txt, scenes.py and project.json are the working copy, so
 * build.py, check.py and any editor keep working on them. Each version is a snapshot of
 * those files in versions/NNN/, with the storyboard its check left and a version.json.
 *
 * The library's data/video/<id>.mp4 (and its captions and poster) are the render of the
 * lesson's built version, so every existing route keeps working. When a newer version is
 * built, the older render moves to data/video/<id>/v<n>.*, and only the last few are kept.
 */
export function createVersions({ store, getConfig }) {
  function projectRoot(row) {
    const { project } = JSON.parse(row.settings_json);
    return PROJECT_NAME.test(String(project)) ? path.join(getConfig().videoDir, 'projects', project) : null;
  }
  const versionDir = (root, n) => path.join(root, 'versions', pad(n));
  const renderDir = (id) => path.join(path.dirname(store.videoPath(id)), id);
  const archived = (id, n, ext) => path.join(renderDir(id), `v${n}.${ext}`);

  /**
   * Make the next version of lesson `id` from its project's files as they are now.
   * `source` says what made it: written, edited, revised or restored. Returns its number.
   */
  function snapshot(id, { source, note = null, usage = null, costUsd = null, check = null, details = null }) {
    const row = store.getRaw(id);
    const root = row && projectRoot(row);
    if (!root || !fs.existsSync(root)) throw new Error('This lesson has no project folder to take a version of.');
    const n = store.versions.next(id);
    const dir = versionDir(root, n);
    copySources(root, dir, 'out');
    const createdAt = Date.now();
    fs.writeFileSync(
      path.join(dir, 'version.json'),
      `${JSON.stringify({ n, source, note, createdAt: new Date(createdAt).toISOString(), costUsd, usage, ...(details ? { details } : {}) }, null, 2)}\n`,
    );
    store.versions.insert({
      generation_id: id,
      n,
      source,
      note,
      created_at: createdAt,
      cost_usd: costUsd,
      usage_json: usage ? JSON.stringify(usage) : null,
      check_ok: check ? (check.ok ? 1 : 0) : null,
      warnings: check?.warnings ?? null,
      details_json: details ? JSON.stringify(details) : null,
    });
    store.update(id, { version: n });
    return n;
  }

  /** Before a new render replaces data/video/<id>.*: move the built version's render aside, if it is older. */
  function archiveCurrent(id) {
    const row = store.getRaw(id);
    const built = row?.built_version || 0;
    if (!built || built === row.version) return;
    fs.mkdirSync(renderDir(id), { recursive: true });
    for (const ext of RENDER_EXTS) {
      const current = store.videoPath(id, ext);
      if (fs.existsSync(current)) fs.renameSync(current, archived(id, built, ext));
    }
  }

  /** Version `n` of lesson `id` was built: its render is now the library's. Older renders beyond the limit go. */
  function built(id, n, { quality = null, durationSec = null, bytes = null } = {}) {
    store.versions.update(id, n, { built_at: Date.now(), quality, duration_sec: durationSec, video_bytes: bytes, render_kept: 1 });
    store.update(id, { built_version: n });
    const keep = Math.max(1, Number(getConfig().keepRenders) || 3);
    const kept = store.versions.list(id).filter((v) => v.render_kept); // newest first
    for (const v of kept.slice(keep)) {
      for (const ext of RENDER_EXTS) fs.rmSync(archived(id, v.n, ext), { force: true });
      store.versions.update(id, v.n, { render_kept: 0 });
    }
  }

  /**
   * Version `to` is a copy of version `from`: when from's render is still kept, it becomes the
   * library's render for `to` without building. Returns false when there is no render to reuse.
   */
  function adopt(id, from, to) {
    const v = store.versions.get(id, from);
    if (!v?.render_kept || !renderFile(id, from)) return false;
    archiveCurrent(id); // the playing render moves aside first, so it can be the one adopted
    for (const ext of RENDER_EXTS) {
      const kept = archived(id, from, ext);
      if (fs.existsSync(kept)) fs.copyFileSync(kept, store.videoPath(id, ext));
      else fs.rmSync(store.videoPath(id, ext), { force: true });
    }
    built(id, to, { quality: v.quality, durationSec: v.duration_sec, bytes: v.video_bytes });
    return true;
  }

  /** The file holding version n's render, or null when it was not kept. */
  function renderFile(id, n, ext = 'mp4') {
    const row = store.getRaw(id);
    if (!row) return null;
    const file = row.built_version === n ? store.videoPath(id, ext) : archived(id, n, ext);
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Where a storyboard lives: the working copy's (the last check) or a version's snapshot.
   * Returns { dir, frames, board } or null when there is none.
   */
  function storyboard(row, version, chapter = null) {
    const root = projectRoot(row);
    if (!root || (chapter && !CHAPTER.test(String(chapter)))) return null;
    const dir = version ? path.join(chapterDir(versionDir(root, version), chapter), 'storyboard') : path.join(chapterDir(root, chapter), 'build', 'check');
    const file = path.join(dir, 'storyboard.json');
    if (!fs.existsSync(file)) return null;
    try {
      return { dir, frames: path.join(dir, 'frames'), board: JSON.parse(fs.readFileSync(file, 'utf8')), root };
    } catch {
      return null;
    }
  }

  /** Delete the kept renders of a lesson (its library item is going). The project's versions/ stays with the project. */
  function removeRenders(id) {
    fs.rmSync(renderDir(id), { recursive: true, force: true });
  }

  /** The working copy back to version n's files and storyboards, after a revision that failed. */
  function resetTo(id, n) {
    const row = store.getRaw(id);
    const root = row && projectRoot(row);
    const dir = root && versionDir(root, n);
    if (!dir || !fs.existsSync(dir)) return false;
    copySources(dir, root, 'in');
    return true;
  }

  return { snapshot, archiveCurrent, built, adopt, resetTo, renderFile, storyboard, removeRenders, projectRoot, versionDir };
}

/** Every still file a storyboard lists. */
export function stillsOf(board) {
  const out = new Set();
  for (const scene of board?.scenes || []) {
    for (const block of scene.blocks || []) for (const s of block.stills || []) out.add(path.basename(String(s.file)));
    if (scene.end) out.add(path.basename(String(scene.end)));
  }
  return out;
}
