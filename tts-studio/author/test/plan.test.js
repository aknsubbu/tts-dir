import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthor } from '../pipeline.js';
import { squarePng, textPdf } from '../writers/probe.js';
import { KIND_CAPS } from '../../shared/providers.js';
import { answer, sandbox } from './fakes.js';

/**
 * The writer plan: each step asked of its own provider. A fake `ask` stands in for every
 * provider and answers from a script per step; the fake check still judges every draft.
 */
let dir, box;
const BRIEF = { topic: 'Slope of a line', goal: 'What the number means', notes: 'rise over run', minutes: 1, voice: 'af_heart' };

const w = (provider, kind, model, extra = {}) => ({ provider, kind, label: { 'claude-code': 'Claude Code', ollama: 'This Mac: Ollama', groq: 'Groq' }[kind] || kind, baseUrl: null, model, effort: '', caps: { ...KIND_CAPS[kind] }, rate: null, ...extra });
const CLAUDE = w('claude-code', 'claude-code', '', { effort: 'high' });
const LOCAL = w('ollama', 'ollama', 'qwen3-coder', { effort: 'low', rate: { input: 0, output: 0 } });
const plan = (steps, handBack = 0) => ({ steps: { read: CLAUDE, write: CLAUDE, fix: CLAUDE, polish: CLAUDE, outline: CLAUDE, ...steps }, handBack: { after: handBack } });

/** A fake provider: answers per step from `script`, records who was asked what. */
function fakeAsk(script) {
  const calls = [];
  const ask = async ({ writer, prompt, attachments, schema, effort }) => {
    const step = schema.required.includes('notes') ? 'read' : /does not build yet|builds, but/.test(prompt) ? 'fix' : 'write';
    calls.push({ step, provider: writer.provider, model: writer.model, effort, prompt, attachments: attachments.map((a) => a.name) });
    const next = script[step]?.shift();
    if (next instanceof Error) throw next;
    const cost = writer.rate ? 0 : 0.5;
    return { answer: next, costUsd: cost, usage: { model: writer.model || 'claude-opus-5-5', inputTokens: 100, outputTokens: 100, costUsd: cost, provider: writer.provider } };
  };
  return { ask, calls };
}

