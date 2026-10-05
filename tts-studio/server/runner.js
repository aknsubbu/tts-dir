import fs from 'node:fs';
import { cleanText } from './text.js';

/**
 * Serial job queue. One generation runs at a time because they all share
 * one Kokoro model.
 */
export function createRunner({ store, engine }) {
  const queue = [];
  const controllers = new Map();
  const cancelled = new Set();
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
    isActive: (id) => active === id || queue.includes(id),
    get queued() {
      return queue.length + (active ? 1 : 0);
    },
  };
}
