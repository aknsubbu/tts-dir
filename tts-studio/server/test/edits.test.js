import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { createLessons } from '../lessons.js';
import { createVideoBuilder } from '../video.js';
import { createVersions } from '../versions.js';
import { createAuthorApp } from '../../author/app.js';
import { answer, sandbox, until } from '../../author/test/fakes.js';

/** Editing, checking, rendering, discarding and restoring a lesson, with the fake writer, check and build. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root, , quality] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const script = fs.readFileSync(path.join(root, 'script.txt'), 'utf8');
if (process.env.FAKE_BUILD_GATE) while (!fs.existsSync(process.env.FAKE_BUILD_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const words = { version: 1, blocks: [{ id: 'intro', scene: 'Intro', start: 0, end: 2, text: 'Every line has a slope.', words: [['Every', 0.1, 0.3], ['line', 0.3, 0.6]] }] };
for (const [ext, body] of [['mp4', 'MP4:' + script.length], ['srt', '1\\n'], ['vtt', 'WEBVTT\\n'], ['jpg', 'JPG'], ['words.json', JSON.stringify(words)]]) fs.writeFileSync(path.join(build, name + '.' + ext), body);
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 30 + script.length / 100 }));
for (const ext of ['mp4', 'srt', 'vtt', 'jpg', 'words.json']) console.log(path.join(build, name + '.' + ext));
`;
const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }], languages: [{ code: 'a', name: 'American English', available: true }], samples: {} }),
};

let dir, box, store, lessons, server, authorServer, authorApp, base, config, id, gate;

const j = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async () => (await j('GET', `/api/generations/${id}`)).data;
const settled = (statuses = ['done', 'error', 'cancelled', 'awaiting']) => until(async () => {
  const g = await get();
  return statuses.includes(g.status) ? g : null;
}, 15_000);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-edits-'));
  box = sandbox(dir);
  const buildBin = path.join(dir, 'fake-build.js');
  fs.writeFileSync(buildBin, FAKE_BUILD, { mode: 0o755 });
  gate = path.join(dir, 'build-gate');
  process.env.FAKE_BUILD_GATE = gate;
  fs.writeFileSync(gate, '');
  config = { ...box.config, videoBuild: [buildBin], defaultVoiceId: 'af_zed', keepRenders: 3 };
  const getConfig = () => config;
  authorApp = createAuthorApp({ getConfig });
  await new Promise((resolve) => {
    authorServer = authorApp.listen(0, '127.0.0.1', resolve);
  });
  config.authorUrl = `http://127.0.0.1:${authorServer.address().port}`;
  store = createStore(path.join(dir, 'data'));
  const versions = createVersions({ store, getConfig });
  const runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig }), versions });
  lessons = createLessons({ store, runner, getConfig, versions, pollMs: 20 });
  const app = createApp({ getConfig, store, runner, engine, lessons, versions });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  box.answers([answer()]);
  id = (await j('POST', '/api/lessons', { topic: 'Slope', minutes: 1, voiceId: 'af_zed', quality: 'low' })).data.generation.id;
  const g = await settled();
  assert.equal(g.status, 'done', g.error);
});

after(async () => {
  delete process.env.FAKE_BUILD_GATE;
  lessons.stop();
  authorApp.stop();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authorServer.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the working copy, with a hash to save against', async () => {
  const { status, data } = await j('GET', `/api/generations/${id}/source`);
  assert.equal(status, 200);
  assert.match(data.script, /\[intro\]/);
  assert.match(data.scenes, /class Intro/);
  assert.equal(data.voice, 'af_zed');
  assert.equal(data.version, 1);
  assert.equal(data.draft, false);
  assert.equal(data.editable, true);
  assert.match(data.hash, /^[0-9a-f]{16}$/);
});

test('a save is checked at once, and refused when the files changed underneath', async () => {
  const src = (await j('GET', `/api/generations/${id}/source`)).data;
  const scenes = src.scenes.replace('self.wait(vo.remaining())', 'self.wait(vo.remaining())  # STATIC_BAD');
  const saved = await j('PUT', `/api/generations/${id}/source`, { base: src.hash, scenes, speed: 1.1 });
  assert.equal(saved.status, 200, saved.data?.error);
  assert.equal(saved.data.report.ok, false);
  assert.deepEqual([saved.data.report.errors[0].file, saved.data.report.errors[0].line], ['scenes.py', 8]);
  assert.equal(saved.data.draft, true);
  assert.equal(saved.data.speed, 1.1);
  assert.equal(JSON.parse(box.read(src.project, 'project.json')).speed, 1.1);
  assert.ok(box.checked().at(-1).flags.includes('--static'));

  const stale = await j('PUT', `/api/generations/${id}/source`, { base: src.hash, script: 'x' });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /changed since you opened them/);
  assert.equal(stale.data.current.hash, saved.data.hash);

  const big = await j('PUT', `/api/generations/${id}/source`, { base: saved.data.hash, script: 'x'.repeat(201 * 1024) });
  assert.equal(big.status, 413);
  const french = await j('PUT', `/api/generations/${id}/source`, { base: saved.data.hash, voice: 'ff_siwis' });
  assert.match(french.data.error, /English voice/);
});

test('discard goes back to the current version', async () => {
  const { data } = await j('POST', `/api/generations/${id}/discard`);
  assert.equal(data.draft, false);
  assert.ok(!data.scenes.includes('STATIC_BAD'));
  assert.equal(data.speed, 1);
});

test('a render that fails its check leaves the lesson playing as it was', async () => {
  const src = (await j('GET', `/api/generations/${id}/source`)).data;
  await j('PUT', `/api/generations/${id}/source`, { base: src.hash, scenes: src.scenes.replace('self.wait(vo.remaining())', 'self.wait(vo.remaining())  # BROKEN') });
  const started = await j('POST', `/api/generations/${id}/build`, { quality: 'medium' });
  assert.equal(started.status, 200);
  assert.equal(started.data.stage, 'Checking your changes before rendering');
  assert.ok(started.data.videoUrl, 'the built video still plays while the edit is checked');
  const g = await settled(['done']);
  assert.equal(g.version, 1, 'no version was made');
  assert.equal(g.settings.edit.ok, false);
  const after = (await j('GET', `/api/generations/${id}/source`)).data;
  assert.match(after.report.errors[0].message, /NameError/);
  await j('POST', `/api/generations/${id}/discard`);
});

test('a render makes the next version and builds it, while the old one plays', async () => {
  const src = (await j('GET', `/api/generations/${id}/source`)).data;
  const script = src.script.replace('slope.', 'slope, and that is all.');
  assert.equal((await j('PUT', `/api/generations/${id}/source`, { base: src.hash, script })).status, 200);
  fs.rmSync(gate);
  await j('POST', `/api/generations/${id}/build`, { quality: 'medium' });
  const building = await until(async () => {
    const g = await get();
    return g.status === 'processing' && g.version === 2 ? g : null;
  });
  assert.equal(building.builtVersion, 1);
  assert.ok(building.videoUrl, 'v1 keeps playing during the build');
  fs.writeFileSync(gate, '');
  const g = await settled(['done', 'error']);
  assert.equal(g.status, 'done', g.error);
  assert.equal(g.builtVersion, 2);
  assert.equal(g.settings.quality, 'medium');
  assert.equal(await (await fetch(`${base}${g.videoUrl}`)).text(), `MP4:${script.length}`);
  const versions = (await j('GET', `/api/generations/${id}/versions`)).data.versions;
  assert.deepEqual(versions.map((v) => [v.n, v.source, v.renderKept]), [[2, 'edited', true], [1, 'written', true]]);
  const v1 = (await j('GET', `/api/generations/${id}/versions/1/source`)).data;
  assert.ok(!v1.script.includes('that is all'));
});

test('restoring a version whose render is kept is instant', async () => {
  const before = await get();
  const { data } = await j('POST', `/api/generations/${id}/restore`, { version: 1 });
  assert.equal(data.status, 'done');
  assert.equal(data.version, 3);
  assert.equal(data.builtVersion, 3);
  const v1script = (await j('GET', `/api/generations/${id}/versions/1/source`)).data.script;
  assert.equal(await (await fetch(`${base}${data.videoUrl}`)).text(), `MP4:${v1script.length}`, "v1's render is back");
  const versions = (await j('GET', `/api/generations/${id}/versions`)).data.versions;
  assert.deepEqual(versions.map((v) => [v.n, v.source, v.note]).slice(0, 1), [[3, 'restored', 'Restored from v1']]);
  assert.notEqual(before.builtVersion, data.builtVersion);
});

test('the transcript gives every word its time in the video', async () => {
  const { status, data } = await j('GET', `/api/generations/${id}/transcript`);
  assert.equal(status, 200);
  assert.deepEqual(data.blocks[0].words[0], ['Every', 0.1, 0.3]);
});

test('nothing is saved while the lesson is busy, and hand-written projects stay read-only', async () => {
  const src = (await j('GET', `/api/generations/${id}/source`)).data;
  store.update(id, { status: 'processing' });
  const busy = await j('PUT', `/api/generations/${id}/source`, { base: src.hash, script: 'x' });
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /being written, checked or built/);
  store.update(id, { status: 'done' });

  fs.mkdirSync(path.join(config.videoDir, 'projects', 'hand'), { recursive: true });
  for (const [f, body] of [['script.txt', '[a]\nHi.\n'], ['scenes.py', 'x'], ['project.json', '{"scenes":["A"]}']]) fs.writeFileSync(path.join(config.videoDir, 'projects', 'hand', f), body);
  const made = await j('POST', '/api/videos', { project: 'hand' });
  const hand = made.data.generation.id;
  assert.equal((await j('GET', `/api/generations/${hand}/source`)).data.editable, false);
  const refused = await j('PUT', `/api/generations/${hand}/source`, { script: 'y' });
  assert.equal(refused.status, 403);
});

test('rendering files that match an unbuilt version builds that version, not a copy of it', async () => {
  const g0 = await get();
  store.update(id, { built_version: g0.version - 1 >= 1 ? g0.version - 1 : 1 }); // as if the last build had failed
  const before = (await j('GET', `/api/generations/${id}/versions`)).data.versions.length;
  await j('POST', `/api/generations/${id}/build`, {});
  const g = await settled(['done', 'error']);
  assert.equal(g.status, 'done', g.error);
  assert.equal((await j('GET', `/api/generations/${id}/versions`)).data.versions.length, before);
  assert.equal(g.builtVersion, g0.version);
});
