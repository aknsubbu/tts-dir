import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createSecrets, describe as describeKey, keyFor } from '../secrets.js';
import { createSettings, DEFAULTS } from '../settings.js';
import { createApp } from '../app.js';
import { estimateLesson } from '../estimate.js';

let dir, store, secrets, settings, config, server, base;

const baseConfig = () => ({
  port: 0,
  dataDir: dir,
  videoDir: path.join(dir, 'video'),
  defaultVoiceId: 'af_heart',
  claudeModel: '',
  claudeEffort: 'high',
  claudeFixEffort: 'low',
  claudePolishEffort: 'medium',
  claudeReadEffort: 'medium',
  claudeOutlineEffort: 'medium',
  lessonReview: 'render',
  authorVisualReview: false,
  lessonCapUsd: null,
  keys: {},
  given: {},
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-settings-'));
  store = createStore(dir);
  config = baseConfig();
  secrets = createSecrets({ dataDir: dir, useKeychain: false });
  settings = createSettings({ db: store.db, getConfig: () => config, secrets });
  const engine = { info: () => ({ status: 'ready' }), catalog: () => ({ voices: [], languages: [] }), start: async () => {} };
  const app = createApp({ getConfig: () => config, store, runner: { enqueue() {}, cancel: () => false }, engine, lessons: null, settings, secrets });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  config = baseConfig();
  store.db.exec('DELETE FROM settings; DELETE FROM settings_history;');
  fs.rmSync(path.join(dir, 'secrets.json'), { force: true });
});

const j = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const asClaude = { 'X-Narrated-Proofs-Actor': 'claude' };
const pass = (id, model, caps = {}) => settings.recordTest(id, { ok: true, at: Date.now(), model, models: [model], caps: { [model]: { structured: 'schema', images: false, pdf: false, ...caps } } });

test('a fresh install writes every step with Claude Code at the configured efforts', () => {
  const w = settings.resolveWriter('page');
  for (const step of ['read', 'write', 'fix', 'polish', 'outline']) assert.equal(w.steps[step].provider, 'claude-code');
  assert.deepEqual(
    Object.fromEntries(Object.entries(w.steps).map(([k, s]) => [k, s.effort])),
    { read: 'medium', write: 'high', fix: 'low', polish: 'medium', outline: 'medium' },
  );
  assert.equal(w.steps.write.rate, null, 'Claude Code reports its own cost');
  assert.deepEqual(settings.whereNotesGo(w), [{ where: 'Anthropic', steps: ['reading your notes', 'writing the lesson', 'fixing and polishing'], local: false }]);
});

test('a step left on its default effort follows the environment; an environment value wins over a chosen one', async () => {
  await settings.patch({ 'writer.page': { mode: 'steps', steps: { fix: { provider: 'claude-code', effort: 'medium' } } } });
  assert.equal(settings.resolveWriter().steps.fix.effort, 'medium');
  config.given = { TTS_CLAUDE_FIX_EFFORT: true };
  config.claudeFixEffort = 'low';
  assert.equal(settings.resolveWriter().steps.fix.effort, 'low');
  assert.equal(settings.locks()['effort.fix'], 'TTS_CLAUDE_FIX_EFFORT');
});

test('values set in the environment are locked, for you and for Claude', async () => {
  config.given = { TTS_LESSON_REVIEW: true };
  config.lessonReview = 'storyboard';
  assert.equal(settings.lessonDefaults().review, 'storyboard');
  await assert.rejects(settings.patch({ 'lesson.defaults': { review: 'render' } }), /set by TTS_LESSON_REVIEW/);
  await settings.patch({ 'lesson.defaults': { minutes: 3 } });
  assert.equal(settings.lessonDefaults().minutes, 3);
});

test('every change is kept with who made it, and the last one can be undone', async () => {
  await settings.patch({ 'lesson.defaults': { quality: 'medium' } });
  await settings.patch({ 'claude.defaults': { minutes: 5 } });
  const [latest, first] = settings.history();
  assert.equal(latest.by, 'you');
  assert.match(latest.summary, /length: 2 → 5/);
  assert.match(first.summary, /quality: default → medium/);
  settings.undo();
  assert.equal(settings.get('claude.defaults').minutes, 2);
  settings.undo();
  assert.equal(settings.get('lesson.defaults').quality, 'default');
  assert.throws(() => settings.undo(), /nothing to undo/);
});

test('a change cannot be undone on its own once the setting has moved on', async () => {
  await settings.patch({ 'lesson.defaults': { quality: 'medium' } });
  const { seq } = settings.history()[0];
  await settings.patch({ 'lesson.defaults': { quality: 'low' } });
  assert.throws(() => settings.undo(seq), /changed since/);
});

test('Claude may choose among providers that are set up, and only those', async () => {
  await assert.rejects(settings.patch({ 'writer.claude': { same: false, plan: { all: { provider: 'groq', model: 'llama' } } } }, { by: 'claude' }), /Groq is not set up/);
  await settings.setKey('groq', 'gsk_testkey_123456');
  await settings.patch({ 'writer.claude': { same: false, plan: { all: { provider: 'groq', model: 'llama' } } } }, { by: 'claude' });
  const w = settings.resolveWriter('claude');
  assert.equal(w.steps.write.provider, 'groq');
  assert.equal(w.steps.write.model, 'llama');
  assert.equal(settings.resolveWriter('page').steps.write.provider, 'claude-code', "the page's writer is untouched");
  assert.equal(settings.history()[0].by, 'claude');
});

