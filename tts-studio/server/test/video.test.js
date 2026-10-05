import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { createVideoBuilder } from '../video.js';

let dataDir, videoDir, store, server, base, runner;

/** Stands in for video/build.py: same arguments, same output, nothing rendered. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [root, flag, quality] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(path.join(build, 'args.json'), JSON.stringify({ flag, quality }));
console.error('$ narrate.py ' + root);
if (name === 'slow') {
  // Like manimgl under build.py: a grandchild that must die with the build.
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(build, 'grandchild.pid'), String(child.pid));
  setTimeout(() => {}, 30000);
} else if (name === 'broken') {
  console.error('$ manimgl scenes.py Intro -w');
  console.error('error: rendering Intro failed; see the manimgl output above');
  process.exit(1);
} else {
  console.error('$ manimgl scenes.py Intro -w');
  console.error('$ ffmpeg -i Intro.mp4');
  console.log('                    emo/build/scenes/Intro.mp4'); // a wrapped manim log line on stdout
  for (const [ext, body] of [['mp4', 'MP4DATA'.repeat(100)], ['srt', '1\\n00:00:00,000 --> 00:00:01,000\\nHi\\n\\n'], ['vtt', 'WEBVTT\\n\\n']]) {
    fs.writeFileSync(path.join(build, name + '.' + ext), body);
  }
  fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 12.5 }));
  for (const ext of ['mp4', 'srt', 'vtt']) console.log(path.join(build, name + '.' + ext));
}
`;

const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }], languages: [], samples: {} }),
  synthesize: async () => assert.fail('a video job must not use the audio worker'),
};

const j = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function waitFor(id, statuses = ['done', 'error', 'cancelled'], ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { data } = await j('GET', `/api/generations/${id}`);
    if (statuses.includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${id}`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function addProject(name, scenes = ['Intro']) {
  const root = path.join(videoDir, 'projects', name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ voice: 'af_zed', scenes }));
  fs.writeFileSync(path.join(root, 'script.txt'), `# a comment\n[intro]\nThe ${name} project talks <mark name="m"/> about slopes.\n`);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-video-test-'));
  videoDir = path.join(dataDir, 'video-src');
  for (const name of ['demo', 'slow', 'broken']) addProject(name);
  addProject('empty', []);
  fs.mkdirSync(path.join(videoDir, 'projects', 'not a project'));
  const fake = path.join(dataDir, 'fake-build.cjs');
  fs.writeFileSync(fake, FAKE_BUILD, { mode: 0o755 });

  store = createStore(path.join(dataDir, 'data'));
  const getConfig = () => ({ defaultVoiceId: 'af_zed', envFile: null, videoDir, videoBuild: [fake] });
  runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig }) });
  const app = createApp({ getConfig, store, runner, engine });
  server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('lists the video projects', async () => {
  const { data } = await j('GET', '/api/video/projects');
  assert.deepEqual(data.projects.map((p) => p.name), ['broken', 'demo', 'empty', 'slow']);
  assert.deepEqual(data.projects[1], { name: 'demo', voice: 'af_zed', speed: 1, scenes: ['Intro'] });
});

test('builds a video into the library with its captions', async () => {
  const { status, data } = await j('POST', '/api/videos', { project: 'demo', quality: 'low' });
  assert.equal(status, 201);
  assert.equal(data.generation.kind, 'video');
  assert.equal(data.generation.title, 'demo (video)');
  assert.deepEqual(data.generation.tags, ['video']);

  const done = await waitFor(data.generation.id);
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.durationSec, 12.5);
  assert.equal(done.audioBytes, 700);
  assert.equal(done.progressDone, 3); // narrate, one scene, join
  assert.equal(done.audioUrl, null);
  assert.equal(done.videoUrl, `/api/generations/${done.id}/video`);
  assert.equal(done.voiceName, 'Zed');
  assert.equal(done.text, '[intro]\nThe demo project talks about slopes.'); // no comments or mark tags
  const args = JSON.parse(fs.readFileSync(path.join(videoDir, 'projects', 'demo', 'build', 'args.json'), 'utf8'));
  assert.deepEqual(args, { flag: '--quality', quality: 'low' });

  const video = await fetch(base + done.videoUrl, { headers: { Range: 'bytes=0-6' } });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.equal(await video.text(), 'MP4DATA');
  const vtt = await fetch(`${base}/api/generations/${done.id}/captions.vtt`);
  assert.match(vtt.headers.get('content-type'), /text\/vtt/);
  assert.equal(await vtt.text(), 'WEBVTT\n\n');
  const srt = await fetch(`${base}/api/generations/${done.id}/captions.srt?download=1`);
  assert.match(srt.headers.get('content-disposition'), /demo-video\.srt/);
  assert.equal((await fetch(`${base}/api/generations/${done.id}/captions.txt`)).status, 404);
  assert.equal((await fetch(`${base}/api/generations/${done.id}/audio`)).status, 404);

  const found = (await j('GET', '/api/generations?q=slopes')).data;
  assert.ok(found.items.some((g) => g.id === done.id && g.kind === 'video'));

  // Deleting removes the copies in the library, not the project's own build.
  assert.equal((await j('DELETE', `/api/generations/${done.id}`)).status, 200);
  for (const ext of ['mp4', 'srt', 'vtt']) assert.equal(fs.existsSync(store.videoPath(done.id, ext)), false);
  assert.ok(fs.existsSync(path.join(videoDir, 'projects', 'demo', 'build', 'demo.mp4')));
});

test('a failed build shows its error line and can be retried', async () => {
  const { data } = await j('POST', '/api/videos', { project: 'broken' });
  const failed = await waitFor(data.generation.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'The video build failed. error: rendering Intro failed; see the manimgl output above');
  assert.equal((await j('POST', `/api/generations/${failed.id}/retry`)).status, 200);
  assert.equal((await waitFor(failed.id)).status, 'error');
});

test('cancelling a build kills everything it started', async () => {
  const { data } = await j('POST', '/api/videos', { project: 'slow' });
  const id = data.generation.id;
  const pidFile = path.join(videoDir, 'projects', 'slow', 'build', 'grandchild.pid');
  const t0 = Date.now();
  while (!fs.existsSync(pidFile) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  await j('POST', `/api/generations/${id}/cancel`);
  assert.equal((await waitFor(id)).status, 'cancelled');
  const t1 = Date.now();
  while (alive(pid) && Date.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(pid), false);
});

test('stopping the runner (server shutdown) kills a running build', async () => {
  const pidFile = path.join(videoDir, 'projects', 'slow', 'build', 'grandchild.pid');
  fs.rmSync(pidFile, { force: true });
  const { data } = await j('POST', '/api/videos', { project: 'slow' });
  const t0 = Date.now();
  while (!fs.existsSync(pidFile) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  runner.stop();
  const t1 = Date.now();
  while (alive(pid) && Date.now() - t1 < 2000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(pid), false);
  await waitFor(data.generation.id);
});

test('rejects unknown, unsafe and empty projects', async () => {
  assert.equal((await j('POST', '/api/videos', { project: 'nope' })).status, 404);
  assert.equal((await j('POST', '/api/videos', { project: '../demo' })).status, 404);
  assert.equal((await j('POST', '/api/videos', { project: 'empty' })).status, 400);
  const odd = await j('POST', '/api/videos', { project: 'demo', quality: 'ultra' });
  assert.equal(odd.data.generation.settings.quality, 'default');
  await waitFor(odd.data.generation.id);
});

test('a library from before videos gains the kind column, and old rows are audio', () => {
  const dir = path.join(dataDir, 'old-library');
  const old = createStore(dir);
  old.db.exec('ALTER TABLE generations DROP COLUMN kind');
  old.db.prepare(
    `INSERT INTO generations (id, title, text, text_hash, config_hash, char_count, word_count, voice_id, model_id,
       settings_json, status, created_at) VALUES ('old', 'Old', 'Hi.', 'h', 'c', 3, 1, 'af_zed', 'kokoro-82m', '{}', 'done', 1)`,
  ).run();
  old.close();
  const reopened = createStore(dir);
  const g = reopened.get('old');
  assert.equal(g.kind, 'audio');
  assert.equal(g.audioUrl, '/api/generations/old/audio');
  assert.equal(g.videoUrl, null);
  reopened.close();
});
