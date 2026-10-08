import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../author/proc.js';
import { chapterDir, chaptersOf, copySources } from './versions.js';

export const MAX_SOURCE = 200 * 1024; // bytes in script.txt or scenes.py
const pad = (n) => String(n).padStart(3, '0');

export class EditError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** The narration the library keeps: the script, or every chapter's in order. */
export function readProjectText(root) {
  const chapters = chaptersOf(root);
  const read = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, 'script.txt'), 'utf8').trim();
    } catch {
      return '';
    }
  };
  return chapters.length ? chapters.map((c) => read(chapterDir(root, c))).filter(Boolean).join('\n\n') : read(root);
}

/** A lesson's files in a folder: the working copy, or a version's snapshot. */
export function filesIn(dir) {
  const project = readJson(path.join(dir, 'project.json')) || {};
  return { script: readText(path.join(dir, 'script.txt')), scenes: readText(path.join(dir, 'scenes.py')), voice: project.voice || null, speed: Number(project.speed) || 1 };
}

/** What a save is compared against: the two files and the voice and speed. */
export const hashOf = ({ script, scenes, voice, speed }) => crypto.createHash('sha256').update(JSON.stringify([script, scenes, voice, Number(speed) || 1])).digest('hex').slice(0, 16);

function writeAtomic(file, body) {
  const tmp = `${file}.saving`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/**
 * Editing a lesson in the dashboard: its working copy (script.txt, scenes.py, and the voice and
 * speed in project.json), saved with a quick static check, checked in full and rendered as the
 * next version, discarded back to the current version, or an earlier version restored.
 *
 * Only lessons: a project written by hand stays read-only here. Nothing is saved while the lesson
 * is being written, checked or built, and a save made from an older copy than the one on disk
 * (another editor, a revision that landed) is refused rather than overwriting it.
 */
export function createEdits({ store, versions, getConfig, runner, lessons }) {
  const rootOf = (row) => versions.projectRoot(row);
  /** The folder being edited: the lesson's, or one of its chapters' (the first when none is named). */
  const folderOf = (root, chapter) => {
    const chapters = chaptersOf(root);
    if (!chapters.length) {
      if (chapter) throw new EditError('This lesson has no chapters.', 404);
      return { dir: root, chapter: null, chapters };
    }
    const id = chapter || chapters[0];
    if (!chapters.includes(id)) throw new EditError(`This lesson has no chapter “${String(id).slice(0, 60)}”.`, 404);
    return { dir: chapterDir(root, id), chapter: id, chapters };
  };
  const busy = (row) => ['queued', 'processing'].includes(row.status);
  const isLesson = (row) => !!JSON.parse(row.settings_json).lesson;
  const versionDir = (root, n) => path.join(root, 'versions', pad(n));

  function guard(row, { write = true } = {}) {
    if (!row || row.kind !== 'video') throw new EditError('Not found', 404);
    const root = rootOf(row);
    if (!root || !fs.existsSync(root)) throw new EditError('This lesson has no project folder.', 404);
    if (write && !isLesson(row)) throw new EditError('Projects written by hand are edited in their folder, not here.', 403);
    if (write && busy(row)) throw new EditError('This lesson is being written, checked or built. Wait for it to finish.', 409);
    return root;
  }

  /** The working copy as the Edit tab shows it, with what the last checks found. */
  function source(row, chapter = null) {
    const lessonRoot = guard(row, { write: false });
    const { dir: root, chapter: id, chapters } = folderOf(lessonRoot, chapter);
    const working = filesIn(root);
    const current = row.version ? filesIn(chapterDir(versionDir(lessonRoot, row.version), id)) : null;
    const hash = hashOf(working);
    const settings = JSON.parse(row.settings_json);
    const titles = readJson(path.join(lessonRoot, 'project.json'))?.chapter_titles || {};
    return {
      project: path.basename(lessonRoot),
      chapter: id,
      chapters: chapters.map((c) => ({ id: c, title: titles[c] || c })),
      ...working,
      hash,
      version: row.version || 0,
      builtVersion: row.built_version || 0,
      draft: current ? hashOf(current) !== hash : false,
      editable: isLesson(row),
      busy: busy(row),
      brief: readJson(path.join(lessonRoot, 'brief.json')),
      static: readJson(path.join(root, 'build', 'check', 'static.json')),
      report: readJson(path.join(root, 'build', 'check', 'report.json')),
      edit: settings.edit || null,
    };
  }

  /** check.py --static: blocks, marks, imports and scene classes, in a fraction of a second. */
  async function staticCheck(root) {
    const config = getConfig();
    if (!fs.existsSync(path.join(root, 'scenes.py'))) {
      return { ok: true, errors: [], warnings: [], at: Date.now(), note: 'No scenes yet: they are written once the narration is approved.' };
    }
    const [cmd, ...pre] = config.authorCheck || ['python3', path.join(config.videoDir, 'check.py')];
    const { stdout, stderr, code } = await run(cmd, [...pre, root, '--static', '--strict', '--sync-scenes'], {
      timeoutMs: 30_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      report = { ok: false, errors: [{ where: 'check', message: `The check could not run${code ? ` (exit ${code})` : ''}. ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim() }], warnings: [] };
    }
    report = { errors: [], warnings: [], ...report, at: Date.now() };
    fs.mkdirSync(path.join(root, 'build', 'check'), { recursive: true });
    fs.writeFileSync(path.join(root, 'build', 'check', 'static.json'), JSON.stringify(report));
    return report;
  }

  async function save(row, body = {}) {
    const lessonRoot = guard(row);
    const { dir: root, chapter } = folderOf(lessonRoot, body.chapter);
    const now = filesIn(root);
    if (body.base && body.base !== hashOf(now)) {
      throw new EditError('The files changed since you opened them: in another editor, or by a revision. Reload to see them; your edits are still in the page.', 409, { current: { ...now, hash: hashOf(now) } });
    }
    const next = { ...now };
    for (const key of ['script', 'scenes']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'string') throw new EditError(`${key} must be text.`);
      if (Buffer.byteLength(body[key]) > MAX_SOURCE) throw new EditError(`${key === 'script' ? 'script.txt' : 'scenes.py'} is limited to ${MAX_SOURCE / 1024} KB.`, 413);
      next[key] = body[key].replace(/\r\n/g, '\n');
    }
    if (body.voice !== undefined) {
      const voice = String(body.voice);
      if (!/^[ab][a-z]_[a-z0-9_]{1,40}$/.test(voice)) throw new EditError('Lessons need an English voice, such as af_heart.');
      next.voice = voice;
    }
    if (body.speed !== undefined) {
      const speed = Number(body.speed);
      if (!(speed >= 0.5 && speed <= 2)) throw new EditError('Speed is from 0.5 to 2.');
      next.speed = Math.round(speed * 100) / 100;
    }
    // A lesson made before versions existed: what is on disk becomes version 1 before it changes.
    // (A narration waiting for approval has no scenes yet, and becomes a version once it has.)
    if (!row.version && now.scenes != null) versions.snapshot(row.id, { source: 'written', note: 'As it was before the first edit' });
    if (next.script !== now.script) writeAtomic(path.join(root, 'script.txt'), next.script);
    if (next.scenes !== now.scenes) writeAtomic(path.join(root, 'scenes.py'), next.scenes);
    if (next.voice !== now.voice || next.speed !== now.speed) {
      const project = readJson(path.join(root, 'project.json')) || {};
      writeAtomic(path.join(root, 'project.json'), `${JSON.stringify({ ...project, voice: next.voice, speed: next.speed }, null, 2)}\n`);
    }
    const report = await staticCheck(root);
    return { ...source(store.getRaw(row.id), chapter), report };
  }

  /** A full check (narration and every scene, no drawing); with build, the next version renders if it passes. */
  async function check(row, { build = false, quality = null, chapter = null } = {}) {
    const lessonRoot = guard(row);
    const { chapter: id } = folderOf(lessonRoot, chapter);
    if (!lessons) throw new EditError('Lessons are not set up on this server.', 503);
    await lessons.checkEdit(row.id, { then: build ? 'build' : null, quality, chapter: id });
    return store.get(row.id);
  }

  /** The working copy back to the current version, every chapter included. */
  function discard(row) {
    const root = guard(row);
    if (!row.version) throw new EditError('There is no saved version to go back to.', 409);
    copySources(versionDir(root, row.version), root, 'in');
    for (const dir of [root, ...chaptersOf(root).map((c) => chapterDir(root, c))]) fs.rmSync(path.join(dir, 'build', 'check', 'static.json'), { force: true });
    return source(store.getRaw(row.id));
  }

  /**
   * Version n's files become the next version. When n's render is still kept it becomes the
   * lesson's video at once; otherwise the new version is built.
   */
  function restore(row, n) {
    const root = guard(row);
    const v = store.versions.get(row.id, n);
    const dir = versionDir(root, n);
    if (!v || !fs.existsSync(dir)) throw new EditError(`There is no version ${n}.`, 404);
    copySources(dir, root, 'in');
    const m = versions.snapshot(row.id, { source: 'restored', note: `Restored from v${n}`, check: v.check_ok == null ? null : { ok: !!v.check_ok, warnings: v.warnings } });
    const script = readProjectText(root);
    const settings = JSON.parse(row.settings_json);
    store.update(row.id, { text: script, char_count: script.length, word_count: script.split(/\s+/).filter(Boolean).length });
    if (versions.adopt(row.id, n, m)) {
      store.update(row.id, { status: 'done', stage: null, error: null, finished_at: Date.now(), duration_sec: v.duration_sec ?? row.duration_sec });
    } else {
      if (v.quality) settings.quality = v.quality;
      store.update(row.id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null, settings_json: JSON.stringify(settings) });
      runner.enqueue(row.id);
    }
    return store.get(row.id);
  }

  /** Version n's files (one chapter's, for a lesson in chapters), for History's comparisons. */
  function versionSource(row, n, chapter = null) {
    const root = guard(row, { write: false });
    const dir = versionDir(root, n);
    if (!store.versions.get(row.id, n) || !fs.existsSync(dir)) throw new EditError(`There is no version ${n}.`, 404);
    const chapters = chaptersOf(dir);
    const id = chapters.length ? (chapters.includes(chapter) ? chapter : chapters[0]) : null;
    return { n, chapter: id, chapters, ...filesIn(chapterDir(dir, id)) };
  }

  return { source, save, check, discard, restore, versionSource, staticCheck };
}
