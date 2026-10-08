import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocksByScene, createAuthor, onlySmallOverruns, outsideScope, readEdit, sceneParts } from '../pipeline.js';
import { sandbox } from './fakes.js';

/**
 * Revisions, and fixes and polish in the same format: the writer answers with what changes and
 * video/splice.py applies it. A fake `ask` answers per step; the fake check judges the result.
 */
let dir, box;

const SCRIPT = '[intro]\nEvery line has a <mark name="slope"/>slope.\n\n[outro]\nThat is all.\n';
const cls = (name, block, body = 'self.wait(vo.remaining())') => `class ${name}(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("${block}") as vo:
            ${body}`;
const SCENES = `from manimlib import *
from voiceover import VoiceoverScene


${cls('Intro', 'intro')}


${cls('Outro', 'outro')}
`;
const EMPTY = { summary: '', blocks: [], remove_blocks: [], classes: [], remove_classes: [], preamble: '', whole_script: '', whole_scenes: '' };
const edit = (parts) => ({ ...EMPTY, ...parts });

/** A project already written: script, scenes, project.json and brief. */
function written(name, { scenes = SCENES } = {}) {
  const root = box.project(name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), SCRIPT);
  fs.writeFileSync(path.join(root, 'scenes.py'), scenes);
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ title: 'Slope', voice: 'af_heart', speed: 1, script: 'script.txt', scenes_file: 'scenes.py', scenes: ['Intro', 'Outro'] }));
  fs.writeFileSync(path.join(root, 'brief.json'), JSON.stringify({ topic: 'Slope', goal: 'What it means', notes: '', minutes: 1, voice: 'af_heart' }));
  return root;
}

/** Answers from a list per step ('revise', 'fix', 'polish', 'write'), and every request kept. */
function fakeAsk(script) {
  const calls = [];
  const ask = async ({ writer, prompt, attachments, schema, nonEmpty }) => {
    const step = /change_request/.test(prompt) ? 'revise' : /does not build yet/.test(prompt) ? 'fix' : /builds, but/.test(prompt) ? 'polish' : schema.required.includes('scenes') && schema.required.length === 1 ? 'scenes' : schema.required.length === 2 ? 'script' : 'write';
    calls.push({ step, prompt, attachments: attachments.map((a) => a.name), schema: schema.required, nonEmpty, provider: writer.provider });
    const next = script[step]?.shift();
    if (!next) throw new Error(`no answer left for ${step}`);
    return { answer: next, costUsd: 0.1, usage: { model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 10, costUsd: 0.1 } };
  };
  return { ask, calls };
}
const author = (ask) => createAuthor({ getConfig: box.getConfig, ask });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-revise-'));
  box = sandbox(dir);
  box.answers([]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a scoped revision changes only what it names, and the rest stays byte for byte', async () => {
  const root = written('r-scoped');
  const chain = cls('Intro', 'intro', 'self.play(FadeIn(Tex("m")), run_time=vo.until("slope"))\n            self.wait(vo.remaining())');
  const { ask, calls } = fakeAsk({ revise: [edit({ summary: 'Slower intro', blocks: [{ id: 'intro', text: 'Every straight line has a <mark name="slope"/>slope.', after: '' }], classes: [{ name: 'Intro', code: chain, after: '' }] })] });
  const result = await author(ask).revise({ project: 'r-scoped', request: 'Slow down the intro', scope: { kind: 'scene', name: 'Intro' } });
  assert.equal(result.summary, 'Slower intro');
  assert.deepEqual(result.changed.blocks, ['intro']);
  assert.deepEqual(result.changed.classes, ['Intro']);
  assert.deepEqual(result.outsideScope, []);
  assert.match(fs.readFileSync(path.join(root, 'script.txt'), 'utf8'), /\[outro\]\nThat is all\./);
  assert.ok(fs.readFileSync(path.join(root, 'scenes.py'), 'utf8').includes(cls('Outro', 'outro')), 'the other scene is untouched');
  const [asked] = calls;
  assert.match(asked.prompt, /<change_request>\nSlow down the intro\n<\/change_request>/);
  assert.match(asked.prompt, /about the scene Intro \(it plays \[intro\]\)/);
  assert.deepEqual(asked.nonEmpty, ['summary']);
  assert.ok(box.checked().length >= 1, 'the revision is checked');
});

test('changes outside the scope are kept and listed', async () => {
  written('r-outside');
  const { ask } = fakeAsk({ revise: [edit({ summary: 'Also tidied the ending', blocks: [{ id: 'outro', text: 'And that is the slope.', after: '' }] })] });
  const result = await author(ask).revise({ project: 'r-outside', request: 'Change the intro', scope: { kind: 'scene', name: 'Intro' } });
  assert.deepEqual(result.outsideScope, ['block [outro]']);
  assert.match(fs.readFileSync(path.join(box.project('r-outside'), 'script.txt'), 'utf8'), /And that is the slope\./);
});

