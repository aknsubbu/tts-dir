import fs from 'node:fs';
import path from 'node:path';
import { LESSON_SCHEMA } from './claude.js';
import { AuthorError, run } from './proc.js';
import { guide, lessonPrompt, readPrompt, repairPrompt } from './prompts.js';
import { askWriter } from './writers/index.js';
import { normalizeWriter, sameModel, who } from './writers/plan.js';
import { createSecrets } from '../server/secrets.js';
import { pageTexts } from '../server/pdf.js';

export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const HEADER = ['from manimlib import *', 'from voiceover import VoiceoverScene'];
const FILES = ['script.txt', 'scenes.py', 'project.json'];

/** What the reading step returns: the attached files, written out. */
export const READ_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'string', description: 'Everything in the attached files, as Markdown with LaTeX' } },
  required: ['notes'],
  additionalProperties: false,
};

const stripFence = (s) => s.replace(/^\s*```[a-z]*\n/, '').replace(/\n```\s*$/, '');

/** Tidy what Claude returned into the three things written to disk. */
export function normalizeDraft(answer) {
  let scenes = stripFence(answer.scenes).trim();
  const missing = HEADER.filter((line) => !scenes.split('\n').some((l) => l.trim() === line));
  if (missing.length) scenes = `${missing.join('\n')}\n${scenes}`;
  return {
    title: answer.title.replace(/\s+/g, ' ').trim().slice(0, 120),
    script: `${stripFence(answer.script).trim()}\n`,
    scenes: `${scenes}\n`,
  };
}

/**
 * Turns a brief (topic, goal, notes) into a video project that passes check.py.
 *
 *   write     Claude writes the script and the scenes
 *   check     check.py reads them, speaks the script and runs every scene
 *   autofix   common mistakes (names from the other Manim, a mistyped mark) are fixed
 *             without asking anyone, and checked again
 *   fix       while the check still finds errors, Claude is shown them and rewrites (a few rounds)
 *   polish    if only warnings are left, Claude gets one go at them; kept only if it helped.
 *             With visual review on, it also sees the storyboard's stills and always gets that go
 *
 * Each step is asked of the writer the plan names for it (provider, model, effort; see
 * writers/), and every request's token counts and cost are kept. With pictures or PDFs in the
 * notes and a different writer for reading them, a reading step writes them out first, so a
 * writer that cannot see still gets everything in them. After plan.handBack.after failed fixes
 * by a fixing writer other than the main one, the fixes go back to the main one. A lesson
 * stops when it reaches its spending cap.
 *
 * `ask`, `check` and `autofix` can be replaced in tests.
 */
