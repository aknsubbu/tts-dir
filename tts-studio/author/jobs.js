import crypto from 'node:crypto';
import { createAuthor, PROJECT_NAME } from './pipeline.js';
import { normalizeWriter } from './writers/plan.js';
import { MAX_NOTES } from '../shared/limits.js';

const KEEP_FINISHED = 50;
const KINDS = ['write', 'check', 'revise'];

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * The lesson writer's job queue: turns a topic and notes into a video project by asking
 * Claude (`claude -p`) or another writer, and checking what comes back. It runs inside the
 * dashboard's process; server/lessons.js submits jobs and follows them.
 *
 *   submit({ project, topic, goal, notes, minutes, voice, writer, capUsd }) -> job
 *          { project, kind: "check" } only checks a project's files again
 *          { project, kind: "revise", request, scope, history, attachments } changes
 *          a written lesson; { phase: "script" | "scenes" } writes the narration
 *          alone, or the scenes for an approved one
 *          writer is the plan for each step (provider, model, effort), as the
 *          dashboard resolves it from Settings; it never carries a key
 *          A bad request throws an error with .status 400, or 409 when the project is busy.
 *   get(id)    -> job, or null     stage, and the result once status is "done"
 *   cancel(id) -> job, or null
 *
 * Up to TTS_AUTHOR_PARALLEL jobs run at once, since most of a job is waiting on Claude.
 * Their checks still take turns (see createAuthor): each speaks with Kokoro and runs manim.
 * One project has at most one job.
 */
export function createAuthorJobs({ getConfig, author = createAuthor({ getConfig }) }) {
  const jobs = new Map(); // id -> { id, kind, project, status, stage, error, result, input, controller }
  const queue = [];
  const active = new Set();

  const view = (j) => ({ id: j.id, kind: j.kind, project: j.project, status: j.status, stage: j.stage, error: j.error, result: j.result, createdAt: j.createdAt });
  const parallel = () => Math.max(1, Number(getConfig().authorParallel) || 1);

  function pump() {
    while (active.size < parallel() && queue.length) start(queue.shift());
  }

  function start(job) {
    active.add(job);
    job.status = 'working';
    job.controller = new AbortController();
    const options = { signal: job.controller.signal, onStage: (stage) => (job.stage = stage) };
    const work = job.kind === 'check' ? author.check(job.input, options) : job.kind === 'revise' ? author.revise(job.input, options) : author.write(job.input, options);
    work
      .then(
        (result) => Object.assign(job, { status: 'done', stage: job.kind === 'check' ? 'Checked' : { script: 'Narration ready', outline: 'Outline ready' }[result?.phase] || 'Ready to build', result }),
        (e) => Object.assign(job, e.code === 'aborted' ? { status: 'cancelled', stage: 'Cancelled' } : { status: 'error', stage: 'Failed', error: e.message }),
      )
      .finally(() => {
        active.delete(job);
        job.input = null; // the notes are on disk in brief.json; no need to keep them here
        const finished = [...jobs.values()].filter((j) => j !== job && !['queued', 'working'].includes(j.status));
        for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(old.id);
        setImmediate(pump);
      });
  }

  function submit(body = {}) {
    const b = JSON.parse(JSON.stringify(body)); // the job's own copy, as it was when it came over HTTP
    const project = String(b.project || '');
    if (!PROJECT_NAME.test(project)) throw invalid('A lesson needs a project name of letters, digits, - and _.');
    const kind = b.kind === undefined ? 'write' : String(b.kind);
    if (!KINDS.includes(kind)) throw invalid(`A job is one of: ${KINDS.join(', ')}.`);
    const resume = kind !== 'write' || b.topic === undefined; // a retry or a check: the brief is already saved in the project
    if (!resume && !String(b.topic).trim()) throw invalid('A lesson needs a topic.');
    if (kind === 'revise' && !String(b.request || '').trim()) throw invalid('Say what to change.');
    if (String(b.notes || '').length > MAX_NOTES) throw invalid(`Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters.`);
    if (b.writer !== undefined) {
      try {
        normalizeWriter(b.writer, getConfig());
      } catch (e) {
        throw invalid(e.message);
      }
    }
    if ([...jobs.values()].some((j) => j.project === project && ['queued', 'working'].includes(j.status))) {
      throw invalid(`“${project}” is already being written.`, 409);
    }
    const job = {
      id: crypto.randomUUID(),
      kind,
      project,
      status: 'queued',
      stage: 'Waiting for the lesson writer',
      error: null,
      result: null,
      createdAt: Date.now(),
      input: {
        project,
        writer: b.writer,
        capUsd: b.capUsd,
        phase: b.phase,
        chapter: b.chapter,
        redo: b.redo ? String(b.redo).slice(0, 2000) : undefined,
        ...(kind === 'revise' ? { request: String(b.request).slice(0, 4000), scope: b.scope, history: b.history, attachments: b.attachments } : {}),
        ...(resume ? {} : { topic: b.topic, goal: b.goal, notes: b.notes, minutes: b.minutes, voice: b.voice, attachments: b.attachments, visualReview: b.visualReview, titleCards: b.titleCards }),
      },
    };
    jobs.set(job.id, job);
    queue.push(job);
    pump();
    return view(job);
  }

  function get(id) {
    const job = jobs.get(id);
    return job ? view(job) : null;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const at = queue.indexOf(job);
    if (at !== -1) {
      queue.splice(at, 1);
      Object.assign(job, { status: 'cancelled', stage: 'Cancelled', input: null });
    } else if (active.has(job)) {
      job.controller.abort();
    }
    return view(job);
  }

  /** The server is going away: stop Claude and the check with it. */
  function stop() {
    queue.length = 0;
    for (const job of active) job.controller?.abort();
  }

  return { submit, get, cancel, stop };
}
