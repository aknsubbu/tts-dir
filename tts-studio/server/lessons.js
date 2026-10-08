import fs from 'node:fs';
import path from 'node:path';
import { countWords } from './text.js';
import { readProject } from './video.js';
import { VIDEO_QUALITIES } from '../shared/limits.js';
import { filesIn, hashOf } from './edits.js';

/**
 * Follows lessons through the lesson writer (author/), a separate small server.
 *
 * A lesson is a video whose script and scenes Claude writes from a topic and notes.
 * Writing takes minutes and needs no Kokoro, so it does not wait in the runner's
 * queue: the row sits at "processing" with a stage, and joins the queue as an
 * ordinary video build once its project is ready.
 */
export function createLessons({ store, runner, getConfig, versions = null, settings = null, pollMs = 1500 }) {
  const watching = new Map(); // generation id -> { jobId, timer, misses }

  const base = () => {
    const cfg = getConfig();
    return cfg.authorUrl || `http://127.0.0.1:${cfg.authorPort}`;
  };

  async function call(method, route, body) {
    const res = await fetch(base() + route, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `The lesson writer answered ${res.status}.`);
    return data;
  }

  const unreachable = () => `The lesson writer is not running at ${base()}. Restart Narrated Proofs, then press Retry.`;

  function fail(id, message) {
    watching.delete(id);
    store.update(id, { status: 'error', error: message, stage: null, finished_at: Date.now() });
  }

  /** True once Claude's project has passed its check, so a retry only needs to build it. */
  function isWritten(project) {
    return fs.existsSync(path.join(getConfig().videoDir, 'projects', project, 'author.json'));
  }

  /**
   * Who writes each step, and what the lesson may still spend, from Settings as they are now.
   * A retry gets them afresh, so a raised cap or a newly set up provider applies.
   */
  async function writerFor(lesson = {}) {
    if (!settings) return {};
    const writer = settings.resolveWriter(lesson.profile || 'page', lesson.writer || null);
    await settings.checkWriter(writer);
    const { lessonCapUsd, monthCapUsd } = settings.costs();
    let capUsd = lessonCapUsd;
    if (monthCapUsd != null) {
      const left = Math.round((monthCapUsd - store.stats().costThisMonthUsd) * 100) / 100;
      if (left <= 0) throw new Error(`This month's lessons have reached the monthly cap of $${monthCapUsd.toFixed(2)}. Raise it in Settings → Costs, then press Retry.`);
      capUsd = capUsd == null ? left : Math.min(capUsd, left);
    }
    return { writer, capUsd };
  }

  /**
   * Hand a lesson to the writer and start following it. `brief` is { topic, goal, notes,
   * minutes, voice, visualReview }; leave it out to retry with the brief saved in the project.
   */
  async function start(id, brief) {
    const row = store.getRaw(id);
    const { project, lesson } = JSON.parse(row.settings_json);
    store.update(id, {
      status: 'processing', stage: 'Waiting for the lesson writer', error: null,
      progress_done: 0, progress_total: 0, finished_at: null,
    });
    let plan;
    try {
      plan = await writerFor(lesson);
    } catch (e) {
      return fail(id, e.message);
    }
    let job;
    try {
      ({ job } = await call('POST', '/lessons', { project, ...brief, ...plan }));
    } catch (e) {
      return fail(id, e.cause ? unreachable() : e.message); // fetch sets .cause when it could not connect
    }
    watching.set(id, { jobId: job.id, misses: 0 });
    schedule(id);
  }

  function schedule(id) {
    const watch = watching.get(id);
    if (!watch) return;
    watch.timer = setTimeout(() => poll(id), pollMs);
    watch.timer.unref?.();
  }

  async function poll(id) {
    const watch = watching.get(id);
    if (!watch) return;
    let job;
    try {
      ({ job } = await call('GET', `/lessons/${watch.jobId}`));
      watch.misses = 0;
    } catch (e) {
      if (!watching.has(id)) return; // cancelled while we were asking
      // The writer forgets its jobs when it restarts, so a 404 will not get better.
      watch.misses += 1;
      if (!e.cause || watch.misses >= 5) return fail(id, e.cause ? unreachable() : 'The lesson writer restarted and lost this lesson. Press Retry.');
      return schedule(id);
    }
    if (!watching.has(id)) return;
    if (watch.kind === 'check') {
      if (job.status === 'done') return finishCheck(id, job.result, watch);
      if (job.status === 'error') return endCheck(id, watch, { ok: false, error: job.error || 'The check could not run.' });
      if (job.status === 'cancelled') return endCheck(id, watch, null);
    }
    if (job.status === 'done') return finish(id, job.result);
    if (job.status === 'error') return fail(id, job.error || 'The lesson could not be written.');
    if (job.status === 'cancelled') {
      watching.delete(id);
      return store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    }
    if (store.getRaw(id)?.stage !== job.stage) store.update(id, { stage: job.stage });
    schedule(id);
  }

  /**
   * The project is written and checked: fill in the row, make it a version, and queue the
   * build, or stop at the storyboard when the person asked to see it first.
   */
  function finish(id, result) {
    watching.delete(id);
    const row = store.getRaw(id);
    if (!row) return;
    const settings = JSON.parse(row.settings_json);
    const project = readProject(getConfig().videoDir, settings.project);
    const script = project?.script || result.script || row.text;
    // The totals stay on the row; each request's figures are in the version and in author.json.
    const usage = result.usage ? { ...result.usage } : null;
    if (usage) delete usage.requests;
    Object.assign(settings, {
      scenes: result.scenes,
      lesson: {
        ...settings.lesson,
        fixes: result.fixes,
        autofixed: result.autofixed?.length || 0,
        polished: result.polished,
        warnings: result.warnings?.length || 0,
        costUsd: result.costUsd ?? null,
        usage,
        ...(result.writtenBy ? { writtenBy: result.writtenBy } : {}),
      },
    });
    const review = settings.lesson.review === 'storyboard';
    store.update(id, {
      // Keep a title the person typed; otherwise use the one Claude gave the video.
      ...(settings.lesson.ownTitle ? {} : { title: String(result.title || row.title).slice(0, 120) }),
      text: script,
      char_count: script.length,
      word_count: countWords(script),
      settings_json: JSON.stringify(settings),
      status: review ? 'awaiting' : 'queued',
      stage: review ? 'Storyboard ready: have a look' : null,
    });
    try {
      versions?.snapshot(id, {
        source: 'written',
        usage: result.usage || null,
        costUsd: result.costUsd ?? null,
        check: { ok: true, warnings: result.warnings?.length || 0 },
      });
    } catch (e) {
      console.error(`Could not keep version files for ${settings.project}: ${e.message}`);
    }
    if (!review) runner.enqueue(id);
  }

  /**
   * Check a lesson's edited files in full: the narration is spoken and every scene run without
   * drawing, leaving a fresh storyboard. With then: 'build', a passing check makes the next
   * version and builds it. Either way the lesson goes back to where it was while it is checked,
   * so a built lesson keeps playing its video.
   */
  async function checkEdit(id, { then = null, quality = null } = {}) {
    const row = store.getRaw(id);
    const { project } = JSON.parse(row.settings_json);
    const prior = { status: row.status, stage: row.stage, error: row.error, finished_at: row.finished_at };
    store.update(id, { status: 'processing', stage: then === 'build' ? 'Checking your changes before rendering' : 'Checking your changes', error: null, progress_done: 0, progress_total: 0 });
    let job;
    try {
      ({ job } = await call('POST', '/lessons', { project, kind: 'check' }));
    } catch (e) {
      store.update(id, prior);
      throw Object.assign(new Error(e.cause ? unreachable() : e.message), { status: 503 });
    }
    watching.set(id, { jobId: job.id, misses: 0, kind: 'check', prior, then, quality });
    schedule(id);
  }

  function saveCheck(id, report, summary) {
    const row = store.getRaw(id);
    if (!row) return null;
    const settings = JSON.parse(row.settings_json);
    const root = path.join(getConfig().videoDir, 'projects', settings.project);
    if (report) {
      fs.mkdirSync(path.join(root, 'build', 'check'), { recursive: true });
      fs.writeFileSync(path.join(root, 'build', 'check', 'report.json'), JSON.stringify({ ...report, at: Date.now() }));
      if (report.scenes?.length) settings.scenes = report.scenes;
    }
    settings.edit = { checkedAt: Date.now(), ...summary };
    return { settings, root };
  }

  /** The check finished: keep its report, then build the edit as the next version or go back to where it was. */
  function finishCheck(id, report, watch) {
    watching.delete(id);
    const saved = saveCheck(id, report, { ok: !!report.ok, errors: report.errors?.length || 0, warnings: report.warnings?.length || 0 });
    if (!saved) return;
    const { settings, root } = saved;
    if (watch.then === 'build' && report.ok) {
      const script = readProject(getConfig().videoDir, settings.project)?.script || fs.readFileSync(path.join(root, 'script.txt'), 'utf8');
      if (VIDEO_QUALITIES.includes(watch.quality)) settings.quality = watch.quality;
      store.update(id, { settings_json: JSON.stringify(settings), text: script, char_count: script.length, word_count: countWords(script) });
      try {
        // Files the same as the current version (one whose build failed, say) build that version again.
        const row = store.getRaw(id);
        const current = row.version ? path.join(root, 'versions', String(row.version).padStart(3, '0')) : null;
        const same = current && fs.existsSync(current) && hashOf(filesIn(current)) === hashOf(filesIn(root));
        if (!same) versions?.snapshot(id, { source: 'edited', note: 'Edited in the dashboard', check: { ok: true, warnings: report.warnings?.length || 0 } });
      } catch (e) {
        console.error(`Could not keep version files for ${settings.project}: ${e.message}`);
      }
      store.update(id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null });
      return runner.enqueue(id);
    }
    store.update(id, { settings_json: JSON.stringify(settings), ...watch.prior });
  }

  function endCheck(id, watch, failure) {
    watching.delete(id);
    const saved = failure ? saveCheck(id, null, failure) : null;
    store.update(id, { ...(saved ? { settings_json: JSON.stringify(saved.settings) } : {}), ...watch.prior });
  }

  /** Stop following a lesson and tell the writer to stop too. Returns true if it was being written or checked. */
  function cancel(id) {
    const watch = watching.get(id);
    if (!watch) return false;
    clearTimeout(watch.timer);
    call('POST', `/lessons/${watch.jobId}/cancel`).catch(() => {});
    if (watch.kind === 'check') {
      endCheck(id, watch, null); // a cancelled check leaves the lesson as it was
      return true;
    }
    watching.delete(id);
    store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    return true;
  }

  function stop() {
    for (const watch of watching.values()) clearTimeout(watch.timer);
    watching.clear();
  }

  return { start, checkEdit, cancel, stop, isWritten, isActive: (id) => watching.has(id) };
}
