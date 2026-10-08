import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askWriter } from '../writers/index.js';
import { probe, squarePng, textPdf } from '../writers/probe.js';
import { parseJsonAnswer } from '../writers/common.js';
import { contextFor } from '../writers/ollama.js';
import { KIND_CAPS } from '../../shared/providers.js';
import { fakeProviders } from './fake-providers.js';

const LESSON = { title: 'Slope', script: '[intro]\nHello.\n', scenes: 'from manimlib import *\n' };
const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, script: { type: 'string' }, scenes: { type: 'string' } },
  required: ['title', 'script', 'scenes'],
  additionalProperties: false,
};

let fake, dir, secrets;
const config = { claudeTimeoutMs: 20_000, keys: {} };
const writer = (kind, model, extra = {}) => ({
  provider: kind,
  kind,
  label: { openai: 'OpenAI', groq: 'Groq', ollama: 'This Mac: Ollama', anthropic: 'Claude API', local: 'This Mac' }[kind],
  baseUrl: kind === 'ollama' ? fake.url : kind === 'anthropic' ? fake.url : `${fake.url}/v1`,
  model,
  effort: '',
  caps: { ...KIND_CAPS[kind] },
  rate: null,
  ...extra,
});
const ask = (w, extra = {}) => askWriter({ writer: w, secrets, config, system: 'You write lessons.', prompt: 'Write it.', schema: SCHEMA, ...extra });
const last = (url) => fake.requests.filter((r) => r.url === url).at(-1);

before(async () => {
  fake = await fakeProviders({ answer: (seen) => (/ready/.test(seen.text) ? { word: 'ready' } : LESSON) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-writers-'));
  const keys = { openai: 'sk-test-openai-1234', groq: 'gsk_test_12345678', anthropic: 'sk-ant-test-1234' };
  secrets = { get: async (id) => keys[id] || null, kind: 'file' };
});
after(async () => {
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('OpenAI-style: a JSON schema, the key, the effort, and tokens priced at the rate', async () => {
  const w = writer('openai', 'gpt-test', { caps: { ...KIND_CAPS.openai, effort: true }, rate: { input: 1, output: 4, cacheRead: 0.1 } });
  const out = await ask(w, { effort: 'xhigh' });
  assert.deepEqual(out.answer, LESSON);
  const req = last('/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-test-openai-1234');
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.response_format.json_schema.strict, true);
  assert.equal(req.body.reasoning_effort, 'high', 'xhigh maps to the highest OpenAI level');
  assert.equal(out.usage.inputTokens, 1000);
  assert.equal(out.usage.cacheReadTokens, 200);
  assert.equal(out.usage.provider, 'openai');
  assert.equal(out.usage.costKnown, true);
  assert.equal(out.costUsd, (1000 * 1 + 200 * 0.1 + 300 * 4) / 1e6);
});

test('JSON mode puts the schema in the system prompt; an unusable answer is retried once and both are counted', async () => {
  const out = await ask(writer('groq', 'badjson-once', { caps: { ...KIND_CAPS.groq, structured: 'json' } }));
  assert.deepEqual(out.answer, LESSON);
  const calls = fake.requests.filter((r) => r.url === '/v1/chat/completions' && r.body.model === 'badjson-once');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.match(calls[0].body.messages[0].content, /JSON Schema/);
  assert.match(calls[1].body.messages[1].content, /could not be used/);
  assert.equal(out.usage.outputTokens, 600);
  assert.equal(out.costUsd, 0);
  assert.equal(out.usage.costKnown, false, 'no rate: the cost is unknown, not zero');
});

test('limits, cut-off answers and missing keys come back as errors a person can act on', async () => {
  await assert.rejects(ask(writer('groq', 'daily')), (e) => e.kind === 'limit' && /daily limit/.test(e.message));
  const busy = await ask(writer('openai', 'busy'));
  assert.deepEqual(busy.answer, LESSON, 'a 429 is retried after the time asked');
  await assert.rejects(ask(writer('openai', 'cutoff')), (e) => e.kind === 'cut');
  const noKeys = { get: async () => null, kind: 'file' };
  await assert.rejects(askWriter({ writer: writer('anthropic', 'claude-opus-5-5'), secrets: noKeys, config, system: 's', prompt: 'p', schema: SCHEMA }), /has no key/);
  await assert.rejects(ask(writer('local', 'gpt-test', { baseUrl: 'http://127.0.0.1:9/v1' })), (e) => e.kind === 'unreachable');
});

test('Ollama: its own API, with the context length and the schema in each request', async () => {
  const out = await ask(writer('ollama', 'qwen3:8b', { caps: { ...KIND_CAPS.ollama, context: 40960 } }));
  assert.deepEqual(out.answer, LESSON);
  const req = last('/api/chat');
  assert.equal(req.body.stream, false);
  assert.deepEqual(req.body.format, SCHEMA);
  assert.ok(req.body.options.num_ctx >= 16384 && req.body.options.num_ctx % 4096 === 0);
  assert.equal(out.usage.durationMs, 2000);
  assert.equal(contextFor(400_000, 32_768).tooSmall, true);
  await assert.rejects(ask(writer('ollama', 'qwen3:8b', { caps: { ...KIND_CAPS.ollama, context: 4096 } }), { prompt: 'x'.repeat(40_000) }), /needs about/);
});

test('Anthropic: structured output, effort, a cached guide and server-side fallback', async () => {
  const w = writer('anthropic', 'claude-opus-5-5', { rate: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } });
  const png = path.join(dir, 'a.png');
  fs.writeFileSync(png, squarePng());
  const out = await ask(w, { effort: 'medium', attachments: [{ name: 'a.png', kind: 'image', type: 'image/png', path: png }] });
  assert.deepEqual(out.answer, LESSON);
  const req = last('/v1/messages?beta=true') || fake.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1);
  assert.equal(req.headers['x-api-key'], 'sk-ant-test-1234');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.fallbacks, 'default');
  assert.deepEqual(req.body.output_config, { format: { type: 'json_schema', schema: SCHEMA }, effort: 'medium' });
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(req.body.messages[0].content[1].type, 'image');
  assert.equal(out.usage.cacheReadTokens, 6000);
  assert.equal(out.costUsd, (800 * 4 + 6000 * 0.2 + 400 * 20) / 1e6);

  await ask(writer('anthropic', 'claude-haiku-5-5'));
  const haiku = fake.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1);
  assert.equal(haiku.body.fallbacks, undefined, 'Haiku has no server-side fallback');
  await assert.rejects(ask(writer('anthropic', 'cutoff')), (e) => e.kind === 'cut');
});

