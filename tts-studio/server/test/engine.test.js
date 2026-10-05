import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createEngine } from '../kokoro.js';

// These run the real Kokoro worker, so they are skipped until `npm run setup` has been run.
const installed = Boolean(loadConfig().python);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-engine-test-'));
const engine = createEngine({ getConfig: loadConfig });

after(() => {
  engine.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reports a missing install instead of spawning anything', async () => {
  const none = createEngine({ getConfig: () => ({ python: '' }) });
  await assert.rejects(none.start(), /npm run setup/);
  assert.equal(none.info().status, 'error');
});

test('the worker loads, lists voices and speaks to an MP3', { skip: !installed, timeout: 120_000 }, async () => {
  const info = await engine.start();
  assert.equal(engine.info().status, 'ready');
  assert.ok(info.voices.length >= 20);
  assert.ok(info.voices.some((v) => v.voiceId === 'af_heart'));
  assert.ok(info.languages.find((l) => l.code === 'a').available);

  const out = path.join(dir, 'hello.mp3');
  const progress = [];
  const r = await engine.synthesize({
    text: 'Hello from the test suite.\n\nThis is a second paragraph.',
    voice: 'af_heart',
    out,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.ok(r.durationSec > 2 && r.durationSec < 15);
  assert.equal(fs.statSync(out).size, r.bytes);

  await assert.rejects(engine.synthesize({ text: 'Hi.', voice: 'af_nobody', out: path.join(dir, 'x.mp3') }), /Unknown voice/);
});

test('cancelling restarts the worker and other requests still finish', { skip: !installed, timeout: 120_000 }, async () => {
  await engine.start();
  const ctrl = new AbortController();
  const long = engine.synthesize({
    text: 'This sentence is repeated many times over. '.repeat(120),
    voice: 'af_heart',
    out: path.join(dir, 'long.mp3'),
    signal: ctrl.signal,
    onProgress: () => ctrl.abort(), // cancel once it is clearly under way
  });
  const bystander = engine.synthesize({ text: 'I was waiting in line.', voice: 'bm_george', out: path.join(dir, 'next.mp3') });
  await assert.rejects(long, (e) => e.code === 'aborted');
  const r = await bystander;
  assert.ok(r.bytes > 1000);
  assert.equal(engine.info().status, 'ready');
});