export function createAuthor({ getConfig, ask = askWriter, check = runCheck, autofix = runAutofix, secrets = null }) {
  // Jobs run side by side, but a check speaks with Kokoro and runs manim: one at a time.
  const checkTurn = createTurns();
  const inTurn = async (root, { config, signal, onStage, label }) => {
    if (checkTurn.busy()) onStage('Waiting for another lesson to finish its check');
    return checkTurn.take(() => {
      onStage(label);
      return check(root, { config, signal });
    }, signal);
  };

  async function write(job, { signal, onStage = () => {} } = {}) {
    const config = getConfig();
    if (!PROJECT_NAME.test(job.project)) throw new AuthorError('That project name is not usable.');
    const root = path.join(config.videoDir, 'projects', job.project);
    const log = path.join(root, 'build', 'author');
    fs.mkdirSync(log, { recursive: true });

    // A retry sends only the project name: the brief is the one saved the first time.
    const briefFile = path.join(root, 'brief.json');
    const brief = job.topic ? pickBrief(job) : readJson(briefFile);
    if (!brief?.topic) throw new AuthorError('There is no brief for this project, so there is nothing to write from.');
    fs.writeFileSync(briefFile, `${JSON.stringify(brief, null, 2)}\n`);
    fs.rmSync(path.join(root, 'author.json'), { force: true });

    const system = guide();
    const plan = normalizeWriter(job.writer, config);
    const capUsd = Number(job.capUsd) > 0 ? Number(job.capUsd) : null;
    const needsKeys = Object.values(plan.steps).some((w) => !['claude-code', 'ollama', 'local'].includes(w.kind));
    const keys = secrets || (needsKeys && config.dataDir ? createSecrets({ dataDir: config.dataDir, useKeychain: config.useKeychain }) : null);
    // What earlier attempts at this lesson spent: a retry continues, and so does its cap.
    const spentFile = path.join(log, 'spent.json');
    const spentBefore = Number(readJson(spentFile)?.usd) || 0;
    const requests = [];
    const spent = () => spentBefore + requests.reduce((n, r) => n + (Number(r.costUsd) || 0), 0);
    const overCap = () => {
      if (!capUsd || spent() < capUsd) return;
      throw new AuthorError(
        `This lesson reached its spending cap of $${capUsd.toFixed(2)} ($${spent().toFixed(2)} so far). Raise the cap in Settings → Costs and press Retry: it continues from where it stopped.`,
        'cap',
      );
    };
    let step = 0;
    const consult = async (name, w, prompt, attachments = [], schema = LESSON_SCHEMA) => {
      overCap();
      step += 1;
      const tag = `${String(step).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(log, `${tag}-prompt.md`), prompt);
      const record = (usage, extra = {}) => {
        const used = { step: name, provider: w.provider, label: w.label, effort: w.effort || null, ...(usage || {}), model: usage?.model || w.model || null, costUsd: Number(usage?.costUsd) || 0, ...extra };
        requests.push(used);
        fs.writeFileSync(path.join(log, `${tag}-usage.json`), JSON.stringify(used, null, 2));
        fs.writeFileSync(spentFile, JSON.stringify({ usd: spent() }));
      };
      let out;
      try {
        out = await ask({ writer: w, secrets: keys, system, prompt, attachments, schema, config, signal, effort: w.effort });
      } catch (e) {
        if (e.usage) record(e.usage, { failed: true, error: e.message.slice(0, 300) });
        throw e;
      }
      record({ ...(out.usage || {}), costUsd: out.costUsd || 0 });
      fs.writeFileSync(path.join(log, `${tag}-answer.json`), JSON.stringify(out.answer, null, 2));
      return out.answer;
    };
    const save = (draft) => {
      fs.writeFileSync(path.join(root, 'script.txt'), draft.script);
      fs.writeFileSync(path.join(root, 'scenes.py'), draft.scenes);
      const old = readJson(path.join(root, 'project.json')) || {};
      const project = { title: draft.title, voice: brief.voice, speed: 1.0, script: 'script.txt', scenes_file: 'scenes.py', scenes: old.scenes || [] };
      fs.writeFileSync(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    };
    const current = () => ({
      title: readJson(path.join(root, 'project.json'))?.title || brief.topic,
      script: fs.readFileSync(path.join(root, 'script.txt'), 'utf8'),
      scenes: fs.readFileSync(path.join(root, 'scenes.py'), 'utf8'),
    });
    const inspect = async (label) => {
      const report = await inTurn(root, { config, signal, onStage, label });
      step += 1;
      fs.writeFileSync(path.join(log, `${String(step).padStart(2, '0')}-check.json`), JSON.stringify(report, null, 2));
      return report;
    };

    // A project that already has its files (a retry after a failure) goes straight to the check.
    if (!FILES.every((f) => fs.existsSync(path.join(root, f)))) {
      // Pictures and PDFs go with the first request only. A fix is about code that failed,
      // and by then what they said is in the script.
      const attachments = (brief.attachments || []).map((a) => {
        const file = path.join(root, 'notes', path.basename(a.file));
        if (!fs.existsSync(file)) throw new AuthorError(`The attached file ${a.name} is missing from the project's notes folder.`);
        return { ...a, path: file };
      });
      const writer = plan.steps.write;
      const together = sameModel(plan.steps.read, writer);
      let notes = brief.notes;
      let send = [];
      if (attachments.length) {
        // The writer reads the files itself when it is also the reader; otherwise the reader
        // writes them out first. Either way, PDFs a model cannot take go as their text.
        const reader = together ? writer : plan.steps.read;
        const { files, text } = await usableBy(reader, attachments);
        if (text) notes = [notes, text].filter(Boolean).join('\n\n');
        if (together) send = files;
        else if (files.length) {
          const cache = path.join(root, 'notes', 'transcribed.md');
          let transcript = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8').trim() : '';
          if (!transcript) {
            onStage(`Reading the notes with ${who(reader)}`);
            transcript = String((await consult('read', reader, readPrompt({ topic: brief.topic, attachments: files }), files, READ_SCHEMA)).notes).trim();
            fs.writeFileSync(cache, `${transcript}\n`);
          }
          notes = [notes, `# From the attached files (${files.map((f) => f.name).join(', ')}), as read by ${who(reader)}\n\n${transcript}`].filter(Boolean).join('\n\n');
        }
      }
      onStage(send.length ? 'Reading the notes and writing the lesson' : 'Writing the lesson');
      save(normalizeDraft(await consult('write', writer, lessonPrompt({ ...brief, notes, attachments: send }), send)));
      overCap();
    }

    const autofixed = [];
    const tryAutofix = async () => {
      let result;
      try {
        result = await autofix(root, report, { config, signal });
      } catch (e) {
        if (e.code === 'aborted') throw e;
        return false; // the fixer is a shortcut; without it Claude fixes everything as before
      }
      if (!result?.changed) return false;
      step += 1;
      fs.writeFileSync(path.join(log, `${String(step).padStart(2, '0')}-autofix.json`), JSON.stringify(result, null, 2));
      autofixed.push(...result.fixes);
      return true;
    };

    let report = await inspect('Checking the scenes');
    let fixes = 0;
    // Hand-back: a fixing writer other than the main one gets plan.handBack.after tries, then
    // the main writer takes over with rounds of its own.
    const main = plan.steps.write;
    const canHandBack = plan.handBack.after > 0 && !sameModel(plan.steps.fix, main);
    let handedBack = false;
    let failedFixes = 0;
    let allowed = config.authorMaxFixes;
    const fixer = () => (handedBack ? { ...main, effort: plan.steps.fix.effort } : plan.steps.fix);
    while (!report.ok) {
      if (await tryAutofix()) {
        report = await inspect('Checking the automatic fixes');
        if (report.ok) break;
      }
      if (canHandBack && !handedBack && failedFixes >= plan.handBack.after) {
        handedBack = true;
        allowed = fixes + config.authorMaxFixes;
        onStage(`Handing the fixes back to ${who(main)}`);
      }
      if (fixes >= allowed) {
        const first = report.errors[0];
        throw new AuthorError(
          `The scenes still fail after ${fixes} fix${fixes === 1 ? '' : 'es'}. ${first.where}: ${first.message.trim().split('\n').pop()}`,
        );
      }
      fixes += 1;
      const w = fixer();
      onStage(`Fixing the scenes (${fixes} of ${allowed})${sameModel(w, main) ? '' : ` with ${who(w)}`}`);
      let draft;
      try {
        draft = normalizeDraft(await consult('fix', w, repairPrompt({ ...brief, ...current(), errors: report.errors, warnings: report.warnings })));
      } catch (e) {
        // A cheaper writer that cannot even answer counts as a failed fix, while there is someone to hand back to.
        if (e.code === 'aborted' || e.code === 'cap' || !canHandBack || handedBack) throw e;
        failedFixes += 1;
        continue;
      }
      save(draft);
      report = await inspect('Checking the scenes');
      if (!report.ok && !handedBack) failedFixes += 1;
    }

    let polished = false;
    const visual = brief.visualReview ?? config.authorVisualReview;
    const polisher = handedBack ? { ...main, effort: plan.steps.polish.effort } : plan.steps.polish;
    // Stills go only to a polisher that can see; one that cannot gets the warnings alone.
    const stills = visual && polisher.caps?.images ? reviewStills(root) : [];
    const atCap = capUsd && spent() >= capUsd; // the lesson passes; polishing is not worth going over
    if (!atCap && ((report.warnings.length && config.authorPolish) || stills.length)) {
      const before = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(root, f))]));
      onStage(stills.length ? 'Looking over the frames' : 'Polishing timing and layout');
      try {
        save(normalizeDraft(await consult('polish', polisher, repairPrompt({ ...brief, ...current(), errors: [], warnings: report.warnings, pictures: stills.length }), stills)));
      } catch (e) {
        // The lesson already passes: a polish that cannot be had leaves it as it is.
        if (e.code === 'aborted') throw e;
      }
      // project.json is rewritten by every check in its own format, so only the two files the writer writes count.
      const changed = ['script.txt', 'scenes.py'].some((f) => !fs.readFileSync(path.join(root, f)).equals(before[f]));
      const after = changed ? await inspect('Checking the polish') : report;
      // A visual review may fix what no warning names, so it only has to break nothing.
      const better = stills.length ? after.warnings.length <= report.warnings.length : after.warnings.length < report.warnings.length;
      if (changed && after.ok && better) {
        report = after;
        polished = true;
      } else {
        // It broke something or fixed nothing: the version that passed stands.
        for (const [f, body] of Object.entries(before)) fs.writeFileSync(path.join(root, f), body);
      }
    }

    const usage = totalUsage(requests);
    if (spentBefore) usage.earlierAttemptsUsd = Math.round(spentBefore * 1000) / 1000;
    usage.costUsd = Math.round(spent() * 1000) / 1000;
    const result = {
      project: job.project,
      title: current().title,
      script: current().script,
      scenes: report.scenes,
      narrationSec: report.duration ?? null,
      warnings: report.warnings,
      fixes,
      autofixed,
      polished,
      costUsd: usage.costUsd,
      usage,
      writtenBy: writtenBy(requests),
    };
    fs.rmSync(spentFile, { force: true });
    fs.writeFileSync(path.join(root, 'author.json'), `${JSON.stringify({ ...result, script: undefined, finishedAt: new Date().toISOString() }, null, 2)}\n`);
    return result;
  }

  /**
   * Check a project's files as they are, for the storyboard after an edit: no Claude, no fixes.
   * Returns the check's report; the storyboard is in the project's build/check/.
   */
  async function checkOnly(job, { signal, onStage = () => {} } = {}) {
    const config = getConfig();
    if (!PROJECT_NAME.test(job.project)) throw new AuthorError('That project name is not usable.');
    const root = path.join(config.videoDir, 'projects', job.project);
    if (!FILES.every((f) => fs.existsSync(path.join(root, f)))) throw new AuthorError('This project has no script and scenes to check yet.');
    fs.mkdirSync(path.join(root, 'build', 'author'), { recursive: true });
    return inTurn(root, { config, signal, onStage, label: 'Checking the scenes' });
  }

  return { write, check: checkOnly };
}

