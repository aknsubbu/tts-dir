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
import { sandbox, SCRIPT, scenes, until } from '../../author/test/fakes.js';

/** A long lesson through the dashboard: outline, review, chapters, a joined build, chapter edits and revisions. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
const ids = project.chapters || [];
const chapters = ids.map((id, i) => ({ id, title: project.chapter_titles[id], start: i * 60, end: (i + 1) * 60 }));
const blocks = ids.map((id, i) => ({ id: 'intro', chapter: id, scene: 'Intro', start: i * 60 + 1, end: i * 60 + 10, text: 'x', words: [] }));
const vtt = 'WEBVTT\\n\\n' + chapters.map((c) => c.title).join('\\n');
for (const [ext, body] of [['mp4', 'MP4:' + ids.join(',')], ['srt', '1\\n'], ['vtt', 'WEBVTT\\n'], ['jpg', 'JPG'], ['words.json', JSON.stringify({ version: 1, chapters, blocks })], ['chapters.vtt', vtt]]) fs.writeFileSync(path.join(build, name + '.' + ext), body);
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 60 * ids.length }));
for (const ext of ['mp4', 'srt', 'vtt', 'jpg', 'words.json', 'chapters.vtt']) console.log(path.join(build, name + '.' + ext));
`;
const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }], languages: [{ code: 'a', name: 'American English', available: true }], samples: {} }),
};
const OUTLINE = {
  title: 'Backpropagation',
  through_line: 'Why it is cheap',
  notation: [{ tex: 'w', meaning: 'weights', color: 'BLUE' }],
  chapters: [
    { id: 'one-neuron', title: 'One neuron', minutes: 5, goal: 'g', covers: ['a'], from_notes: '', files: [], starts_from: '', ends_with: '' },
    { id: 'chain', title: 'The chain rule', minutes: 5, goal: 'g', covers: ['b'], from_notes: '', files: [], starts_from: '', ends_with: '' },
  ],
};
const chapter = (title) => ({ title, script: SCRIPT, scenes: scenes() });
const EMPTY = { summary: '', blocks: [], remove_blocks: [], classes: [], remove_classes: [], preamble: '', whole_script: '', whole_scenes: '' };

let dir, box, store, lessons, server, authorServer, authorApp, base, config;
const j = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async (id) => (await j('GET', `/api/generations/${id}`)).data;
const settled = (id, statuses = ['done', 'error', 'cancelled', 'awaiting']) => until(async () => {
  const g = await get(id);
  return statuses.includes(g.status) ? g : null;
}, 20_000);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-chapters-api-'));
  box = sandbox(dir);
  const buildBin = path.join(dir, 'fake-build.js');
  fs.writeFileSync(buildBin, FAKE_BUILD, { mode: 0o755 });
  config = { ...box.config, videoBuild: [buildBin], defaultVoiceId: 'af_zed', keepRenders: 3, authorParallel: 1 };
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
});

after(async () => {
  lessons.stop();
  authorApp.stop();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authorServer.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a long lesson waits on its outline, then is written and built chapter by chapter', async () => {
  box.answers([OUTLINE]);
  const made = await j('POST', '/api/lessons', { topic: 'Backprop', minutes: 10, voiceId: 'af_zed', quality: 'low' });
  assert.equal(made.status, 201, made.data?.error);
  const id = made.data.generation.id;
  const waiting = await settled(id);
  assert.equal(waiting.status, 'awaiting', waiting.error);
  assert.equal(waiting.stage, 'Outline ready: 2 chapters, about 10 minutes');
  assert.equal(waiting.settings.lesson.phase, 'outline');
  assert.equal(waiting.title, 'Backpropagation');

  // Redo it once, then edit it: rename a chapter and put them the other way round.
  box.answers([{ ...OUTLINE, title: 'Backpropagation, redone' }]);
  await j('POST', `/api/generations/${id}/outline/redo`, { request: 'Fewer symbols' });
  const redone = await settled(id);
  assert.equal(redone.title, 'Backpropagation, redone');
  assert.match(box.asked().at(-1).stdin, /asked for it to be redone: “Fewer symbols”/);
  const outline = (await j('GET', `/api/generations/${id}/outline`)).data;
  assert.equal(outline.waiting, true);
  const edited = { ...outline, chapters: [{ ...outline.chapters[1], title: 'Chains' }, outline.chapters[0]] };
  const put = await j('PUT', `/api/generations/${id}/outline`, { outline: edited });
  assert.equal(put.status, 200, put.data?.error);
  assert.deepEqual(put.data.outline.chapters.map((c) => c.id), ['02-chain', '01-one-neuron'], 'ids stay with their chapters');

  box.answers([chapter('Chains'), chapter('One neuron')]);
  const approved = await j('POST', `/api/generations/${id}/approve`, { action: 'chapters' });
  assert.equal(approved.status, 200, approved.data?.error);
  const done = await settled(id, ['done', 'error']);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.version, 1);
  assert.deepEqual(done.settings.lesson.chapters.map((c) => c.title), ['Chains', 'One neuron']);
  assert.equal(await (await fetch(`${base}${done.videoUrl}`)).text(), 'MP4:02-chain,01-one-neuron');
  assert.match(await (await fetch(`${base}/api/generations/${id}/chapters.vtt`)).text(), /Chains\nOne neuron/);
  const project = done.settings.project;
  assert.ok(box.exists(project, 'versions/001/chapters/02-chain/script.txt'), 'the version keeps every chapter');
  assert.ok(box.exists(project, 'versions/001/outline.json'));
  assert.ok(box.asked().some((a) => /Write chapter 1 of 2/.test(a.stdin) && /\*\*Chains\*\*/.test(a.stdin)));

  // Each chapter has its own files to edit and storyboard to look at.
  const src = (await j('GET', `/api/generations/${id}/source?chapter=01-one-neuron`)).data;
  assert.equal(src.chapter, '01-one-neuron');
  assert.deepEqual(src.chapters.map((c) => c.title), ['Chains', 'One neuron']);
  assert.equal((await j('GET', `/api/generations/${id}/storyboard?chapter=02-chain`)).status, 200);
  assert.equal((await j('GET', `/api/generations/${id}/source?chapter=99-nope`)).status, 404);

  // A change is made to one chapter; the lesson must say which.
  assert.equal((await j('POST', `/api/generations/${id}/revise`, { request: 'Slower' })).status, 400);
  box.answers([{ ...EMPTY, summary: 'Slower', blocks: [{ id: 'intro', text: 'Every line has a <mark name="slope"/>slope, slowly.', after: '' }] }]);
  const revising = await j('POST', `/api/generations/${id}/revise`, { request: 'Slower', scope: { kind: 'time', at: 61 } });
  assert.equal(revising.status, 200, revising.data?.error);
  const revised = await settled(id, ['done', 'error']);
  assert.equal(revised.status, 'done', revised.error);
  assert.equal(revised.version, 2);
  assert.match(box.read(project, 'chapters/01-one-neuron/script.txt'), /slowly/, 'the chapter on screen at 61 s');
  assert.doesNotMatch(box.read(project, 'chapters/02-chain/script.txt'), /slowly/);
  const v2 = (await j('GET', `/api/generations/${id}/versions`)).data.versions[0];
  assert.equal(v2.details.chapter, '01-one-neuron');
});
