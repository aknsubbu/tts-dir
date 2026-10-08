import fs from 'node:fs';
import path from 'node:path';
import { askClaude } from './claude.js';
import { AuthorError, run } from './proc.js';
import { guide, lessonPrompt, repairPrompt } from './prompts.js';

export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const HEADER = ['from manimlib import *', 'from voiceover import VoiceoverScene'];
const FILES = ['script.txt', 'scenes.py', 'project.json'];

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
 * Each step asks with its own effort, and every request's token counts are kept.
 * `ask`, `check` and `autofix` can be replaced in tests.
 */
export function createAuthor({ getConfig, ask = askClaude, check = runCheck, autofix = runAutofix }) {
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
    const requests = [];
    let step = 0;
    const effortFor = {
      write: config.claudeEffort,
      fix: config.claudeFixEffort ?? config.claudeEffort,
      polish: config.claudePolishEffort ?? config.claudeEffort,
    };
    const consult = async (name, prompt, attachments = []) => {
      step += 1;
      const tag = `${String(step).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(log, `${tag}-prompt.md`), prompt);
      const effort = effortFor[name];
      const { answer, costUsd, usage } = await ask({ system, prompt, attachments, config, signal, effort });
      const used = { step: name, effort: effort || null, ...(usage || {}), costUsd: costUsd || 0 };
      requests.push(used);
      fs.writeFileSync(path.join(log, `${tag}-answer.json`), JSON.stringify(answer, null, 2));
      fs.writeFileSync(path.join(log, `${tag}-usage.json`), JSON.stringify(used, null, 2));
      return normalizeDraft(answer);
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
      onStage(label);
      const report = await check(root, { config, signal });
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
      onStage(attachments.length ? 'Reading the notes and writing the lesson' : 'Writing the lesson');
      save(await consult('write', lessonPrompt(brief), attachments));
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
    while (!report.ok) {
      if (await tryAutofix()) {
        report = await inspect('Checking the automatic fixes');
        if (report.ok) break;
      }
      if (fixes >= config.authorMaxFixes) {
        const first = report.errors[0];
        throw new AuthorError(
          `The scenes still fail after ${fixes} fix${fixes === 1 ? '' : 'es'}. ${first.where}: ${first.message.trim().split('\n').pop()}`,
        );
      }
      fixes += 1;
      onStage(`Fixing the scenes (${fixes} of ${config.authorMaxFixes})`);
      save(await consult('fix', repairPrompt({ ...brief, ...current(), errors: report.errors, warnings: report.warnings })));
      report = await inspect('Checking the scenes');
    }

    let polished = false;
    const visual = brief.visualReview ?? config.authorVisualReview;
    const stills = visual ? reviewStills(root) : [];
    if ((report.warnings.length && config.authorPolish) || stills.length) {
      const before = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(root, f))]));
      onStage(stills.length ? 'Looking over the frames' : 'Polishing timing and layout');
      save(await consult('polish', repairPrompt({ ...brief, ...current(), errors: [], warnings: report.warnings, pictures: stills.length }), stills));
      // project.json is rewritten by every check in its own format, so only the two files Claude writes count.
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
    };
    fs.writeFileSync(path.join(root, 'author.json'), `${JSON.stringify({ ...result, script: undefined, finishedAt: new Date().toISOString() }, null, 2)}\n`);
    return result;
  }

  return { write };
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
