import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT } from './config.js';

export const MODEL_ID = 'kokoro-82m';
const WORKER = path.join(ROOT, 'engine', 'kokoro_engine.py');

export class EngineError extends Error {
  constructor(message, code = 'engine') {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/**
 * Owns one long-lived Python process that keeps the Kokoro model in memory.
 * Requests go in as JSON lines and are answered in order, one at a time.
 */
export function createEngine({ getConfig }) {
  let child = null;
  let ready = null;
  let nextId = 1;
  let state = { status: 'stopped', error: null, device: null, voices: [], languages: [], samples: {} };
  const pending = new Map(); // id -> { req, resolve, reject, onProgress, aborted }

  const send = (entry) => child?.stdin.write(`${JSON.stringify(entry.req)}\n`);

  function start() {
    if (ready) return ready;
    const cfg = getConfig();
    if (!cfg.python) {
      const error = 'Kokoro is not installed yet. Run `npm run setup` in the tts-studio folder.';
      state = { ...state, status: 'error', error };
      return Promise.reject(new EngineError(error, 'not_installed'));
    }
    state = { ...state, status: 'starting', error: null };
    const proc = spawn(cfg.python, ['-u', WORKER, 'worker'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(cfg.device ? { TTS_DEVICE: cfg.device } : {}) },
    });
    child = proc;
    const stderr = [];
    proc.stderr.setEncoding('utf8').on('data', (d) => {
      stderr.push(...d.split('\n').filter((l) => l.trim()));
      stderr.splice(0, Math.max(0, stderr.length - 15));
    });
    proc.stdin.on('error', () => {}); // a dead worker is handled by the close event

    ready = new Promise((resolve, reject) => {
      let fatal = null;
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.event === 'ready') {
          const { event, ...info } = msg;
          state = { ...state, ...info, status: 'ready', error: null };
          resolve(state);
          return;
        }
        if (msg.event === 'fatal') {
          fatal = msg.message;
          return;
        }
        const entry = pending.get(msg.id);
        if (!entry) return;
        if (msg.event === 'progress') {
          entry.onProgress?.(msg.done, msg.total);
        } else if (msg.event === 'done') {
          pending.delete(msg.id);
          entry.resolve({ durationSec: msg.durationSec, bytes: msg.bytes, segments: msg.segments });
        } else if (msg.event === 'error') {
          pending.delete(msg.id);
          entry.reject(new EngineError(msg.message, 'synthesis'));
        }
      });
      let closed = false;
      const onClose = (code) => {
        if (closed) return;
        closed = true;
        const wasReady = state.status === 'ready';
        if (child === proc) {
          child = null;
          ready = null;
        }
        const deliberate = proc.stopping || proc.restarting;
        const error = deliberate
          ? null
          : fatal || `The Kokoro worker stopped unexpectedly (exit ${code}). ${stderr.slice(-3).join(' ')}`.trim();
        state = { ...state, status: deliberate ? 'stopped' : 'error', error };
        if (!wasReady) reject(new EngineError(error || 'Stopped', fatal ? 'not_installed' : 'crashed'));
        // Requests the worker never answered: cancelled ones fail, and so does
        // everything after a crash. Bystanders of a deliberate restart are sent again.
        const again = [];
        for (const [id, entry] of pending) {
          if (entry.aborted) entry.reject(new EngineError('Cancelled', 'aborted'));
          else if (!proc.restarting) entry.reject(new EngineError(error || 'The Kokoro worker was stopped.', 'crashed'));
          else {
            again.push(entry);
            continue;
          }
          pending.delete(id);
        }
        if (!proc.restarting || proc.stopping) return;
        start().then(
          () => again.forEach(send),
          (e) => again.forEach((entry) => {
            pending.delete(entry.req.id);
            entry.reject(e);
          }),
        );
      };
      proc.once('error', (e) => {
        fatal = `Could not start Python at ${cfg.python}: ${e.message}`;
        if (!proc.pid) onClose(null);
      });
      proc.once('close', onClose);
    });
    ready.catch(() => {});
    return ready;
  }

  /** Speak `text` into the file `out`. Resolves with { durationSec, bytes, segments }. */
  async function synthesize({ text, voice, speed = 1, out, format = 'mp3', onProgress, signal }) {
    if (signal?.aborted) throw new EngineError('Cancelled', 'aborted');
    await start();
    if (signal?.aborted) throw new EngineError('Cancelled', 'aborted');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const entry = { req: { id, text, voice, speed, out, format }, onProgress };
      const onAbort = () => {
        entry.aborted = true;
        // The worker cannot be interrupted mid-sentence, so replace it.
        if (child) {
          child.restarting = true;
          child.kill('SIGKILL');
        }
      };
      const settle = (fn) => (v) => {
        signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      entry.resolve = settle(resolve);
      entry.reject = settle(reject);
      pending.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      send(entry);
    });
  }

  function stop() {
    if (!child) return;
    child.stopping = true;
    child.kill('SIGKILL');
  }

  return {
    start,
    stop,
    synthesize,
    info: () => ({ status: state.status, error: state.error, device: state.device }),
    catalog: () => ({ voices: state.voices, languages: state.languages, samples: state.samples }),
  };
}
