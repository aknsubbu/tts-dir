import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSON_SCHEMA } from './claude.js';
import { AuthorError, run } from './proc.js';
import { guide, lessonPrompt, readPrompt, repairPrompt, revisePrompt, scenesPrompt } from './prompts.js';
import { askWriter } from './writers/index.js';
import { normalizeWriter, sameModel, who } from './writers/plan.js';
import { createSecrets } from '../server/secrets.js';
import { pageTexts } from '../server/pdf.js';

export const PROJECT_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const HEADER = ['from manimlib import *', 'from voiceover import VoiceoverScene'];
const FILES = ['script.txt', 'scenes.py', 'project.json'];
const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'video');

/** What the reading step returns: the attached files, written out. */
export const READ_SCHEMA = {
  type: 'object',
  properties: { notes: { type: 'string', description: 'Everything in the attached files, as Markdown with LaTeX' } },
  required: ['notes'],
  additionalProperties: false,
};

/** The narration alone, for a lesson whose narration is approved before its scenes are written. */
export const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title for the video, at most 60 characters' },
    script: { type: 'string', description: 'Full text of script.txt' },
  },
  required: ['title', 'script'],
  additionalProperties: false,
};

/** The scenes alone, for an approved narration. */
export const SCENES_SCHEMA = {
  type: 'object',
  properties: { scenes: { type: 'string', description: 'Full text of scenes.py' } },
  required: ['scenes'],
  additionalProperties: false,
};

const item = (props, description) => ({ type: 'object', description, properties: props, required: Object.keys(props), additionalProperties: false });

/**
 * An answer that names only what changes, for fixes, polish and revisions (see prompts/edit-format.md
 * and video/splice.py). Every field is required, so any provider's strict schema mode takes it;
 * the ones not used are empty.
 */
export const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One sentence: what you changed' },
    blocks: {
      type: 'array',
      items: item({ id: { type: 'string' }, text: { type: 'string', description: 'The whole new text of the block, marks included' }, after: { type: 'string', description: 'For a new block, the block it comes after; otherwise ""' } }, 'A narration block changed or added'),
    },
    remove_blocks: { type: 'array', items: { type: 'string' } },
    classes: {
      type: 'array',
      items: item({ name: { type: 'string' }, code: { type: 'string', description: 'The whole class, from its class line to its last line' }, after: { type: 'string', description: 'For a new class, the class it comes after; otherwise ""' } }, 'A scene class changed or added'),
    },
    remove_classes: { type: 'array', items: { type: 'string' } },
    preamble: { type: 'string', description: 'The code above the first class, only when it must change; otherwise ""' },
    whole_script: { type: 'string', description: 'The complete script.txt, only when the change runs through nearly all of it; otherwise ""' },
    whole_scenes: { type: 'string', description: 'The complete scenes.py, likewise; otherwise ""' },
  },
  required: ['summary', 'blocks', 'remove_blocks', 'classes', 'remove_classes', 'preamble', 'whole_script', 'whole_scenes'],
  additionalProperties: false,
};

const stripFence = (s) => s.replace(/^\s*```[a-z]*\n/, '').replace(/\n```\s*$/, '');

/** scenes.py with the two imports every lesson needs, whatever the writer left out. */
function withHeader(text) {
  let scenes = stripFence(String(text)).trim();
  const missing = HEADER.filter((line) => !scenes.split('\n').some((l) => l.trim() === line));
  if (missing.length) scenes = `${missing.join('\n')}\n${scenes}`;
  return `${scenes}\n`;
}

/** Tidy what Claude returned into the three things written to disk. */
export function normalizeDraft(answer) {
  return {
    title: answer.title.replace(/\s+/g, ' ').trim().slice(0, 120),
    script: `${stripFence(answer.script).trim()}\n`,
    scenes: withHeader(answer.scenes),
  };
}

/**
 * An edit as written to disk: whole files, or parts for splice.py. A lesson-shaped answer
 * ({ title, script, scenes }) counts as whole files too.
 */
