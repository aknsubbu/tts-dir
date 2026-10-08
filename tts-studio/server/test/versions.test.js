import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { createVersions } from '../versions.js';

let dir, videoDir, store, versions, runner, server, base, config;
let renders = 0;
let failNext = false;

const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [], languages: [], samples: {} }),
};

/** Stands in for the video builder: writes a numbered render into the project's build folder. */
const video = {
  async build({ project, onProgress }) {
    if (failNext) {
      failNext = false;
      throw new Error('The video build failed. error: rendering Intro failed');
    }
    renders += 1;
    const build = path.join(videoDir, 'projects', project, 'build');
    const files = {};
    for (const ext of ['mp4', 'srt', 'vtt']) {
      files[ext] = path.join(build, `${project}.${ext}`);
      fs.writeFileSync(files[ext], `render ${renders} ${ext}`);
    }
    onProgress?.(1, 1);
    return { files, durationSec: 10 + renders, segments: 1 };
  },
};

const BOARD = {
  version: 1,
  duration: 3.5,
  unplayed: [],
  scenes: [{
    name: 'Intro', error: null, end: 'Intro-end.png', issues: [],
    blocks: [{ id: 'intro', text: 'Every line has a <mark name="slope"/>slope.', duration: 3.5, start: 0.1, marks: { slope: 1.2 }, wav: 'audio/intro-abc.wav',
      stills: [{ block: 'intro', mark: 'slope', file: 'Intro-intro--slope.png', at: 1.2 }, { block: 'intro', mark: null, file: 'Intro-intro.png', at: 3.5 }],
      issues: [{ kind: 'layout', message: 'text overlaps' }] }],
  }],
};

function makeProject(name) {
  const root = path.join(videoDir, 'projects', name);
  fs.mkdirSync(path.join(root, 'build', 'check', 'frames'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build', 'audio'), { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), '[intro]\nEvery line has a <mark name="slope"/>slope.\n');
  fs.writeFileSync(path.join(root, 'scenes.py'), 'class Intro: pass\n');
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ voice: 'af_heart', scenes: ['Intro'] }));
  fs.writeFileSync(path.join(root, 'build', 'check', 'storyboard.json'), JSON.stringify(BOARD));
  for (const f of ['Intro-intro--slope.png', 'Intro-intro.png', 'Intro-end.png']) fs.writeFileSync(path.join(root, 'build', 'check', 'frames', f), f);
  fs.writeFileSync(path.join(root, 'build', 'manifest.json'), JSON.stringify({ order: ['intro'], blocks: { intro: { wav: 'audio/intro-abc.wav' }, evil: { wav: '../../script.txt' } } }));
  fs.writeFileSync(path.join(root, 'build', 'audio', 'intro-abc.wav'), 'RIFF');
  return root;
}

function insertLesson(id, project, status = 'queued') {
  store.insert({
    id, kind: 'video', title: project, source_name: `video/projects/${project}`, text: 'x', text_hash: 'h', config_hash: `c-${id}`,
    char_count: 1, word_count: 1, voice_id: 'af_heart', voice_name: null, model_id: 'm',
    settings_json: JSON.stringify({ project, quality: 'low', scenes: ['Intro'], lesson: { topic: 't', review: 'render' } }),
    status, tags: 'lesson', created_at: Date.now(),
  });
}