/**
 * Which of the notes' files a writer can be sent, and the text of the PDFs it cannot read.
 * A picture it cannot see, or a scanned PDF it cannot read, stops the lesson with what to change.
 */
export async function usableBy(w, attachments) {
  const files = [];
  const texts = [];
  for (const a of attachments) {
    if (a.kind === 'image' && !w.caps?.images) {
      throw new AuthorError(`Your notes include pictures (${a.name}), and ${who(w)} cannot see pictures. In Settings → Lesson writer, choose a model that can for “Reading your notes”.`);
    }
    if (a.kind === 'pdf' && !w.caps?.pdf) {
      let text = '';
      try {
        text = (await pageTexts(a.path)).map((t) => t.trim()).filter(Boolean).join('\n\n');
      } catch {
        /* no way to take its text here: treated as a scan */
      }
      if (!text) throw new AuthorError(`${a.name} has no text to take (it looks like a scan), and ${who(w)} cannot read PDFs. Choose a model that can for “Reading your notes”.`);
      texts.push(`# From ${a.name} (its text only)\n\n${text}`);
      continue;
    }
    files.push(a);
  }
  return { files, text: texts.join('\n\n') };
}

/** Who wrote what: each step once, with the provider and model that answered it. */
export function writtenBy(requests) {
  const seen = new Map();
  for (const r of requests) {
    if (r.failed) continue;
    const key = `${r.step}|${r.provider}|${r.model}`;
    if (!seen.has(key)) seen.set(key, { step: r.step, provider: r.provider, label: r.label, model: r.model || null });
  }
  return [...seen.values()];
}