const author = (ask) => createAuthor({ getConfig: box.getConfig, ask });
const project = (name, files = []) => {
  const notes = path.join(box.project(name), 'notes');
  fs.mkdirSync(notes, { recursive: true });
  for (const [file, body] of files) fs.writeFileSync(path.join(notes, file), body);
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-plan-'));
  box = sandbox(dir);
  box.answers([]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('each step goes to the writer the plan names, with its effort', async () => {
  const { ask, calls } = fakeAsk({ write: [answer('# BROKEN')], fix: [answer()] });
  const result = await author(ask).write({ project: 'p-steps', ...BRIEF, writer: plan({ fix: LOCAL }) });
  assert.deepEqual(calls.map((c) => [c.step, c.provider, c.effort]), [['write', 'claude-code', 'high'], ['fix', 'ollama', 'low']]);
  assert.deepEqual(result.writtenBy.map((x) => [x.step, x.provider, x.model]), [['write', 'claude-code', 'claude-opus-5-5'], ['fix', 'ollama', 'qwen3-coder']]);
  assert.equal(result.usage.requests[1].provider, 'ollama');
  assert.equal(result.costUsd, 0.5, 'the local fix was free');
});

test('a fixing writer that keeps failing hands back to the main writer', async () => {
  const stages = [];
  const { ask, calls } = fakeAsk({ write: [answer('# BROKEN')], fix: [answer('# BROKEN'), new Error('not JSON'), answer()] });
  const result = await author(ask).write({ project: 'p-handback', ...BRIEF, writer: plan({ fix: LOCAL }, 2) }, { onStage: (s) => stages.push(s) });
  assert.deepEqual(calls.map((c) => `${c.step}:${c.provider}`), ['write:claude-code', 'fix:ollama', 'fix:ollama', 'fix:claude-code']);
  assert.equal(calls[3].effort, 'low', "the main writer fixes at the fix step's effort");
  assert.ok(stages.includes('Handing the fixes back to Claude Code'));
  assert.ok(stages.includes('Fixing the scenes (1 of 2) with This Mac: Ollama · qwen3-coder'));
  assert.equal(result.fixes, 3);
});

test('without a hand-back, a failing fixer fails the lesson as before', async () => {
  const { ask } = fakeAsk({ write: [answer('# BROKEN')], fix: [new Error('Groq is rate-limiting this key')] });
  await assert.rejects(author(ask).write({ project: 'p-nohand', ...BRIEF, writer: plan({ fix: w('groq', 'groq', 'llama') }) }), /rate-limiting/);
});

test('pictures go to a reader that can see, and its transcript to a writer that cannot', async () => {
  project('p-read', [['board.view.jpg', squarePng()]]);
  const brief = { ...BRIEF, attachments: [{ name: 'board.jpg', file: 'notes/board.view.jpg', kind: 'image', type: 'image/jpeg' }] };
  const { ask, calls } = fakeAsk({ read: [{ notes: 'TRANSCRIBED: $m = \\frac{\\Delta y}{\\Delta x}$' }], write: [answer()] });
  await author(ask).write({ project: 'p-read', ...brief, writer: plan({ write: LOCAL, fix: LOCAL, polish: LOCAL }) });
  assert.deepEqual(calls.map((c) => `${c.step}:${c.provider}`), ['read:claude-code', 'write:ollama']);
  assert.deepEqual(calls[0].attachments, ['board.jpg']);
  assert.deepEqual(calls[1].attachments, [], 'the writer gets text only');
  assert.match(calls[1].prompt, /as read by Claude Code\n\nTRANSCRIBED/);
  assert.equal(fs.readFileSync(path.join(box.project('p-read'), 'notes', 'transcribed.md'), 'utf8').trim(), 'TRANSCRIBED: $m = \\frac{\\Delta y}{\\Delta x}$');
});

test('a writer that cannot see is refused pictures, with what to change', async () => {
  project('p-blind', [['board.view.jpg', squarePng()]]);
  const brief = { ...BRIEF, attachments: [{ name: 'board.jpg', file: 'notes/board.view.jpg', kind: 'image' }] };
  const { ask } = fakeAsk({ write: [answer()] });
  await assert.rejects(
    author(ask).write({ project: 'p-blind', ...brief, writer: plan({ read: LOCAL, write: LOCAL }) }),
    /cannot see pictures\. In Settings → Lesson writer, choose a model that can for “Reading your notes”/,
  );
});

test('a PDF goes as its text to a writer that cannot read PDFs', { skip: !fs.existsSync('/usr/bin/pdftotext') && process.platform !== 'darwin' }, async () => {
  project('p-pdf', [['paper.pdf', textPdf('GRADIENT DESCENT')]]);
  const brief = { ...BRIEF, attachments: [{ name: 'paper.pdf', file: 'notes/paper.pdf', kind: 'pdf' }] };
  const { ask, calls } = fakeAsk({ write: [answer()] });
  await author(ask).write({ project: 'p-pdf', ...brief, writer: plan({ read: LOCAL, write: LOCAL }) });
  assert.deepEqual(calls[0].attachments, []);
  assert.match(calls[0].prompt, /# From paper\.pdf \(its text only\)\n\nGRADIENT DESCENT/);
});

test('a lesson stops at its spending cap, and a retry continues with what was spent', async () => {
  const { ask } = fakeAsk({ write: [answer('# BROKEN')], fix: [answer('# BROKEN'), answer()] });
  const job = { project: 'p-cap', ...BRIEF, writer: plan({}), capUsd: 0.9 };
  await assert.rejects(author(ask).write(job), (e) => e.code === 'cap' && /spending cap of \$0\.90 \(\$1\.00 so far\)/.test(e.message));
  // Raised to $2: the retry continues from the files on disk and counts the dollar already spent.
  const retry = await author(ask).write({ project: 'p-cap', writer: plan({}), capUsd: 2 });
  assert.equal(retry.costUsd, 1.5);
  assert.equal(retry.usage.earlierAttemptsUsd, 1);
  assert.ok(!fs.existsSync(path.join(box.project('p-cap'), 'build', 'author', 'spent.json')));
});