test('an answer that cannot be applied goes back once with the reason', async () => {
  written('r-retry');
  const { ask, calls } = fakeAsk({
    revise: [
      edit({ summary: 'Added a block', blocks: [{ id: 'middle', text: 'In between.', after: '' }] }),
      edit({ summary: 'Added a block', blocks: [{ id: 'middle', text: 'In between.', after: 'intro' }], classes: [{ name: 'Middle', code: cls('Middle', 'middle'), after: 'Intro' }] }),
    ],
  });
  const result = await author(ask).revise({ project: 'r-retry', request: 'Add a pause', scope: { kind: 'block', id: 'intro' } });
  assert.match(calls[1].prompt, /could not be applied: block \[middle\] is not in the script. To add it, give "after"/);
  assert.deepEqual(result.changed.new_blocks, ['middle']);
  assert.deepEqual(result.changed.new_classes, ['Middle']);
  assert.deepEqual(result.outsideScope, ['scene Middle'], 'a new block after the one in scope is in it; a new scene is not');
});

test('fix rounds answer in the same format', async () => {
  written('r-fix');
  const broken = cls('Outro', 'outro', 'self.wait(vo.remaining())  # BROKEN');
  const { ask, calls } = fakeAsk({
    revise: [edit({ summary: 'Changed the outro', classes: [{ name: 'Outro', code: broken, after: '' }] })],
    fix: [edit({ classes: [{ name: 'Outro', code: cls('Outro', 'outro'), after: '' }] })],
  });
  const result = await author(ask).revise({ project: 'r-fix', request: 'Change the ending' });
  assert.equal(result.fixes, 1);
  assert.deepEqual(calls[1].schema.slice(0, 2), ['summary', 'blocks']);
  assert.deepEqual(calls[1].nonEmpty, [], 'a fix need not summarise');
  assert.match(calls[1].prompt, /Answer with only what changes/);
  assert.ok(!fs.readFileSync(path.join(box.project('r-fix'), 'scenes.py'), 'utf8').includes('BROKEN'));
});

test('the polish sees only the scenes its warnings are in, and small overruns are left alone', async () => {
  written('r-polish', { scenes: SCENES.replace('class Outro', '# CROWDED\nclass Outro') });
  const { ask, calls } = fakeAsk({ revise: [edit({ summary: 'x', blocks: [{ id: 'intro', text: 'Each line has a <mark name="slope"/>slope.', after: '' }] })], polish: [edit({})] });
  await author(ask).revise({ project: 'r-polish', request: 'Reword the intro' });
  const polish = calls.find((c) => c.step === 'polish');
  assert.ok(polish, 'a polish round ran');
  assert.match(polish.prompt, /The parts of `scenes.py` this is about: the code above the first class, and Intro/);
  assert.ok(!polish.prompt.includes('class Outro'), 'only the scene the warning names');
  assert.equal(onlySmallOverruns([{ message: 'the animations before it ran 0.42s past "slope"' }]), true);
  assert.equal(onlySmallOverruns([{ message: 'the animations before it ran 0.80s past "slope"' }]), false);
  assert.equal(onlySmallOverruns([{ message: 'text "A" and text "B" overlap' }]), false);
});

test('the narration can be written first, and the scenes once it is approved', async () => {
  const { ask, calls } = fakeAsk({
    script: [{ title: 'Slope, first', script: SCRIPT }],
    scenes: [{ scenes: SCENES.replace('from manimlib import *\n', '') }],
  });
  const a = author(ask);
  const first = await a.write({ project: 'r-phases', topic: 'Slope', minutes: 1, voice: 'af_heart', phase: 'script' });
  assert.equal(first.phase, 'script');
  assert.ok(box.exists('r-phases', 'script.txt'));
  assert.ok(!box.exists('r-phases', 'scenes.py'), 'no scenes until the narration is approved');
  assert.match(calls[0].prompt, /write only the narration/);
  const second = await a.write({ project: 'r-phases', phase: 'scenes' });
  assert.equal(second.phase, 'scenes');
  assert.deepEqual(second.scenes, ['Intro', 'Outro']);
  assert.match(calls[1].prompt, /The approved `script.txt`/);
  assert.ok(box.read('r-phases', 'scenes.py').startsWith('from manimlib import *'), 'the imports are put back');
  assert.equal(box.read('r-phases', 'script.txt'), SCRIPT, 'the narration is kept as approved');
});

test('helpers: blocks by scene, scene parts, and edits read from any answer shape', () => {
  assert.deepEqual(blocksByScene(SCENES), { Intro: ['intro'], Outro: ['outro'] });
  const parts = sceneParts(SCENES, ['Outro']);
  assert.ok(parts.includes('class Outro') && !parts.includes('class Intro') && parts.startsWith('from manimlib'));
  assert.deepEqual(readEdit({ title: 't', script: 's', scenes: 'c' }).whole, { script: 's', scenes: 'c' });
  assert.equal(readEdit(edit({ whole_scenes: 'x' })).whole.scenes, 'x');
  assert.deepEqual(readEdit(edit({ remove_blocks: ['a'] })).parts.remove_blocks, ['a']);
  assert.deepEqual(outsideScope({ kind: 'block', id: 'intro' }, { blocks: ['intro'], classes: ['Intro'], preamble: true }, SCENES), ['the code all scenes share']);
});