test('the Test finds what a model can do', async () => {
  const openai = await probe({ provider: { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: `${fake.url}/v1`, needsKey: true }, model: 'gpt-test', key: 'sk-x', config });
  assert.equal(openai.ok, true, openai.error);
  assert.deepEqual(openai.models, ['gpt-test', 'json-only']);
  assert.deepEqual(
    { ...openai.caps['gpt-test'], tokensPerSec: undefined },
    { structured: 'schema', images: true, pdf: true, effort: true, context: 131072, tokensPerSec: undefined },
  );

  const jsonOnly = await probe({ provider: { id: 'groq', kind: 'groq', label: 'Groq', baseUrl: `${fake.url}/v1`, needsKey: true }, model: 'json-only', key: 'gsk', config });
  assert.equal(jsonOnly.caps['json-only'].structured, 'json');
  assert.equal(jsonOnly.caps['json-only'].effort, false);
  assert.equal(jsonOnly.caps['json-only'].pdf, false, 'Groq takes no PDFs');
  assert.ok(jsonOnly.notes.some((n) => /JSON mode/.test(n)));

  const blind = await probe({ provider: { id: 'local', kind: 'local', label: 'This Mac', baseUrl: `${fake.url}/v1`, needsKey: false }, model: 'blind', key: null, config });
  assert.equal(blind.caps.blind.images, false);

  const ollama = await probe({ provider: { id: 'ollama', kind: 'ollama', label: 'Ollama', baseUrl: fake.url, needsKey: false }, model: 'tiny', key: null, config });
  assert.equal(ollama.caps.tiny.context, 4096);
  assert.ok(ollama.notes.some((n) => /context is 4,096/.test(n)));
  assert.ok(ollama.notes.some((n) => /cannot see pictures/.test(n)));

  const nokey = await probe({ provider: { id: 'openai', kind: 'openai', label: 'OpenAI', baseUrl: `${fake.url}/v1`, needsKey: true }, model: '', key: null, config });
  assert.equal(nokey.ok, false);
  assert.match(nokey.error, /no key/);
});

test('answers are read out of fences and thinking', () => {
  assert.deepEqual(parseJsonAnswer('<think>hmm {not this}</think>\n```json\n{"a": "b"}\n```'), { a: 'b' });
  assert.throws(() => parseJsonAnswer('no json here'), (e) => e.kind === 'format');
  assert.ok(textPdf('HELLO').toString('latin1').startsWith('%PDF-1.4'));
});