test("Claude cannot change the page's writer, providers, keys, rates or what it is allowed, unless allowed", async () => {
  await assert.rejects(settings.patch({ 'writer.page': { all: { effort: 'low' } } }, { by: 'claude' }), /may not change the writer for lessons started from the page/);
  await assert.rejects(settings.patch({ 'claude.allow': { pageWriter: true } }, { by: 'claude' }), /Only you can change/);
  await assert.rejects(settings.patch({ rates: { 'openai:gpt': { input: 0, output: 0 } } }, { by: 'claude' }), /Only you can change/);
  await assert.rejects(settings.patch({ 'lesson.defaults': { quality: 'low' } }, { by: 'claude' }), /Only you can change/);
  await settings.patch({ 'claude.allow': { effort: false } });
  await assert.rejects(settings.patch({ 'writer.claude': { plan: { all: { effort: 'max' } } } }, { by: 'claude' }), /may not change effort/);
  await settings.patch({ 'claude.allow': { pageWriter: true } });
  await settings.patch({ 'writer.page': { all: { provider: 'claude-code', model: 'claude-sonnet-5-5' } } }, { by: 'claude' });
});

test('Claude can lower a spending cap, never raise or remove one', async () => {
  await settings.patch({ costs: { lessonCapUsd: 5 } }, { by: 'claude' });
  await assert.rejects(settings.patch({ costs: { lessonCapUsd: 8 } }, { by: 'claude' }), /never raise/);
  await assert.rejects(settings.patch({ costs: { lessonCapUsd: null } }, { by: 'claude' }), /never raise/);
  await settings.patch({ costs: { monthCapUsd: 40 } }, { by: 'claude' }); // from no cap to one is lower
  assert.deepEqual(settings.costs(), { lessonCapUsd: 5, monthCapUsd: 40 });
  await settings.patch({ costs: { lessonCapUsd: 20 } }); // you can
  assert.equal(settings.costs().lessonCapUsd, 20);
});

