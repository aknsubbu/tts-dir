import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { createLessons } from '../lessons.js';
import { createVideoBuilder } from '../video.js';
import { createAuthorApp } from '../../author/app.js';
import { alive, answer, sandbox, SCRIPT, until } from '../../author/test/fakes.js';

let dir, box, store, runner, lessons, server, authorServer, authorApp, base, config;

/** Stands in for video/build.py, as in video.test.js: writes the three files and prints their paths. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root, , quality] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
console.error('$ narrate.py ' + root);
console.error('$ manimgl scenes.py Intro -w');
for (const [ext, body] of [['mp4', 'MP4' + quality], ['srt', '1\\n'], ['vtt', 'WEBVTT\\n']]) fs.writeFileSync(path.join(build, name + '.' + ext), body);
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 61.5 }));
for (const ext of ['mp4', 'srt', 'vtt']) console.log(path.join(build, name + '.' + ext));
`;

const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({
    voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }, { voiceId: 'ef_dora', name: 'Dora', lang: 'e' }],
    languages: [{ code: 'a', name: 'American English', available: true }, { code: 'e', name: 'Spanish', available: true }],
    samples: {},
  }),
  synthesize: async () => assert.fail('a lesson must not use the audio worker'),
};

const j = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async (id) => (await j('GET', `/api/generations/${id}`)).data;
const settled = (id) => until(async () => {
  const g = await get(id);
  return ['done', 'error', 'cancelled'].includes(g.status) ? g : null;
});
const LESSON = { topic: 'Gradient of the squared error', goal: 'Where the error times input comes from', notes: 'L = 1/2 (y_hat - y)^2', minutes: 1, voiceId: 'af_zed', quality: 'low' };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-lessons-test-'));
  box = sandbox(dir);
  const buildBin = path.join(dir, 'fake-build.js');
  fs.writeFileSync(buildBin, FAKE_BUILD, { mode: 0o755 });
  config = { ...box.config, videoBuild: [buildBin], defaultVoiceId: 'af_zed' };
  const getConfig = () => config;

  authorApp = createAuthorApp({ getConfig });
  await new Promise((resolve) => {
    authorServer = authorApp.listen(0, '127.0.0.1', resolve);
  });
  config.authorUrl = `http://127.0.0.1:${authorServer.address().port}`;

  store = createStore(path.join(dir, 'data'));
  runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig }) });
  lessons = createLessons({ store, runner, getConfig, pollMs: 20 });
  const app = createApp({ getConfig, store, runner, engine, lessons });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  lessons.stop();
  authorApp.stop();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authorServer.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a topic and notes become a video in the library', async () => {
  box.answers([answer()]);
  const made = await j('POST', '/api/lessons', LESSON);
  assert.equal(made.status, 201);
  const g0 = made.data.generation;
  assert.equal(g0.kind, 'video');
  assert.equal(g0.status, 'processing');
  assert.ok(g0.stage, 'the card says what the writer is doing');
  assert.equal(g0.title, 'Gradient of the squared error');
  assert.deepEqual(g0.tags, ['lesson']);
  assert.match(g0.settings.project, /^gradient-of-the-squared-error-[0-9a-f]{6}$/);
  assert.deepEqual(g0.settings.lesson, { topic: LESSON.topic, goal: LESSON.goal, minutes: 1, ownTitle: false });

  const g = await settled(g0.id);
  assert.equal(g.status, 'done', g.error);
  assert.equal(g.stage, null);
  assert.equal(g.title, 'Slope, quickly', 'no title was typed, so Claude names the video');
  assert.equal(g.text, '[intro]\nEvery line has a slope.', 'the library keeps the script as other videos do, without marks');
  assert.equal(g.wordCount, 6);
  assert.equal(g.durationSec, 61.5);
  assert.deepEqual(g.settings.scenes, ['Intro']);
  assert.equal(g.settings.lesson.fixes, 0);
  assert.equal(g.videoUrl, `/api/generations/${g.id}/video`);
  const video = await fetch(base + g.videoUrl);
  assert.equal(await video.text(), 'MP4low', 'built at the quality asked for');
  assert.equal((await fetch(`${base}/api/generations/${g.id}/captions.vtt`)).status, 200);

  // Claude was given the brief, and the project is on disk for editing.
  assert.match(box.asked()[0].stdin, /L = 1\/2 \(y_hat - y\)\^2/);
  assert.equal(box.read(g.settings.project, 'script.txt'), SCRIPT);
  assert.equal((await j('GET', '/api/generations?q=slope')).data.total, 1, 'searchable by what is said');
  // And it can be rebuilt like any project.
  assert.ok((await j('GET', '/api/video/projects')).data.projects.some((p) => p.name === g.settings.project));
});

test('a typed title is kept, and the stages show while Claude fixes its scenes', async () => {
  box.answers([answer('# BROKEN'), answer('# ok now')]);
  const made = await j('POST', '/api/lessons', { ...LESSON, title: 'My own title' });
  const seen = new Set();
  const g = await until(async () => {
    const now = await get(made.data.generation.id);
    if (now.stage) seen.add(now.stage);
    return ['done', 'error'].includes(now.status) ? now : null;
  });
  assert.equal(g.status, 'done', g.error);
  assert.equal(g.title, 'My own title');
  assert.equal(g.settings.lesson.fixes, 1);
  assert.ok([...seen].some((s) => /Writing|Checking|Fixing/.test(s)), [...seen].join(', '));
});

test('a lesson Claude cannot get right fails with the reason, and Retry resumes it', async () => {
  box.answers([answer('# BROKEN'), answer('# BROKEN'), answer('# BROKEN')]);
  const made = await j('POST', '/api/lessons', LESSON);
  const failed = await settled(made.data.generation.id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /still fail after 2 fixes.*MathTex/);
  assert.equal(failed.stage, null);

  box.answers([answer('# fixed on retry')]);
  const retried = await j('POST', `/api/generations/${failed.id}/retry`);
  assert.equal(retried.data.status, 'processing');
  const g = await settled(failed.id);
  assert.equal(g.status, 'done', g.error);
  assert.equal(box.asked().length, 1, 'the retry asked for a fix, not a new draft');
  assert.match(box.asked()[0].stdin, /It does not build yet/);

  // Once written, a retry (say after a failed build) only builds.
  store.update(g.id, { status: 'error', error: 'x' });
  box.answers([]);
  await j('POST', `/api/generations/${g.id}/retry`);
  assert.equal((await settled(g.id)).status, 'done');
  assert.equal(box.asked().length, 0);
});

test('cancelling or deleting while Claude writes stops it', async () => {
  box.answers([{ hang: true }, { hang: true }]);
  const pidFile = path.join(dir, 'grandchild.pid');
  fs.rmSync(pidFile, { force: true });
  const made = await j('POST', '/api/lessons', LESSON);
  let pid = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
  const cancelled = await j('POST', `/api/generations/${made.data.generation.id}/cancel`);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(cancelled.data.stage, null);
  await until(() => !alive(pid));
  assert.equal((await j('GET', '/api/stats')).data.active, 0);

  fs.rmSync(pidFile, { force: true });
  const second = await j('POST', '/api/lessons', LESSON);
  pid = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
  assert.equal((await j('DELETE', `/api/generations/${second.data.generation.id}`)).status, 200);
  await until(() => !alive(pid));
});

test('requests that cannot work are refused before anything is asked of Claude', async () => {
  box.answers([]);
  assert.match((await j('POST', '/api/lessons', { ...LESSON, topic: '  ' })).data.error, /what the video should be about/);
  assert.match((await j('POST', '/api/lessons', { ...LESSON, voiceId: 'ef_dora' })).data.error, /need an English voice/);
  assert.match((await j('POST', '/api/lessons', { ...LESSON, voiceId: 'af_nobody' })).data.error, /no voice called/);
  assert.match((await j('POST', '/api/lessons', { ...LESSON, notes: 'n'.repeat(60001) })).data.error, /limited to 60,000 characters/);
  assert.equal(box.asked().length, 0);
  // Odd topics still get a usable project name.
  box.answers([answer(), answer()]);
  const odd = await j('POST', '/api/lessons', { ...LESSON, topic: '∇ · E = ρ/ε₀ ???', minutes: 99 });
  assert.match(odd.data.generation.settings.project, /^[A-Za-z0-9_-]+-[0-9a-f]{6}$/);
  assert.equal(odd.data.generation.settings.lesson.minutes, 2, 'an unknown length falls back to two minutes');
  assert.equal((await settled(odd.data.generation.id)).status, 'done');
});

test('when the lesson writer is not running, the card says so', async () => {
  const real = config.authorUrl;
  config.authorUrl = 'http://127.0.0.1:9'; // nothing listens here
  const made = await j('POST', '/api/lessons', LESSON);
  config.authorUrl = real;
  assert.equal(made.status, 201);
  assert.equal(made.data.generation.status, 'error');
  assert.match(made.data.generation.error, /lesson writer is not running at http:\/\/127\.0\.0\.1:9.*Retry/);
  box.answers([answer()]);
  // The brief was never saved by the writer, so this retry cannot resume: it says why.
  await j('POST', `/api/generations/${made.data.generation.id}/retry`);
  const g = await settled(made.data.generation.id);
  assert.equal(g.status, 'error');
  assert.match(g.error, /no brief for this project/);
});

test('an older library gains the stage column', () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-old-'));
  const first = createStore(old);
  first.db.exec('ALTER TABLE generations DROP COLUMN stage');
  first.close();
  const again = createStore(old);
  assert.ok(again.db.prepare('PRAGMA table_info(generations)').all().some((c) => c.name === 'stage'));
  again.close();
  fs.rmSync(old, { recursive: true, force: true });
});
