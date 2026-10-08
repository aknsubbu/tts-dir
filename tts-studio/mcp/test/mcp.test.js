import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../server/db.js';
import { createRunner } from '../../server/runner.js';
import { createApp } from '../../server/app.js';
import { createLessons } from '../../server/lessons.js';
import { createVideoBuilder } from '../../server/video.js';
import { createVersions } from '../../server/versions.js';
import { createSecrets } from '../../server/secrets.js';
import { createSettings } from '../../server/settings.js';
import { createAuthorApp } from '../../author/app.js';
import { answer, sandbox, SCRIPT, scenes, until } from '../../author/test/fakes.js';
import { squarePng } from '../../author/writers/probe.js';
import { createMcpServer } from '../server.js';
import { mcpHandler } from '../http.js';
import { checkPath } from '../files.js';

/** The connector against the real dashboard, with the fake writer and the fake build. */
const FAKE_BUILD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root] = process.argv.slice(2);
const name = path.basename(root);
const build = path.join(root, 'build');
fs.mkdirSync(build, { recursive: true });
for (const [ext, body] of [['mp4', 'MP4'], ['srt', '1\\n'], ['vtt', 'WEBVTT\\n\\n00:00.000 --> 00:01.000\\nHello\\n'], ['jpg', 'JPG']]) fs.writeFileSync(path.join(build, name + '.' + ext), body);
fs.writeFileSync(path.join(build, 'build.json'), JSON.stringify({ duration: 61.5 }));
for (const ext of ['mp4', 'srt', 'vtt', 'jpg']) console.log(path.join(build, name + '.' + ext));
`;
const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({
    voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a', gender: 'female' }, { voiceId: 'ef_dora', name: 'Dora', lang: 'e' }],
    languages: [{ code: 'a', name: 'American English', available: true }, { code: 'e', name: 'Spanish', available: true }],
    samples: {},
  }),
};

let dir, box, store, lessons, server, authorServer, authorApp, base, client, settings;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mcp-'));
  box = sandbox(dir);
  const buildBin = path.join(dir, 'fake-build.js');
  fs.writeFileSync(buildBin, FAKE_BUILD, { mode: 0o755 });
  const config = { ...box.config, videoBuild: [buildBin], defaultVoiceId: 'af_zed', dataDir: path.join(dir, 'data'), keys: {}, given: {}, claudeReadEffort: 'medium', claudeOutlineEffort: 'medium', lessonReview: 'render' };
  const getConfig = () => config;
  authorApp = createAuthorApp({ getConfig });
  await new Promise((resolve) => {
    authorServer = authorApp.listen(0, '127.0.0.1', resolve);
  });
  config.authorUrl = `http://127.0.0.1:${authorServer.address().port}`;
  store = createStore(config.dataDir);
  const versions = createVersions({ store, getConfig });
  const secrets = createSecrets({ dataDir: config.dataDir, useKeychain: false });
  settings = createSettings({ db: store.db, getConfig, secrets });
  const runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig }), versions });
  lessons = createLessons({ store, runner, getConfig, versions, settings, pollMs: 20 });
  const app = createApp({ getConfig, store, runner, engine, lessons, versions, settings, secrets, mcp: mcpHandler() });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const mcp = createMcpServer({ baseUrl: base, cwd: dir, waitMs: 3000, pollMs: 20 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
});

after(async () => {
  await client?.close();
  lessons.stop();
  authorApp.stop();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => authorServer.close(resolve));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const said = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('the tools are listed, read-only ones marked', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['approve_lesson', 'cancel_lesson', 'get_lesson', 'get_settings', 'get_video', 'lesson_status', 'list_voices', 'make_lesson', 'redo_outline', 'retry_lesson', 'revise_lesson', 'search_lessons', 'test_writer', 'update_settings', 'wait_for_lesson']);
  assert.equal(tools.find((t) => t.name === 'wait_for_lesson').annotations.readOnlyHint, true);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ['explain']);
});

