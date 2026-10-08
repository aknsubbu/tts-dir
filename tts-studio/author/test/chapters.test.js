import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { colorsLine, createAuthor, normalizeOutline } from '../pipeline.js';
import { sandbox, scenes, SCRIPT } from './fakes.js';

/** Long lessons: an outline, then each chapter written, checked and fixed in its own project. */
let dir, box;
const OUTLINE = {
  title: 'Backpropagation',
  through_line: 'Why the backward pass is cheap',
  notation: [{ tex: 'w', meaning: 'weights', color: 'BLUE' }, { tex: '\\hat{y}', meaning: 'prediction', color: 'not a colour' }],
  chapters: [
    { id: 'one-neuron', title: 'One neuron', minutes: 4, goal: 'z = wx + b', covers: ['set up'], from_notes: 'z = wx + b with w = 0.5', files: ['page.view.jpg'], starts_from: 'nothing', ends_with: 'how should w change?' },
    { id: 'chain', title: 'The chain rule', minutes: 6, goal: 'multiply along the path', covers: ['path'], from_notes: '', files: [], starts_from: 'how should w change?', ends_with: 'done' },
  ],
};
const chapterAnswer = (title, body = '') => ({ title, script: SCRIPT, scenes: scenes(body).replace('from voiceover import VoiceoverScene', `from voiceover import VoiceoverScene\n${colorsLine(normalizeOutline(OUTLINE).notation)}`) });

function fakeAsk(script) {
  const calls = [];
  const ask = async ({ prompt, schema, attachments }) => {
    const step = schema.required.includes('chapters') ? 'outline' : /does not build yet/.test(prompt) ? 'fix' : /builds, but/.test(prompt) ? 'polish' : 'chapter';
    calls.push({ step, prompt, attachments: attachments.map((a) => a.name) });
    const next = script[step]?.shift();
    if (!next) throw new Error(`no answer left for ${step}`);
    return { answer: next, costUsd: 0.2, usage: { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.2 } };
  };
  return { ask, calls };
}
const BRIEF = { topic: 'Backprop', goal: 'Why it is cheap', notes: 'my notes', minutes: 10, voice: 'af_heart' };

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-chapters-'));
  box = sandbox(dir);
  box.answers([]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the outline comes first, and the lesson can stop there for review', async () => {
  const { ask, calls } = fakeAsk({ outline: [OUTLINE] });
  const result = await createAuthor({ getConfig: box.getConfig, ask }).write({ project: 'c-outline', ...BRIEF, phase: 'outline' });
  assert.equal(result.phase, 'outline');
  const saved = JSON.parse(box.read('c-outline', 'outline.json'));
  assert.deepEqual(saved.chapters.map((c) => c.id), ['01-one-neuron', '02-chain']);
  assert.equal(saved.notation[1].color, 'GREEN', 'an unknown colour gets one from the palette');
  const project = JSON.parse(box.read('c-outline', 'project.json'));
  assert.deepEqual(project.chapters, ['01-one-neuron', '02-chain']);
  assert.equal(project.title_cards, true);
  assert.match(calls[0].prompt, /about 10 minutes of video in total, in 2 to 4 chapters/);
});

test('each chapter is written from the outline, the notation and the end of the one before', async () => {
  const root = box.project('c-write');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'page.view.jpg'), 'JPG');
  const brief = { ...BRIEF, attachments: [{ name: 'page.jpg', file: 'notes/page.view.jpg', kind: 'image', type: 'image/jpeg' }] };
  const { ask, calls } = fakeAsk({ outline: [OUTLINE], chapter: [chapterAnswer('One neuron'), chapterAnswer('The chain rule')] });
  const stages = [];
  const result = await createAuthor({ getConfig: box.getConfig, ask }).write({ project: 'c-write', ...brief }, { onStage: (st) => stages.push(st) });
  assert.equal(result.phase, 'chapters');
  assert.deepEqual(result.chapters.map((c) => c.id), ['01-one-neuron', '02-chain']);
  const [, first, second] = calls;
  assert.match(first.prompt, /Write chapter 1 of 2/);
  assert.match(first.prompt, /COLORS = \{R"w": BLUE, R"\\hat\{y\}": GREEN\}/);
  assert.match(first.prompt, /z = wx \+ b with w = 0.5/);
  assert.deepEqual(first.attachments, ['page.jpg'], 'only the files the outline gave this chapter');
  assert.match(second.prompt, /The chapter before, "One neuron", ends like this/);
  assert.deepEqual(second.attachments, []);
  assert.ok(box.exists('c-write', 'chapters/01-one-neuron/author.json'));
  assert.ok(box.checked().some((c) => c.root.endsWith(path.join('chapters', '02-chain'))), 'each chapter is checked in its own folder');
  assert.ok(stages.includes('Writing chapter 2 of 2: The chain rule'));
  assert.equal(result.chapters[0].notation, null, 'chapter 1 kept the COLORS line');
});

test('a chapter that fails stops only itself, and a retry continues there', async () => {
  const broken = chapterAnswer('The chain rule', '# BROKEN');
  const { ask } = fakeAsk({ outline: [OUTLINE], chapter: [chapterAnswer('One neuron'), broken], fix: [broken, broken] });
  await assert.rejects(createAuthor({ getConfig: box.getConfig, ask }).write({ project: 'c-retry', ...BRIEF }), /still fail after 2 fixes/);
  assert.ok(box.exists('c-retry', 'chapters/01-one-neuron/author.json'));
  assert.ok(!box.exists('c-retry', 'chapters/02-chain/author.json'));
  const again = fakeAsk({ fix: [chapterAnswer('The chain rule')] });
  const result = await createAuthor({ getConfig: box.getConfig, ask: again.ask }).write({ project: 'c-retry' });
  assert.equal(result.phase, 'chapters');
  assert.deepEqual(again.calls.map((c) => c.step), ['fix'], 'chapter 1 is not written again, nor the outline');
});

test('an outline the person edited keeps its chapter ids', () => {
  const edited = normalizeOutline({ ...OUTLINE, chapters: [{ ...OUTLINE.chapters[1], id: '02-chain' }, { ...OUTLINE.chapters[0], id: '01-one-neuron', minutes: 40 }] });
  assert.deepEqual(edited.chapters.map((c) => [c.id, c.minutes]), [['02-chain', 6], ['01-one-neuron', 8]]);
  assert.throws(() => normalizeOutline({ title: 'x', notation: [], chapters: [] }), /no chapters/);
  assert.equal(normalizeOutline({ ...OUTLINE, chapters: Array.from({ length: 12 }, (_, i) => ({ title: `C${i}` })) }).chapters.length, 8);
});