test('"This Mac" providers stay on this Mac; others are added under Other', async () => {
  await assert.rejects(settings.saveProvider('ollama', { baseUrl: 'http://10.0.0.5:11434' }), /runs on this Mac/);
  await settings.saveProvider('ollama', { baseUrl: 'http://localhost:11500/' });
  assert.equal(settings.provider('ollama').baseUrl, 'http://localhost:11500');
  await assert.rejects(settings.saveProvider('openai', { baseUrl: 'https://example.com/v1' }), /always reached at its own address/);
  await assert.rejects(settings.saveProvider('new', { baseUrl: 'https://user:pw@example.com/v1' }), /key field/);
  const id = await settings.saveProvider('new', { baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' });
  assert.equal(id, 'custom-1');
  assert.equal(settings.provider(id).destination, 'the service at https://openrouter.ai/api/v1');
  await settings.patch({ 'writer.page': { mode: 'steps', steps: { fix: { provider: id, model: 'x' } } } });
  await assert.rejects(settings.removeProvider(id), /still uses it/);
  await settings.patch({ 'writer.page': { steps: { fix: { provider: 'claude-code', model: '' } } } });
  await settings.removeProvider(id);
  assert.equal(settings.provider(id), null);
});

test('a key is stored privately, never shown again, and the environment wins', async () => {
  const shown = await settings.setKey('openai', 'sk-test-abcdefgh7c1e');
  assert.deepEqual(shown, { set: true, hint: '…7c1e' });
  const file = path.join(dir, 'secrets.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await keyFor('openai', { config, secrets })).from, 'file');
  config.keys = { openai: 'sk-from-env-0000' };
  assert.deepEqual(await keyFor('openai', { config, secrets }), { key: 'sk-from-env-0000', from: 'env' });
  await assert.rejects(settings.setKey('openai', 'has "quotes" in it'), /does not look like an API key/);
  assert.deepEqual(describeKey(null), { set: false, hint: null });
  assert.match(settings.history()[0].summary, /OpenAI: key added \(…7c1e\)/);
  assert.equal(settings.history()[0].undoable, false);
});

test('a provider not yet set up stops a lesson before it starts, naming the step', async () => {
  await settings.patch({ 'writer.page': { mode: 'steps', steps: { fix: { provider: 'ollama', model: 'qwen3-coder:30b' } } } });
  await assert.rejects(settings.checkWriter(settings.resolveWriter()), /This Mac: Ollama, chosen for “Fixing and polishing”, has not passed its Test/);
  pass('ollama', 'qwen3-coder:30b');
  await settings.checkWriter(settings.resolveWriter());
  const w = settings.resolveWriter();
  assert.deepEqual(w.steps.fix.rate, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'this Mac is free');
  assert.equal(w.steps.polish.provider, 'ollama', 'polishing goes with fixing');
  assert.equal(w.steps.fix.caps.structured, 'schema');
  assert.deepEqual(settings.whereNotesGo(w).map((x) => x.where), ['Anthropic', 'nobody: it runs on this Mac']);
});

test('a lesson can name its own writer, for every step', async () => {
  await settings.setKey('anthropic', 'sk-ant-test-12345678');
  const w = settings.resolveWriter('page', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.equal(w.steps.read.model, 'claude-sonnet-5-5');
  assert.deepEqual(w.steps.write.rate, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.equal(settings.resolveWriter('page', { provider: 'anthropic' }).steps.fix.model, 'claude-opus-5-5', 'its default model');
});

test('the estimate gives a range, free on this Mac, unknown without a rate', () => {
  const cc = estimateLesson(settings.resolveWriter(), { minutes: 2 });
  assert.ok(cc.lowUsd > 0 && cc.highUsd > cc.lowUsd);
  assert.match(cc.note, /plan/);
  pass('ollama', 'qwen3');
  const local = { steps: Object.fromEntries(['read', 'write', 'fix', 'polish', 'outline'].map((s) => [s, { provider: 'ollama', kind: 'ollama', label: 'Ollama', model: 'qwen3', effort: '', rate: { input: 0, output: 0 } }])) };
  assert.equal(estimateLesson(local, { minutes: 2 }).free, true);
  const openai = { steps: Object.fromEntries(['read', 'write', 'fix', 'polish', 'outline'].map((s) => [s, { provider: 'openai', kind: 'openai', label: 'OpenAI', model: 'gpt-x', effort: '', rate: null }])) };
  assert.deepEqual(estimateLesson(openai, { minutes: 2 }).unknown, ['OpenAI · gpt-x']);
  // A long lesson is an outline and its chapters: more per minute than a short one.
  const long = estimateLesson(settings.resolveWriter(), { minutes: 20, notesChars: 8000 });
  assert.equal(long.chapters, 5);
  assert.equal(cc.chapters, null);
  assert.ok(long.lowUsd > cc.lowUsd * 8 && long.tokens > cc.tokens * 8, 'about ten times the work');
});

test('the settings API never sends a key, and gives Claude its limits', async () => {
  await j('PUT', '/api/providers/groq/key', { key: 'gsk_secretvalue_9xyz' });
  const { data } = await j('GET', '/api/settings');
  assert.ok(!JSON.stringify(data).includes('gsk_secretvalue'), 'the key never comes back');
  const groq = data.providers.find((p) => p.id === 'groq');
  assert.deepEqual(groq.key, { set: true, hint: '…9xyz', from: 'file', env: 'GROQ_API_KEY' });
  assert.equal(groq.configured, true);
  assert.deepEqual(Object.keys(data.values).sort(), Object.keys(DEFAULTS).filter((k) => k !== 'providers').sort());

  assert.equal((await j('PUT', '/api/providers/groq/key', { key: 'gsk_other_12345678' }, asClaude)).status, 403);
  assert.equal((await j('PUT', '/api/providers/new', { baseUrl: 'https://evil.example/v1' }, asClaude)).status, 403);
  const raise = await j('PATCH', '/api/settings', { costs: { lessonCapUsd: 99 } }, asClaude);
  assert.equal(raise.status, 403);
  assert.match(raise.data.error, /never raise/);
  assert.equal((await j('POST', '/api/settings/undo', {}, asClaude)).status, 403);

  const ok = await j('PATCH', '/api/settings', { 'claude.defaults': { quality: 'medium' } }, asClaude);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.changed, ['claude.defaults']);
  assert.equal(ok.data.history[0].by, 'claude');
  const undone = await j('POST', '/api/settings/undo', { seq: ok.data.history[0].seq });
  assert.equal(undone.data.values['claude.defaults'].quality, 'default');
});

test('the Test records what it found, per model', async () => {
  const fakeProbe = async ({ model }) => ({ ok: true, at: 1, model, models: ['a', 'b'], caps: { [model]: { structured: 'json', images: model === 'b' } }, notes: [] });
  const { settingsRoutes } = await import('../settings-routes.js');
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', settingsRoutes({ settings, secrets, getConfig: () => config, store, probe: fakeProbe }));
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}/api/providers/local/test`;
  const post = (model) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }).then((r) => r.json());
  await post('a');
  const { provider } = await post('b');
  srv.close();
  assert.equal(provider.configured, true);
  assert.deepEqual(Object.keys(provider.test.caps).sort(), ['a', 'b']);
  assert.equal(settings.capsOf(settings.provider('local'), 'b').images, true);
  assert.equal(settings.capsOf(settings.provider('local'), 'a').images, false);
});

test('connecting Claude shows commands with real paths', async () => {
  const { data } = await j('GET', '/api/connect');
  assert.match(data.http.claudeCode, /^claude mcp add --transport http narrated-proofs http:\/\/localhost:\d+\/mcp$/);
  assert.ok(data.stdio.args[0].endsWith(path.join('mcp', 'stdio.js')));
  assert.equal(data.desktop.entry.mcpServers['narrated-proofs'].command, process.execPath);
});