export function readEdit(answer) {
  const text = (v) => (typeof v === 'string' ? v : '');
  if (typeof answer.script === 'string' && typeof answer.scenes === 'string') return { whole: { script: answer.script, scenes: answer.scenes }, summary: text(answer.summary) };
  if (text(answer.whole_script).trim() || text(answer.whole_scenes).trim()) {
    return { whole: { script: text(answer.whole_script), scenes: text(answer.whole_scenes) }, summary: text(answer.summary) };
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    summary: text(answer.summary),
    parts: {
      blocks: list(answer.blocks).filter((b) => b && typeof b.id === 'string'),
      remove_blocks: list(answer.remove_blocks).map(String),
      classes: list(answer.classes).filter((c) => c && typeof c.name === 'string'),
      remove_classes: list(answer.remove_classes).map(String),
      preamble: text(answer.preamble),
    },
  };
}

const isEmptyEdit = (e) => e.parts && !e.parts.blocks.length && !e.parts.remove_blocks.length && !e.parts.classes.length && !e.parts.remove_classes.length && !e.parts.preamble.trim();

/** Which scene class plays each block, read from scenes.py the way check.py does, but by pattern. */
export function blocksByScene(scenes) {
  const out = {};
  let current = null;
  for (const line of String(scenes || '').split('\n')) {
    const cls = /^class (\w+)\(/.exec(line);
    if (cls) current = cls[1];
    for (const m of line.matchAll(/self\.voiceover\(\s*["']([A-Za-z0-9_-]+)["']/g)) if (current) (out[current] ||= []).push(m[1]);
  }
  return out;
}

/**
 * What a revision changed outside the scope it was given: blocks other than the scene's or the
 * block's (new blocks right after the block in scope count as in it), other classes, and the code
 * every scene shares.
 */
export function outsideScope(scope, changed, before) {
  if (!scope || scope.kind === 'lesson' || !changed) return [];
  const plays = blocksByScene(before);
  const sceneOf = (b) => Object.keys(plays).find((s) => plays[s].includes(b));
  const scene = scope.kind === 'scene' ? scope.name : scope.scene || sceneOf(scope.id);
  const inBlocks = new Set(scope.kind === 'scene' ? plays[scope.name] || [] : [scope.id, ...(changed.new_blocks || [])]);
  const out = [];
  for (const b of [...(changed.blocks || []), ...(changed.removed_blocks || [])]) if (!inBlocks.has(b)) out.push(`block [${b}]`);
  if (scope.kind === 'scene') for (const b of changed.new_blocks || []) if (!inBlocks.has(b)) inBlocks.add(b); // new blocks the scene now plays
  for (const c of [...(changed.classes || []), ...(changed.new_classes || []), ...(changed.removed_classes || [])]) if (c !== scene) out.push(`scene ${c}`);
  if (changed.preamble) out.push('the code all scenes share');
  return out;
}

/** True when every warning is an animation running less than half a second long: not worth a request. */
export function onlySmallOverruns(warnings) {
  return warnings.length > 0 && warnings.every((w) => {
    const m = /ran (\d+(?:\.\d+)?)s past/.exec(w.message);
    return m && Number(m[1]) < 0.5;
  });
}

/**
 * Turns a brief (topic, goal, notes) into a video project that passes check.py, and changes a
 * finished one on request.
 *
 *   write     the writer writes the script and the scenes (or, when the narration is to be
 *             approved first, the script now and the scenes once it is)
 *   revise    the writer is given a change request and answers with only what changes
 *   check     check.py reads the files, speaks the script and runs every scene
 *   autofix   common mistakes (names from the other Manim, a mistyped mark) are fixed
 *             without asking anyone, and checked again
 *   fix       while the check still finds errors, the writer is shown them and answers with the
 *             blocks and classes it changes (a few rounds)
 *   polish    if only warnings are left, the writer gets one go at them, shown only the scenes
 *             they are in; kept only if it helped. Overruns under half a second are left alone.
 *             With visual review on, it also sees the storyboard's stills and always gets that go
 *
 * Each step is asked of the writer the plan names for it (provider, model, effort; see
 * writers/), and every request's token counts and cost are kept. With pictures or PDFs in the
 * notes and a different writer for reading them, a reading step writes them out first, so a
 * writer that cannot see still gets everything in them. After plan.handBack.after failed fixes
 * by a fixing writer other than the main one, the fixes go back to the main one. A lesson
 * stops when it reaches its spending cap.
 *
 * `ask`, `check`, `autofix` and `splice` can be replaced in tests.
 */
export function createAuthor({ getConfig, ask = askWriter, check = runCheck, autofix = runAutofix, splice = runSplice, secrets = null }) {
  // Jobs run side by side, but a check speaks with Kokoro and runs manim: one at a time.
  const checkTurn = createTurns();
  const inTurn = async (root, { config, signal, onStage, label }) => {
    if (checkTurn.busy()) onStage('Waiting for another lesson to finish its check');
    return checkTurn.take(() => {
      onStage(label);
      return check(root, { config, signal });
    }, signal);
  };

  /** What every job shares: its folder and log, its writers and budget, and the check-and-fix loop. */
  function session(job, { signal, onStage = () => {} }) {
    const config = getConfig();
    if (!PROJECT_NAME.test(job.project)) throw new AuthorError('That project name is not usable.');
    const root = path.join(config.videoDir, 'projects', job.project);
    const log = path.join(root, 'build', 'author');
    fs.mkdirSync(log, { recursive: true });
    const system = guide();
    const plan = normalizeWriter(job.writer, config);
    const capUsd = Number(job.capUsd) > 0 ? Number(job.capUsd) : null;
    const needsKeys = Object.values(plan.steps).some((w) => !['claude-code', 'ollama', 'local'].includes(w.kind));
    const keys = secrets || (needsKeys && config.dataDir ? createSecrets({ dataDir: config.dataDir, useKeychain: config.useKeychain }) : null);
    // What earlier attempts at this job spent: a retry continues, and so does its cap.
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
    // Steps are numbered on from what is already in the log, so a revision's files follow the lesson's.
    let step = fs.readdirSync(log).reduce((n, f) => Math.max(n, Number(f.slice(0, 2)) || 0), 0);
    const tagged = (name) => {
      step += 1;
      return `${String(step).padStart(2, '0')}-${name}`;
    };

    const consult = async (name, w, prompt, attachments = [], schema = LESSON_SCHEMA, nonEmpty = undefined) => {
      overCap();
      const tag = tagged(name);
      fs.writeFileSync(path.join(log, `${tag}-prompt.md`), prompt);
      const record = (usage, extra = {}) => {
        const used = { step: name, provider: w.provider, label: w.label, effort: w.effort || null, ...(usage || {}), model: usage?.model || w.model || null, costUsd: Number(usage?.costUsd) || 0, ...extra };
        requests.push(used);
        fs.writeFileSync(path.join(log, `${tag}-usage.json`), JSON.stringify(used, null, 2));
        fs.writeFileSync(spentFile, JSON.stringify({ usd: spent() }));
      };
      let out;
      try {
        out = await ask({ writer: w, secrets: keys, system, prompt, attachments, schema, nonEmpty, config, signal, effort: w.effort });
      } catch (e) {
        if (e.usage) record(e.usage, { failed: true, error: e.message.slice(0, 300) });
        throw e;
      }
      record({ ...(out.usage || {}), costUsd: out.costUsd || 0 });
      fs.writeFileSync(path.join(log, `${tag}-answer.json`), JSON.stringify(out.answer, null, 2));
      return out.answer;
    };

    const has = (f) => fs.existsSync(path.join(root, f));
    const read = (f) => (has(f) ? fs.readFileSync(path.join(root, f), 'utf8') : '');
    const current = () => ({ title: readJson(path.join(root, 'project.json'))?.title || job.topic || job.project, script: read('script.txt'), scenes: read('scenes.py') });
    const saveProject = (title, voice) => {
      const old = readJson(path.join(root, 'project.json')) || {};
      const project = { ...old, title: title ?? old.title, voice: voice || old.voice || 'af_heart', speed: old.speed ?? 1.0, script: 'script.txt', scenes_file: 'scenes.py', scenes: old.scenes || [] };
      fs.writeFileSync(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    };
    const saveDraft = (draft, voice) => {
      fs.writeFileSync(path.join(root, 'script.txt'), draft.script);
      if (draft.scenes != null) fs.writeFileSync(path.join(root, 'scenes.py'), draft.scenes);
      saveProject(draft.title, voice);
    };

    /** Write an edit answer to disk. Returns { ok, errors, changed, summary }. */
    const applyEdit = async (answer) => {
      const edit = readEdit(answer);
      if (edit.whole) {
        if (edit.whole.script.trim()) fs.writeFileSync(path.join(root, 'script.txt'), `${stripFence(edit.whole.script).trim()}\n`);
        if (edit.whole.scenes.trim()) fs.writeFileSync(path.join(root, 'scenes.py'), withHeader(edit.whole.scenes));
        if (!has('project.json')) saveProject(answer.title);
        return { ok: true, errors: [], changed: { whole: true }, summary: edit.summary };
      }
      if (isEmptyEdit(edit)) return { ok: true, errors: [], changed: {}, summary: edit.summary, empty: true };
      const tag = tagged('splice');
      fs.writeFileSync(path.join(log, `${tag}.json`), JSON.stringify(edit.parts, null, 2));
      const result = await splice(root, edit.parts, { config, signal });
      return { ...result, summary: edit.summary };
    };

    const inspect = async (label) => {
      const report = await inTurn(root, { config, signal, onStage, label });
      fs.writeFileSync(path.join(log, `${tagged('check')}.json`), JSON.stringify(report, null, 2));
      return report;
    };

    const autofixed = [];
    const tryAutofix = async (report) => {
      let result;
      try {
        result = await autofix(root, report, { config, signal });
      } catch (e) {
        if (e.code === 'aborted') throw e;
        return false; // the fixer is a shortcut; without it the writer fixes everything as before
      }
      if (!result?.changed) return false;
      fs.writeFileSync(path.join(log, `${tagged('autofix')}.json`), JSON.stringify(result, null, 2));
      autofixed.push(...result.fixes);
      return true;
    };

    /**
     * The check, then automatic fixes, fix rounds and the polish, until the project passes.
     * Returns { report, fixes, polished }.
     */
    const improve = async (brief, { label = 'Checking the scenes' } = {}) => {
      let report = await inspect(label);
      let fixes = 0;
      // Hand-back: a fixing writer other than the main one gets plan.handBack.after tries, then
      // the main writer takes over with rounds of its own.
      const main = plan.steps.write;
      const canHandBack = plan.handBack.after > 0 && !sameModel(plan.steps.fix, main);
      let handedBack = false;
      let failedFixes = 0;
      let allowed = config.authorMaxFixes;
      let unusable = null; // why the last answer could not be applied, told to the next round
      const fixer = () => (handedBack ? { ...main, effort: plan.steps.fix.effort } : plan.steps.fix);
      while (!report.ok) {
        if (!unusable && (await tryAutofix(report))) {
          report = await inspect('Checking the automatic fixes');
          if (report.ok) break;
        }
        if (canHandBack && !handedBack && failedFixes >= plan.handBack.after) {
          handedBack = true;
          allowed = fixes + config.authorMaxFixes;
          onStage(`Handing the fixes back to ${who(main)}`);
        }
        if (fixes >= allowed) {
          const first = unusable ? { where: 'The last fix', message: unusable } : report.errors[0];
          throw new AuthorError(
            `The scenes still fail after ${fixes} fix${fixes === 1 ? '' : 'es'}. ${first.where}: ${first.message.trim().split('\n').pop()}`,
          );
        }
        fixes += 1;
        const w = fixer();
        onStage(`Fixing the scenes (${fixes} of ${allowed})${sameModel(w, main) ? '' : ` with ${who(w)}`}`);
        const errors = unusable ? [{ where: 'your last answer', message: `It could not be applied: ${unusable}` }, ...report.errors] : report.errors;
        let applied;
        try {
          applied = await applyEdit(await consult('fix', w, repairPrompt({ ...brief, ...current(), errors, warnings: report.warnings }), [], EDIT_SCHEMA, []));
        } catch (e) {
          // A cheaper writer that cannot even answer counts as a failed fix, while there is someone to hand back to.
          if (e.code === 'aborted' || e.code === 'cap' || !canHandBack || handedBack) throw e;
          failedFixes += 1;
          continue;
        }
        if (!applied.ok || applied.empty) {
          unusable = applied.ok ? 'It changed nothing.' : applied.errors.join(' ');
          if (!handedBack) failedFixes += 1;
          continue;
        }
        unusable = null;
        report = await inspect('Checking the scenes');
        if (!report.ok && !handedBack) failedFixes += 1;
      }

      let polished = false;
      const visual = brief.visualReview ?? config.authorVisualReview;
      const polisher = handedBack ? { ...main, effort: plan.steps.polish.effort } : plan.steps.polish;
      // Stills go only to a polisher that can see; one that cannot gets the warnings alone.
      const stills = visual && polisher.caps?.images ? reviewStills(root) : [];
      const atCap = capUsd && spent() >= capUsd; // it passes; polishing is not worth going over
      const worth = config.authorPolish && report.warnings.length && !onlySmallOverruns(report.warnings);
      if (!atCap && (worth || stills.length)) {
        const before = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(root, f))]));
        onStage(stills.length ? 'Looking over the frames' : 'Polishing timing and layout');
        // Only the scenes the warnings are in, unless the frames are being looked over.
        const named = [...new Set(report.warnings.map((x) => x.scene || x.where).filter((s) => /^[A-Z]\w*$/.test(String(s))))];
        const files = current();
        const only = !stills.length && named.length ? named : null;
        const shown = only ? sceneParts(files.scenes, only) : files.scenes;
        try {
          await applyEdit(await consult('polish', polisher, repairPrompt({ ...brief, ...files, scenes: shown, only, errors: [], warnings: report.warnings, pictures: stills.length }), stills, EDIT_SCHEMA, []));
        } catch (e) {
          // It already passes: a polish that cannot be had leaves it as it is.
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
      return { report, fixes, polished };
    };

    /** Totals, the record in author.json, and the budget cleared for the next job. */
    const finish = (extra) => {
      const usage = totalUsage(requests);
      if (spentBefore) usage.earlierAttemptsUsd = Math.round(spentBefore * 1000) / 1000;
      usage.costUsd = Math.round(spent() * 1000) / 1000;
      const result = { project: job.project, title: current().title, script: current().script, autofixed, costUsd: usage.costUsd, usage, writtenBy: writtenBy(requests), ...extra };
      fs.writeFileSync(path.join(root, 'author.json'), `${JSON.stringify({ ...result, script: undefined, finishedAt: new Date().toISOString() }, null, 2)}\n`);
      fs.rmSync(spentFile, { force: true });
      return result;
    };

    return { config, root, log, plan, consult, current, has, saveDraft, applyEdit, improve, finish, onStage };
  }

  async function write(job, { signal, onStage = () => {} } = {}) {
    const s = session(job, { signal, onStage });
    const { root, plan } = s;
    // A retry sends only the project name: the brief is the one saved the first time.
    const briefFile = path.join(root, 'brief.json');
    const brief = job.topic ? pickBrief(job) : readJson(briefFile);
    if (!brief?.topic) throw new AuthorError('There is no brief for this project, so there is nothing to write from.');
    fs.writeFileSync(briefFile, `${JSON.stringify(brief, null, 2)}\n`);
    fs.rmSync(path.join(root, 'author.json'), { force: true });
    const phase = ['script', 'scenes'].includes(job.phase) ? job.phase : 'all';
    const writer = plan.steps.write;

    if (phase === 'scenes') {
      // The narration was approved: write the scenes for it, then check as usual.
      if (!s.has('script.txt')) throw new AuthorError('There is no narration to write scenes for.');
      if (!s.has('scenes.py')) {
        onStage('Writing the scenes for your narration');
        const answer = await s.consult('write', writer, scenesPrompt({ ...brief, script: s.current().script }), [], SCENES_SCHEMA);
        s.saveDraft({ ...s.current(), scenes: withHeader(answer.scenes) }, brief.voice);
      }
    } else if (!FILES.every((f) => s.has(f)) && !(phase === 'script' && s.has('script.txt'))) {
      // A project that already has its files (a retry after a failure) goes straight to the check.
      // Pictures and PDFs go with the first request only. A fix is about code that failed,
      // and by then what they said is in the script.
      const attachments = (brief.attachments || []).map((a) => {
        const file = path.join(root, 'notes', path.basename(a.file));
        if (!fs.existsSync(file)) throw new AuthorError(`The attached file ${a.name} is missing from the project's notes folder.`);
        return { ...a, path: file };
      });
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
            transcript = String((await s.consult('read', reader, readPrompt({ topic: brief.topic, attachments: files }), files, READ_SCHEMA)).notes).trim();
            fs.writeFileSync(cache, `${transcript}\n`);
          }
          notes = [notes, `# From the attached files (${files.map((f) => f.name).join(', ')}), as read by ${who(reader)}\n\n${transcript}`].filter(Boolean).join('\n\n');
        }
      }
      if (phase === 'script') {
        onStage(send.length ? 'Reading the notes and writing the narration' : 'Writing the narration');
        const answer = await s.consult('write', writer, lessonPrompt({ ...brief, notes, attachments: send, phase }), send, SCRIPT_SCHEMA);
        s.saveDraft({ title: answer.title.replace(/\s+/g, ' ').trim().slice(0, 120), script: `${stripFence(answer.script).trim()}\n`, scenes: null }, brief.voice);
      } else {
        onStage(send.length ? 'Reading the notes and writing the lesson' : 'Writing the lesson');
        s.saveDraft(normalizeDraft(await s.consult('write', writer, lessonPrompt({ ...brief, notes, attachments: send }), send)), brief.voice);
      }
    }
    if (phase === 'script') {
      // Waits for the person: no check yet, since there are no scenes to run.
      return s.finish({ phase, scenes: [], warnings: [], fixes: 0, polished: false, narrationSec: null });
    }

    const { report, fixes, polished } = await s.improve(brief);
    return s.finish({ phase, scenes: report.scenes, narrationSec: report.duration ?? null, warnings: report.warnings, fixes, polished });
  }

  /**
   * A change to a lesson that was written: the request, its scope ({ kind: 'lesson' }, { kind:
   * 'scene', name } or { kind: 'block', id, scene, at }), the last few requests with their
   * summaries, and any new notes. The writer answers with what changes; splice.py applies it, and
   * then the check, fixes and polish run as for a new lesson.
   */
  async function revise(job, { signal, onStage = () => {} } = {}) {
    const s = session(job, { signal, onStage });
    const { root, plan } = s;
    if (!FILES.every((f) => s.has(f))) throw new AuthorError('This lesson has no script and scenes to change yet.');
    const request = String(job.request || '').trim();
    if (!request) throw new AuthorError('Say what to change.');
    const brief = readJson(path.join(root, 'brief.json')) || { topic: s.current().title, goal: '' };
    const writer = plan.steps.write;
    const before = s.current();
    const scope = job.scope?.kind === 'scene' ? { ...job.scope, blocks: blocksByScene(before.scenes)[job.scope.name] || [] } : job.scope || { kind: 'lesson' };

    // The new notes, and pictures of what is on screen in the scope, for a writer that can see.
    const notes = (Array.isArray(job.attachments) ? job.attachments : [])
      .filter((a) => a && ['image', 'pdf'].includes(a.kind) && typeof a.file === 'string')
      .map((a) => ({ name: String(a.name || path.basename(a.file)), kind: a.kind, type: a.type || null, path: path.join(root, 'notes', path.basename(a.file)) }))
      .filter((a) => fs.existsSync(a.path));
    const { files, text } = await usableBy(writer, notes);
    const inScope = scope.kind === 'scene' ? scope.blocks : scope.kind === 'block' ? [scope.id] : null;
    const stills = writer.caps?.images ? reviewStills(root, inScope).slice(0, 8) : [];
    const history = (Array.isArray(job.history) ? job.history : []).slice(-3).map((h) => ({ request: String(h.request || ''), summary: String(h.summary || '') }));

    onStage(`Revising: ${request.length > 60 ? `${request.slice(0, 57)}…` : request}`);
    const prompt = revisePrompt({ ...brief, ...before, request: text ? `${request}\n\n${text}` : request, scope, history, pictures: stills.length, attachments: files });
    let applied = await s.applyEdit(await s.consult('revise', writer, prompt, [...files, ...stills], EDIT_SCHEMA, ['summary']));
    if (!applied.ok) {
      // One more try, told why the answer could not be applied.
      onStage('Revising again: the first answer could not be applied');
      applied = await s.applyEdit(await s.consult('revise', writer, `${prompt}\n\nYour previous answer could not be applied: ${applied.errors.join(' ')} Answer again.`, [...files, ...stills], EDIT_SCHEMA, ['summary']));
      if (!applied.ok) throw new AuthorError(`The revision could not be applied: ${applied.errors.join(' ')}`);
    }
    if (applied.empty) throw new AuthorError(`The writer changed nothing${applied.summary ? `: ${applied.summary}` : '.'}`);
    const changed = applied.changed;
    const outside = changed.whole ? [] : outsideScope(scope, changed, before.scenes);

    const { report, fixes, polished } = await s.improve(brief, { label: 'Checking the revision' });
    return s.finish({
      kind: 'revise',
      request,
      summary: applied.summary || '',
      scope: job.scope || { kind: 'lesson' },
      changed,
      outsideScope: outside,
      scenes: report.scenes,
      narrationSec: report.duration ?? null,
      warnings: report.warnings,
      fixes,
      polished,
    });
  }

  /**
   * Check a project's files as they are, for the storyboard after an edit: no writer, no fixes.
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

  return { write, revise, check: checkOnly };
}

/** The code above the first class and the named classes, as a polish round is shown them. */
export function sceneParts(scenes, names) {
  const lines = String(scenes).split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    const m = /^class (\w+)\b/.exec(line);
    if (m) starts.push([i, m[1]]);
  });
  if (!starts.length) return scenes;
  const parts = [lines.slice(0, starts[0][0]).join('\n').trimEnd()];
  starts.forEach(([at, name], i) => {
    if (names.includes(name)) parts.push(lines.slice(at, i + 1 < starts.length ? starts[i + 1][0] : lines.length).join('\n').trimEnd());
  });
  return `${parts.join('\n\n\n')}\n`;
}

/** Apply an edit's parts with video/splice.py: { ok, errors, changed }. */
export async function runSplice(root, parts, { config, signal }) {
  const own = path.join(config.videoDir, 'splice.py');
  const [cmd, ...pre] = config.authorSplice || ['python3', fs.existsSync(own) ? own : path.join(VIDEO, 'splice.py')];
  const { stdout, stderr, code } = await run(cmd, [...pre, root, '--edit', '-'], {
    input: JSON.stringify(parts),
    signal,
    timeoutMs: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  try {
    const out = JSON.parse(stdout);
    return { ok: !!out.ok, errors: Array.isArray(out.errors) ? out.errors.map(String) : [], changed: out.changed || {} };
  } catch {
    throw new AuthorError(`splice.py could not run${code ? ` (exit ${code})` : ''}. ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim());
  }
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
export function reviewStills(root, blocks = null) {
  let board;
  try {
    board = JSON.parse(fs.readFileSync(path.join(root, 'build', 'check', 'storyboard.json'), 'utf8'));
  } catch {
    return [];
  }
  const all = [];
  for (const scene of board.scenes || []) {
    for (const block of scene.blocks || []) {
      if (blocks && !blocks.includes(block.id)) continue;
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