/** A queue of turns: take(fn) runs fn once every earlier taker is done. Cancelling a wait leaves the queue. */
export function createTurns() {
  let tail = Promise.resolve();
  let waiting = 0;
  return {
    busy: () => waiting > 0,
    take(fn, signal) {
      const before = tail;
      let done;
      const mine = new Promise((resolve) => (done = resolve));
      tail = before.then(() => mine);
      waiting += 1;
      const turn = new Promise((resolve, reject) => {
        before.then(resolve);
        if (signal?.aborted) reject(new AuthorError('Cancelled', 'aborted'));
        signal?.addEventListener('abort', () => reject(new AuthorError('Cancelled', 'aborted')), { once: true });
      });
      return turn.then(fn).finally(() => {
        waiting -= 1;
        done();
      });
    },
  };
}

/** Token counts and cost over every request, with the requests themselves. */
export function totalUsage(requests) {
  const sum = (key) => requests.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return {
    requests,
    inputTokens: sum('inputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: Math.round(sum('costUsd') * 1000) / 1000,
  };
}

const MAX_REVIEW_STILLS = 16;

/**
 * The storyboard's end-of-block stills, as attachments Claude can look at: at most
 * MAX_REVIEW_STILLS, spread over the lesson when there are more blocks than that.
 */
export function reviewStills(root) {
  let board;
  try {
    board = JSON.parse(fs.readFileSync(path.join(root, 'build', 'check', 'storyboard.json'), 'utf8'));
  } catch {
    return [];
  }
  const all = [];
  for (const scene of board.scenes || []) {
    for (const block of scene.blocks || []) {
      const still = (block.stills || []).find((x) => x.mark == null);
      const file = still && path.join(root, 'build', 'check', 'frames', path.basename(still.file));
      if (file && fs.existsSync(file)) all.push({ name: `${scene.name}, block [${block.id}], at its end`, kind: 'image', type: 'image/png', path: file });
    }
  }
  if (all.length <= MAX_REVIEW_STILLS) return all;
  return Array.from({ length: MAX_REVIEW_STILLS }, (_, i) => all[Math.round((i * (all.length - 1)) / (MAX_REVIEW_STILLS - 1))]);
}

function pickBrief(job) {
  return {
    topic: String(job.topic).trim(),
    goal: String(job.goal || '').trim(),
    notes: String(job.notes || '').trim(),
    minutes: Number(job.minutes) || 2,
    voice: job.voice || 'af_heart',
    ...(job.visualReview === undefined ? {} : { visualReview: !!job.visualReview }),
    // Saved into notes/ by the dashboard; only names come here.
    attachments: (Array.isArray(job.attachments) ? job.attachments : [])
      .filter((a) => a && ['image', 'pdf'].includes(a.kind) && typeof a.file === 'string')
      .map((a) => ({ name: String(a.name || path.basename(a.file)), file: `notes/${path.basename(a.file)}`, kind: a.kind, type: a.type || null })),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run video/autofix.py on a project with the check's report: { changed, fixes }.
 * Missing (a toolchain without it, or a test that has none) means nothing was fixed.
 */
export async function runAutofix(root, report, { config, signal }) {
  const [cmd, ...pre] = config.authorAutofix || ['python3', path.join(config.videoDir, 'autofix.py')];
  if (!config.authorAutofix && !fs.existsSync(pre[0])) return { changed: false, fixes: [] };
  const reportFile = path.join(root, 'build', 'author', 'last-check.json');
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const { stdout } = await run(cmd, [...pre, root, '--report', reportFile], {
    signal,
    timeoutMs: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  try {
    const out = JSON.parse(stdout);
    return { changed: !!out.changed, fixes: Array.isArray(out.fixes) ? out.fixes.map(String) : [] };
  } catch {
    return { changed: false, fixes: [] };
  }
}

/** Run video/check.py on a project and return its report. */
export async function runCheck(root, { config, signal }) {
  const [cmd, ...pre] = config.authorCheck || ['python3', path.join(config.videoDir, 'check.py')];
  // --strict: these scenes were written by a model, so they get the tighter import and name rules.
  const { code, stdout, stderr } = await run(cmd, [...pre, root, '--sync-scenes', '--strict'], {
    signal,
    timeoutMs: config.checkTimeoutMs,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  try {
    const report = JSON.parse(stdout);
    if (typeof report.ok !== 'boolean') throw new Error('no verdict');
    return { errors: [], warnings: [], scenes: [], ...report };
  } catch {
    const said = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw new AuthorError(`The check could not run${code ? ` (exit ${code})` : ''}. ${said}`.trim());
  }
}