const settledBuild = async (id) => {
  for (let i = 0; i < 200; i += 1) {
    const row = store.getRaw(id);
    if (!['queued', 'processing'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('build did not finish');
};

const j = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-versions-test-'));
  videoDir = path.join(dir, 'video');
  config = { videoDir, keepRenders: 3, defaultVoiceId: 'af_heart' };
  store = createStore(path.join(dir, 'data'));
  versions = createVersions({ store, getConfig: () => config });
  runner = createRunner({ store, engine, video, versions });
  const app = createApp({ getConfig: () => config, store, runner, engine, versions });
  await new Promise((resolve) => (server = app.listen(0, '127.0.0.1', resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a version is a snapshot of the files and the storyboard, numbered in order', () => {
  const root = makeProject('snap');
  insertLesson('snap-id', 'snap', 'done');
  const n = versions.snapshot('snap-id', { source: 'written', costUsd: 0.4, usage: { outputTokens: 10 }, check: { ok: true, warnings: 1 } });
  assert.equal(n, 1);
  assert.equal(store.getRaw('snap-id').version, 1);
  const v = path.join(root, 'versions', '001');
  assert.equal(fs.readFileSync(path.join(v, 'scenes.py'), 'utf8'), 'class Intro: pass\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(v, 'version.json'), 'utf8')).source, 'written');
  assert.ok(fs.existsSync(path.join(v, 'storyboard', 'frames', 'Intro-intro--slope.png')));
  assert.equal(versions.snapshot('snap-id', { source: 'edited' }), 2);
  assert.deepEqual(store.versions.list('snap-id').map((x) => [x.n, x.source]), [[2, 'edited'], [1, 'written']]);
  assert.equal(store.stats().costThisMonthUsd, 0.4);
});

test('a newer version keeps playing the last one while it builds, and only the last renders are kept', async () => {
  makeProject('les');
  insertLesson('les-id', 'les');
  versions.snapshot('les-id', { source: 'written' });
  runner.enqueue('les-id');
  let row = await settledBuild('les-id');
  assert.equal(row.status, 'done');
  assert.equal(row.built_version, 1);
  assert.equal(fs.readFileSync(store.videoPath('les-id'), 'utf8'), `render ${renders} mp4`);
  const first = renders;

  // Version 2 is made and building: the card still has a video, version 1's.
  versions.snapshot('les-id', { source: 'edited' });
  store.update('les-id', { status: 'processing' });
  assert.ok(store.get('les-id').videoUrl, 'still playable while the next version builds');
  store.update('les-id', { status: 'queued' });
  runner.enqueue('les-id');
  row = await settledBuild('les-id');
  assert.equal(row.built_version, 2);
  assert.equal(fs.readFileSync(path.join(path.dirname(store.videoPath('les-id')), 'les-id', 'v1.mp4'), 'utf8'), `render ${first} mp4`);
  assert.equal(versions.renderFile('les-id', 1), path.join(path.dirname(store.videoPath('les-id')), 'les-id', 'v1.mp4'));

  // A failed build of version 3 leaves version 2 playing.
  versions.snapshot('les-id', { source: 'edited' });
  failNext = true;
  store.update('les-id', { status: 'queued' });
  runner.enqueue('les-id');
  row = await settledBuild('les-id');
  assert.equal(row.status, 'error');
  assert.equal(row.built_version, 2);
  assert.ok(store.get('les-id').videoUrl);
  assert.equal(fs.readFileSync(store.videoPath('les-id'), 'utf8'), `render ${renders} mp4`);
  assert.ok(!fs.existsSync(`${store.videoPath('les-id')}.new`));

  // Versions 3 and 4 built: with three renders kept, version 1's goes.
  for (let k = 0; k < 2; k += 1) {
    if (k) versions.snapshot('les-id', { source: 'edited' });
    store.update('les-id', { status: 'queued' });
    runner.enqueue('les-id');
    await settledBuild('les-id');
  }
  const kept = store.versions.list('les-id').filter((v) => v.render_kept).map((v) => v.n);
  assert.deepEqual(kept, [4, 3, 2]);
  assert.equal(versions.renderFile('les-id', 1), null);
  const list = (await j('GET', '/api/generations/les-id/versions')).data;
  assert.equal(list.current, 4);
  assert.equal(list.built, 4);
  assert.deepEqual(list.versions.map((v) => v.renderKept), [true, true, true, false]);

  // Deleting the lesson removes the kept renders with it.
  await j('DELETE', '/api/generations/les-id');
  assert.ok(!fs.existsSync(path.join(path.dirname(store.videoPath('les-id')), 'les-id')));
});

test('the storyboard, its stills and each block\'s narration are served, and nothing else', async () => {
  makeProject('board');
  insertLesson('board-id', 'board', 'awaiting');
  const board = (await j('GET', '/api/generations/board-id/storyboard')).data;
  const block = board.scenes[0].blocks[0];
  assert.equal(block.stills[0].url, '/api/generations/board-id/storyboard/Intro-intro--slope.png');
  assert.equal(block.audioUrl, '/api/generations/board-id/narration/intro');
  assert.equal(board.scenes[0].endUrl, '/api/generations/board-id/storyboard/Intro-end.png');
  assert.equal(await (await fetch(base + block.stills[0].url)).text(), 'Intro-intro--slope.png');
  const wav = await fetch(base + block.audioUrl);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');

  fs.writeFileSync(path.join(videoDir, 'projects', 'board', 'build', 'check', 'frames', 'stray.png'), 'x');
  assert.equal((await fetch(`${base}/api/generations/board-id/storyboard/stray.png`)).status, 404, 'only stills the storyboard lists');
  assert.equal((await fetch(`${base}/api/generations/board-id/storyboard/..%2Fstoryboard.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/generations/board-id/narration/evil`)).status, 404, 'a wav outside build/audio is refused');
  assert.equal((await fetch(`${base}/api/generations/board-id/narration/nope`)).status, 404);

  // A version's storyboard comes from its snapshot and has no narration links.
  versions.snapshot('board-id', { source: 'written' });
  fs.rmSync(path.join(videoDir, 'projects', 'board', 'build', 'check'), { recursive: true });
  assert.equal((await j('GET', '/api/generations/board-id/storyboard')).status, 404);
  const v1 = (await j('GET', '/api/generations/board-id/storyboard?version=1')).data;
  assert.equal(v1.version, 1);
  assert.equal(v1.scenes[0].blocks[0].audioUrl, null);
  assert.equal((await fetch(base + v1.scenes[0].blocks[0].stills[1].url)).status, 200);
  assert.equal((await j('GET', '/api/generations/board-id/storyboard?version=x')).status, 400);
});

test('a lesson waiting on its storyboard is rendered on approval, or cancelled', async () => {
  makeProject('wait');
  insertLesson('wait-id', 'wait', 'awaiting');
  assert.ok(store.list({ status: 'awaiting' }).items.some((g) => g.id === 'wait-id'));
  assert.equal(store.stats().awaiting, store.list({ status: 'awaiting' }).total);
  const approved = await j('POST', '/api/generations/wait-id/approve', { action: 'render', quality: 'hd' });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.settings.quality, 'hd');
  assert.equal((await settledBuild('wait-id')).status, 'done');
  assert.equal((await j('POST', '/api/generations/wait-id/approve')).status, 409);

  makeProject('nope');
  insertLesson('nope-id', 'nope', 'awaiting');
  const cancelled = await j('POST', '/api/generations/nope-id/cancel');
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(store.markInterrupted(), 0, 'a lesson waiting on the person is not "interrupted" by a restart');
});

test('changes stream to the page as server-sent events', async () => {
  makeProject('live');
  insertLesson('live-id', 'live', 'done');
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  store.update('live-id', { title: 'One' });
  store.update('live-id', { title: 'Two' }); // coalesced: the latest state is sent once
  let text = '';
  while (!text.includes('"Two"')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  const events = text.split('\n\n').filter((e) => e.startsWith('event: generation'));
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].split('data: ')[1]).title, 'Two');
});