test('make a lesson from notes and a photo, follow it, and get the video', async () => {
  box.answers([answer()]);
  fs.writeFileSync(path.join(dir, 'working.md'), 'dL/dw = (y_hat - y) x');
  fs.writeFileSync(path.join(dir, 'board.png'), squarePng());
  const made = await call('make_lesson', { topic: 'Gradient of the squared error', notes: 'L = 1/2 (y_hat - y)^2', files: ['working.md', path.join(dir, 'board.png')], minutes: 1, quality: 'low' });
  assert.ok(!made.isError, said(made));
  const id = made.structuredContent.id;
  assert.match(said(made), /Call wait_for_lesson/);
  assert.match(made.structuredContent.link, /\/#lesson\//);

  const g = (await (await fetch(`${base}/api/generations/${id}`)).json());
  assert.equal(g.settings.lesson.profile, 'claude', "a lesson Claude starts uses Claude's settings");
  assert.deepEqual(g.settings.lesson.attachments.map((a) => a.kind), ['image']);

  let last = made.structuredContent;
  const stages = [];
  await until(async () => {
    const r = await call('wait_for_lesson', { id, since: last.stage || last.status });
    last = r.structuredContent;
    stages.push(last.stage || last.status);
    return ['done', 'error'].includes(last.status);
  }, 20_000);
  assert.equal(last.status, 'done', last.error);
  assert.match(box.asked()[0].stdin, /# From working\.md\n\ndL\/dw = \(y_hat - y\) x/, 'text files join the notes');
  assert.deepEqual(box.asked()[0].blocks.map((b) => b.type), ['image'], 'the photo is attached');

  const video = await call('get_video', { id });
  assert.match(said(video), /Video: .*\.mp4/);
  assert.ok(fs.existsSync(video.structuredContent.files.video));
  assert.ok(video.content.some((c) => c.type === 'image' && c.mimeType === 'image/jpeg'), 'the poster as an image');

  const found = await call('search_lessons', { query: 'slope' });
  assert.equal(found.structuredContent.total, 1);
  const lesson = await call('get_lesson', { id });
  assert.match(said(lesson), /scenes\.py:\nfrom manimlib import \*/);
  const resource = await client.readResource({ uri: `lesson://${id}/captions` });
  assert.match(resource.contents[0].text, /WEBVTT/);

  // A change, narrowed to a scene, through the connector.
  box.answers([{ summary: 'Slower', blocks: [{ id: 'intro', text: 'Every line has a slope, slowly.', after: '' }], remove_blocks: [], classes: [], remove_classes: [], preamble: '', whole_script: '', whole_scenes: '' }]);
  const revising = await call('revise_lesson', { id, request: 'Slow it down', scene: 'Intro' });
  assert.ok(!revising.isError, said(revising));
  const revised = await until(async () => {
    const r = await call('lesson_status', { id });
    return ['done', 'error'].includes(r.structuredContent.status) && r.structuredContent.version === 2 ? r.structuredContent : null;
  }, 20_000);
  assert.equal(revised.lastRevision.summary, 'Slower');
  assert.match(box.asked().at(-1).stdin, /about the scene Intro/);
});

test('a long lesson: its outline waits for the person, is changed, approved, and written in chapters', async () => {
  const OUTLINE = {
    title: 'Backpropagation',
    through_line: 'Why it is cheap',
    notation: [{ tex: 'w', meaning: 'weights', color: 'BLUE' }],
    chapters: [
      { id: 'one-neuron', title: 'One neuron', minutes: 5, goal: 'g', covers: ['a'], from_notes: '', files: [], starts_from: '', ends_with: '' },
      { id: 'chain', title: 'The chain rule', minutes: 5, goal: 'g', covers: ['b'], from_notes: '', files: [], starts_from: '', ends_with: '' },
    ],
  };
  const follow = async (id) => {
    for (let i = 0; i < 30; i += 1) {
      const r = await call('wait_for_lesson', { id });
      if (['awaiting', 'done', 'error', 'cancelled'].includes(r.structuredContent.status)) return r;
    }
    throw new Error('the lesson did not settle');
  };
  box.answers([OUTLINE]);
  const made = await call('make_lesson', { topic: 'Backprop', minutes: 10, quality: 'low' });
  assert.ok(!made.isError, said(made));
  assert.match(said(made), /for an outline and about 3 chapters/);
  const id = made.structuredContent.id;
  const waiting = await follow(id);
  assert.equal(waiting.structuredContent.status, 'awaiting', said(waiting));
  assert.match(waiting.structuredContent.waitingOn, /outline/);
  assert.match(said(waiting), /The outline is written \(2 chapters\)/);

  const got = await call('get_lesson', { id });
  assert.match(said(got), /Outline \(waiting for the person to approve it\)/);
  const { outline } = got.structuredContent;
  assert.deepEqual(outline.chapters.map((c) => c.id), ['01-one-neuron', '02-chain']);

  box.answers([{ title: 'Chains', script: SCRIPT, scenes: scenes() }, { title: 'One neuron', script: SCRIPT, scenes: scenes() }]);
  const approved = await call('approve_lesson', { id, outline: { ...outline, chapters: [{ ...outline.chapters[1], title: 'Chains' }, outline.chapters[0]] } });
  assert.match(said(approved), /Outline approved: the chapters are being written/);
  const done = await follow(id);
  assert.equal(done.structuredContent.status, 'done', said(done));
  assert.deepEqual(done.structuredContent.chapters.map((c) => [c.id, c.title]), [['02-chain', 'Chains'], ['01-one-neuron', 'One neuron']]);
  const second = await call('get_lesson', { id, chapter: '01-one-neuron' });
  assert.match(said(second), /Chapter 01-one-neuron \(of 02-chain, 01-one-neuron\)/);
});

test('files from private folders, of the wrong kind, or missing are refused', async () => {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'KEY');
  assert.throws(() => checkPath(path.join(home, '.ssh', 'id_ed25519'), { home }), /where keys and private data are kept/);
  fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(dir, 'innocent.txt'));
  assert.throws(() => checkPath(path.join(dir, 'innocent.txt'), { home }), /where keys/, 'a link into a private folder is followed');
  // A private folder that links elsewhere, as dotfiles managers make them, is still private.
  fs.mkdirSync(path.join(dir, 'dotfiles', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dotfiles', 'config', 'token.txt'), 'SECRET');
  fs.symlinkSync(path.join(dir, 'dotfiles', 'config'), path.join(home, '.config'));
  assert.throws(() => checkPath(path.join(home, '.config', 'token.txt'), { home }), /where keys/, 'a linked ~/.config');
  fs.symlinkSync(dir, path.join(dir, 'through-a-link'));
  assert.throws(() => checkPath(path.join(dir, 'through-a-link', 'home', '.ssh', 'id_ed25519'), { home: path.join(dir, 'through-a-link', 'home') }), /where keys/, 'a home reached through a link');
  fs.writeFileSync(path.join(dir, 'sheet.xlsx'), 'x');
  const wrong = await call('make_lesson', { topic: 'x', files: ['sheet.xlsx'] });
  assert.equal(wrong.isError, true);
  assert.match(said(wrong), /not a kind of file/);
  const missing = await call('make_lesson', { topic: 'x', files: ['nope.pdf'] });
  assert.match(said(missing), /There is no file/);
});

test("settings: Claude sees no keys, changes its own writer, and cannot raise the cap", async () => {
  await settings.setKey('groq', 'gsk_secret_value_1234');
  const got = await call('get_settings');
  assert.ok(!JSON.stringify(got).includes('gsk_secret_value'));
  assert.equal(got.structuredContent.providers.find((p) => p.id === 'groq').setUp, true);

  const ok = await call('update_settings', { writer: { sameAsPage: false, plan: { mode: 'steps', steps: { fix: { provider: 'groq', model: 'llama-4' } } } }, defaults: { quality: 'medium' } });
  assert.ok(!ok.isError, said(ok));
  assert.match(said(ok), /can undo this in Settings/);
  assert.equal(settings.resolveWriter('claude').steps.fix.provider, 'groq');
  assert.equal(settings.resolveWriter('page').steps.fix.provider, 'claude-code');
  assert.equal(settings.history()[0].by, 'claude');

  const raise = await call('update_settings', { lessonCapUsd: 500 });
  assert.equal(raise.isError, true);
  assert.match(said(raise), /never raise/);
  const unset = await call('update_settings', { writer: { plan: { all: { provider: 'openai' } } } });
  assert.match(said(unset), /OpenAI is not set up/);
});

test('when the dashboard is down, every tool says how to start it', async () => {
  const lonely = createMcpServer({ baseUrl: 'http://127.0.0.1:9' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await lonely.connect(b);
  const c = new Client({ name: 't', version: '1' });
  await c.connect(a);
  const r = await c.callTool({ name: 'lesson_status', arguments: { id: 'x' } });
  assert.equal(r.isError, true);
  assert.match(said(r), /not running at http:\/\/127\.0\.0\.1:9\. Start it with `npm start`/);
  await c.close();
});

test('over HTTP at /mcp, behind the same local-only checks', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const http = new Client({ name: 'http-test', version: '1' });
  await http.connect(transport);
  const { tools } = await http.listTools();
  assert.ok(tools.some((t) => t.name === 'make_lesson'));
  const voices = await http.callTool({ name: 'list_voices', arguments: {} });
  assert.deepEqual(voices.structuredContent.voices.map((v) => v.id), ['af_zed'], 'English voices only');
  await http.close();

  const post = (headers) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
});

test('over stdio, as the desktop app runs it', async () => {
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../stdio.js', import.meta.url))],
    env: { ...process.env, NARRATED_PROOFS_URL: base },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'stdio-test', version: '1' });
  await c.connect(stdio);
  const r = await c.callTool({ name: 'lesson_status', arguments: { id: 'no-such-lesson' } });
  assert.equal(r.isError, true);
  assert.match(said(r), /Not found/);
  await c.close();
});

test('the dashboard refuses a lesson whose writer is not ready, or over the monthly cap', async () => {
  const post = (body) => fetch(`${base}/api/lessons`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Limits', ...body }) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const noKey = await post({ writer: { provider: 'openai', model: 'gpt-x' } });
  assert.equal(noKey.status, 400);
  assert.match(noKey.data.error, /OpenAI, chosen for “Reading your notes”, has no key/);
  await settings.patch({ costs: { monthCapUsd: 0 } });
  const capped = await post({});
  assert.equal(capped.status, 400);
  assert.match(capped.data.error, /monthly cap of \$0\.00/);
  await settings.patch({ costs: { monthCapUsd: null } });
});
