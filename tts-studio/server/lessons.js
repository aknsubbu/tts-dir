import fs from 'node:fs';
import path from 'node:path';
import { countWords } from './text.js';
import { readProject } from './video.js';

/**
 * Follows lessons through the lesson writer (author/), a separate small server.
 *
 * A lesson is a video whose script and scenes Claude writes from a topic and notes.
 * Writing takes minutes and needs no Kokoro, so it does not wait in the runner's
 * queue: the row sits at "processing" with a stage, and joins the queue as an
 * ordinary video build once its project is ready.
 */
export function createLessons({ store, runner, getConfig, pollMs = 1500 }) {
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

  const unreachable = () => `The lesson writer is not running at ${base()}. Restart TTS Studio, then press Retry.`;

  function fail(id, message) {
    watching.delete(id);
    store.update(id, { status: 'error', error: message, stage: null, finished_at: Date.now() });
  }

  /** True once Claude's project has passed its check, so a retry only needs to build it. */
  function isWritten(project) {
    return fs.existsSync(path.join(getConfig().videoDir, 'projects', project, 'author.json'));
  }

  /**
   * Hand a lesson to the writer and start following it. `brief` is { topic, goal, notes,
   * minutes, voice }; leave it out to retry with the brief saved in the project.
   */
  async function start(id, brief) {
    const row = store.getRaw(id);
    const { project } = JSON.parse(row.settings_json);
    store.update(id, {
      status: 'processing', stage: 'Waiting for the lesson writer', error: null,
      progress_done: 0, progress_total: 0, finished_at: null,
    });
    let job;
    try {
      ({ job } = await call('POST', '/lessons', { project, ...brief }));
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
    if (job.status === 'done') return finish(id, job.result);
    if (job.status === 'error') return fail(id, job.error || 'The lesson could not be written.');
    if (job.status === 'cancelled') {
      watching.delete(id);
      return store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    }
    if (store.getRaw(id)?.stage !== job.stage) store.update(id, { stage: job.stage });
    schedule(id);
  }

  /** The project is written and checked: fill in the row and queue the build. */
  function finish(id, result) {
    watching.delete(id);
    const row = store.getRaw(id);
    if (!row) return;
    const settings = JSON.parse(row.settings_json);
    const project = readProject(getConfig().videoDir, settings.project);
    const script = project?.script || result.script || row.text;
    Object.assign(settings, { scenes: result.scenes, lesson: { ...settings.lesson, fixes: result.fixes, polished: result.polished, warnings: result.warnings?.length || 0 } });
    store.update(id, {
      // Keep a title the person typed; otherwise use the one Claude gave the video.
      ...(settings.lesson.ownTitle ? {} : { title: String(result.title || row.title).slice(0, 120) }),
      text: script,
      char_count: script.length,
      word_count: countWords(script),
      settings_json: JSON.stringify(settings),
      status: 'queued',
      stage: null,
    });
    runner.enqueue(id);
  }

  /** Stop following a lesson and tell the writer to stop too. Returns true if it was being written. */
  function cancel(id) {
    const watch = watching.get(id);
    if (!watch) return false;
    clearTimeout(watch.timer);
    watching.delete(id);
    call('POST', `/lessons/${watch.jobId}/cancel`).catch(() => {});
    store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    return true;
  }

  function stop() {
    for (const watch of watching.values()) clearTimeout(watch.timer);
    watching.clear();
  }

  return { start, cancel, stop, isWritten, isActive: (id) => watching.has(id) };
}
