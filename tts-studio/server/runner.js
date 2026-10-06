import fs from 'node:fs';
import { cleanText } from './text.js';

/**
 * Serial job queue. One generation runs at a time because they all share
 * one Kokoro model. Video builds (kind 'video') queue here too: they speak
 * with Kokoro and keep the CPU busy rendering.
 */
export function createRunner({ store, engine, video }) {
  const queue = [];
  const controllers = new Map();
  const cancelled = new Set();
  const builds = new Set(); // ids of running video builds
  let active = null;

  function enqueue(id) {
    queue.push(id);
    pump();
  }

  function pump() {
    if (active) return;
    const id = queue.shift();
    if (!id) return;
    active = id;
    run(id)
      .catch(() => {})
      .finally(() => {
        active = null;
        controllers.delete(id);
        cancelled.delete(id);
        setImmediate(pump);
      });
  }

  async function run(id) {
    const row = store.getRaw(id);
    if (!row || row.status === 'cancelled') return;
    if (row.kind === 'video') return runVideo(row);
    const settings = JSON.parse(row.settings_json);
    const text = cleanText(row.text, { stripMarkdown: settings.stripMarkdown });
    const controller = new AbortController();
    controllers.set(id, controller);
    const file = store.audioPath(id);
    const tmp = `${file}.tmp`;

    store.update(id, { status: 'processing', progress_done: 0, progress_total: 0, error: null });

    const synthesize = () =>
      engine.synthesize({
        text,
        voice: row.voice_id,
        speed: settings.speed,
        out: tmp,
        signal: controller.signal,
        onProgress: (done, total) => store.update(id, { progress_done: done, progress_total: total }),
      });

    try {
      let result;
      try {
        result = await synthesize();
      } catch (e) {
        // A worker that died mid-job gets one fresh start before the job is failed.
        if (e.code !== 'crashed' || cancelled.has(id)) throw e;
        result = await synthesize();
      }
      if (cancelled.has(id)) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      fs.renameSync(tmp, file);
      store.update(id, {
        status: 'done',
        audio_bytes: result.bytes,
        duration_sec: result.durationSec,
        progress_done: result.segments,
        progress_total: result.segments,
        finished_at: Date.now(),
        error: null,
      });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (cancelled.has(id) || e.cancelled || e.code === 'aborted') {
        store.update(id, { status: 'cancelled', error: 'Cancelled', finished_at: Date.now() });
      } else {
        store.update(id, { status: 'error', error: e.message, finished_at: Date.now() });
      }
    }
  }

  async function runVideo(row) {
    const { id } = row;
    const settings = JSON.parse(row.settings_json);
    const controller = new AbortController();
    controllers.set(id, controller);
    builds.add(id);
    store.update(id, { status: 'processing', progress_done: 0, progress_total: 0, error: null });
    const outputs = ['mp4', 'srt', 'vtt'].map((ext) => store.videoPath(id, ext));
    try {
      if (!video) throw new Error('Video builds are not set up on this server.');
      const result = await video.build({
        project: settings.project,
        quality: settings.quality,
        signal: controller.signal,
        onProgress: (done, total) => store.update(id, { progress_done: done, progress_total: total }),
      });
      if (cancelled.has(id)) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      // The build folder is overwritten by the next build, so the library keeps its own copy.
      for (const [i, ext] of ['mp4', 'srt', 'vtt'].entries()) {
        if (result.files[ext]) fs.copyFileSync(result.files[ext], outputs[i]);
      }
      store.update(id, {
        status: 'done',
        audio_bytes: fs.statSync(outputs[0]).size,
        duration_sec: result.durationSec,
        progress_done: result.segments,
        progress_total: result.segments,
        finished_at: Date.now(),
        error: null,
      });
    } catch (e) {
      for (const f of outputs) fs.rmSync(f, { force: true });
      if (cancelled.has(id) || e.cancelled || e.code === 'aborted') {
        store.update(id, { status: 'cancelled', error: 'Cancelled', finished_at: Date.now() });
      } else {
        store.update(id, { status: 'error', error: e.message, finished_at: Date.now() });
      }
    } finally {
      builds.delete(id);
    }
  }

  /**
   * The server is going away. A video build runs in its own process group, so it would
   * outlive the server (and `node --watch` restarts on every save); kill it now.
   * The engine's worker is stopped by the engine itself.
   */
  function stop() {
    for (const id of builds) controllers.get(id)?.abort();
  }

  /** Cancel a queued or running job. Returns true if there was something to cancel. */
  function cancel(id) {
    const at = queue.indexOf(id);
    if (at !== -1) {
      queue.splice(at, 1);
      store.update(id, { status: 'cancelled', error: 'Cancelled', finished_at: Date.now() });
      return true;
    }
    if (active === id) {
      cancelled.add(id);
      controllers.get(id)?.abort();
      return true;
    }
    return false;
  }

  return {
    enqueue,
    cancel,
    stop,
    isActive: (id) => active === id || queue.includes(id),
    get queued() {
      return queue.length + (active ? 1 : 0);
    },
  };
}
