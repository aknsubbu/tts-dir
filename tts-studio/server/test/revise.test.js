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
import { createAuthorJobs } from '../../author/jobs.js';
import { answer, sandbox, SCRIPT, scenes, until } from '../../author/test/fakes.js';

/** Revisions and narration-first lessons, through the dashboard, the writer and the fake check and build. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const script = fs.readFileSync(path.join(root, 'script.txt'), 'utf8');
const words = { version: 1, blocks: [{ id: 'intro', scene: 'Intro', start: 0, end: 12, text: 'x', words: [] }] };
for (const [ext, body] of [['mp4', 'MP4:' + script], ['srt', '1\\n'], ['vtt', 'WEBVTT\\n'], ['jpg', 'JPG'], ['words.json', JSON.stringify(words)]]) fs.writeFileSync(path.join(build, name + '.' + ext), body);
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 12 }));
for (const ext of ['mp4', 'srt', 'vtt', 'jpg', 'words.json']) console.log(path.join(build, name + '.' + ext));
`;
const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }], languages: [{ code: 'a', name: 'American English', available: true }], samples: {} }),
};
const EMPTY = { summary: '', blocks: [], remove_blocks: [], classes: [], remove_classes: [], preamble: '', whole_script: '', whole_scenes: '' };

let dir, box, store, lessons, server, authorJobs, base, config;
const j = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async (id) => (await j('GET', `/api/generations/${id}`)).data;
const settled = (id, statuses = ['done', 'error', 'cancelled', 'awaiting']) => until(async () => {
  const g = await get(id);
  return statuses.includes(g.status) ? g : null;
}, 15_000);
const makeLesson = async (extra = {}) => {
  const id = (await j('POST', '/api/lessons', { topic: 'Slope', minutes: 1, voiceId: 'af_zed', quality: 'low', ...extra })).data.generation.id;
  return { id, g: await settled(id) };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-revise-api-'));
  box = sandbox(dir);
  const buildBin = path.join(dir, 'fake-build.js');
  fs.writeFileSync(buildBin, FAKE_BUILD, { mode: 0o755 });
  config = { ...box.config, videoBuild: [buildBin], defaultVoiceId: 'af_zed', keepRenders: 3 };
  const getConfig = () => config;
  authorJobs = createAuthorJobs({ getConfig });
  store = createStore(path.join(dir, 'data'));
  const versions = createVersions({ store, getConfig });
  const runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig }), versions });
  lessons = createLessons({ store, runner, getConfig, jobs: authorJobs, versions, pollMs: 20 });
  const app = createApp({ getConfig, store, runner, engine, lessons, versions });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  lessons.stop();
  authorJobs.stop();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a revision of the moment the video was paused at becomes the next version, while the old one plays', async () => {
  box.answers([answer()]);
  const { id, g } = await makeLesson();
  assert.equal(g.status, 'done', g.error);
  box.answers([{ ...EMPTY, summary: 'Said it more slowly', blocks: [{ id: 'intro', text: 'Every single line has a <mark name="slope"/>slope.', after: '' }] }]);
  const started = await j('POST', `/api/generations/${id}/revise`, { request: 'Slow down here', scope: { kind: 'time', at: 4.2 } });
  assert.equal(started.status, 200, started.data?.error);
  assert.equal(started.data.status, 'processing');
  assert.ok(started.data.videoUrl, 'v1 plays during the revision');
  const done = await settled(id, ['done', 'error']);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.version, 2);
  assert.equal(done.builtVersion, 2);
  assert.equal(done.settings.lastRevision.summary, 'Said it more slowly');
  const asked = box.asked().at(-1).stdin;
  assert.match(asked, /<change_request>\nSlow down here\n<\/change_request>/);
  assert.match(asked, /block \[intro\], played by Intro: the video was paused 4 seconds in/);
  const v2 = (await j('GET', `/api/generations/${id}/versions`)).data.versions[0];
  assert.equal(v2.source, 'revised');
  assert.equal(v2.note, 'Slow down here');
  assert.deepEqual(v2.details.scope, { kind: 'block', id: 'intro', scene: 'Intro', at: 4.2 });
  assert.deepEqual(v2.details.changed.blocks, ['intro']);
  assert.match(await (await fetch(`${base}${done.videoUrl}`)).text(), /Every single line/);

  // The next request is told what came before.
  box.answers([{ ...EMPTY, summary: 'Back as it was', blocks: [{ id: 'intro', text: SCRIPT.split('\n')[1], after: '' }] }]);
  await j('POST', `/api/generations/${id}/revise`, { request: 'Undo that', review: 'storyboard' });
  const waiting = await settled(id, ['awaiting', 'error']);
  assert.equal(waiting.status, 'awaiting', waiting.error);
  assert.match(box.asked().at(-1).stdin, /- "Slow down here" → Said it more slowly/);
});

test('a revision that fails leaves the lesson and its files as they were', async () => {
  box.answers([answer()]);
  const { id, g } = await makeLesson();
  const root = box.project(g.settings.project);
  const before = fs.readFileSync(path.join(root, 'scenes.py'), 'utf8');
  const broken = scenes('# BROKEN').replace('from manimlib import *\nfrom voiceover import VoiceoverScene\n\n\n', '').trim();
  const stillBroken = { ...EMPTY, classes: [{ name: 'Intro', code: broken, after: '' }] };
  box.answers([{ ...EMPTY, summary: 'Broke it', classes: [{ name: 'Intro', code: broken, after: '' }] }, stillBroken, stillBroken]);
  await j('POST', `/api/generations/${id}/revise`, { request: 'Add an animation' });
  const after = await settled(id, ['done', 'error']);
  assert.equal(after.status, 'done', 'still the built lesson');
  assert.equal(after.version, 1);
  assert.equal(after.settings.lastRevision.ok, false);
  assert.match(after.settings.lastRevision.error, /still fail after 2 fixes/);
  assert.equal(fs.readFileSync(path.join(root, 'scenes.py'), 'utf8'), before, 'the files are back as v1 has them');
});

test('revisions are refused while busy, for hand-written projects, and without a request', async () => {
  box.answers([answer()]);
  const { id } = await makeLesson();
  assert.equal((await j('POST', `/api/generations/${id}/revise`, { request: '  ' })).status, 400);
  assert.equal((await j('POST', `/api/generations/${id}/revise`, { request: 'x', scope: { kind: 'scene', name: 'not a name' } })).status, 400);
  store.update(id, { status: 'processing' });
  assert.equal((await j('POST', `/api/generations/${id}/revise`, { request: 'x' })).status, 409);
  store.update(id, { status: 'done' });
});

test('the narration can be approved before the scenes are written', async () => {
  box.answers([{ title: 'Slope, said first', script: SCRIPT }]);
  const { id, g } = await makeLesson({ review: 'script' });
  assert.equal(g.status, 'awaiting', g.error);
  assert.equal(g.stage, 'Narration ready: have a look');
  assert.equal(g.settings.lesson.phase, 'script');
  assert.equal(g.title, 'Slope, said first');
  assert.ok(!box.exists(g.settings.project, 'scenes.py'));
  assert.equal((await j('POST', `/api/generations/${id}/approve`, { action: 'render' })).status, 409);
  assert.equal((await j('POST', `/api/generations/${id}/revise`, { request: 'x' })).status, 409);

  box.answers([{ scenes: scenes() }]);
  const approved = await j('POST', `/api/generations/${id}/approve`, { action: 'scenes' });
  assert.equal(approved.status, 200, approved.data?.error);
  const done = await settled(id, ['done', 'error']);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.version, 1);
  assert.equal(done.settings.lesson.phase, null);
  assert.equal(done.settings.lesson.costUsd, 0.5, 'both requests are counted');
  assert.match(box.asked().at(-1).stdin, /The approved `script.txt`/);
});
