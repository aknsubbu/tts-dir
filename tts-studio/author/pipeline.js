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
 *   fix       while the check finds errors, Claude is shown them and rewrites (a few rounds)
 *   polish    if only warnings are left, Claude gets one go at them; kept only if it helped
 *
 * `ask` and `check` can be replaced in tests.
 */
export function createAuthor({ getConfig, ask = askClaude, check = runCheck }) {
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
    let cost = 0;
    let step = 0;
    const consult = async (name, prompt) => {
      step += 1;
      const tag = `${String(step).padStart(2, '0')}-${name}`;
      fs.writeFileSync(path.join(log, `${tag}-prompt.md`), prompt);
      const { answer, costUsd } = await ask({ system, prompt, config, signal });
      cost += costUsd;
      fs.writeFileSync(path.join(log, `${tag}-answer.json`), JSON.stringify(answer, null, 2));
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
      onStage('Writing the lesson');
      save(await consult('write', lessonPrompt(brief)));
    }

    let report = await inspect('Checking the scenes');
    let fixes = 0;
    while (!report.ok) {
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
    if (report.warnings.length && config.authorPolish) {
      const before = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(root, f))]));
      onStage('Polishing timing and layout');
      save(await consult('polish', repairPrompt({ ...brief, ...current(), errors: [], warnings: report.warnings })));
      const after = await inspect('Checking the polish');
      if (after.ok && after.warnings.length < report.warnings.length) {
        report = after;
        polished = true;
      } else {
        // It broke something or fixed nothing: the version that passed stands.
        for (const [f, body] of Object.entries(before)) fs.writeFileSync(path.join(root, f), body);
      }
    }

    const result = {
      project: job.project,
      title: current().title,
      script: current().script,
      scenes: report.scenes,
      narrationSec: report.duration ?? null,
      warnings: report.warnings,
      fixes,
      polished,
      costUsd: Math.round(cost * 1000) / 1000,
    };
    fs.writeFileSync(path.join(root, 'author.json'), `${JSON.stringify({ ...result, script: undefined, finishedAt: new Date().toISOString() }, null, 2)}\n`);
    return result;
  }

  return { write };
}

function pickBrief(job) {
  return {
    topic: String(job.topic).trim(),
    goal: String(job.goal || '').trim(),
    notes: String(job.notes || '').trim(),
    minutes: Number(job.minutes) || 2,
    voice: job.voice || 'af_heart',
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
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
