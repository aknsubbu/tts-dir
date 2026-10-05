import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, MARK_START } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { EngineError } from '../kokoro.js';

const AUDIO_BYTES = 4000; // size of every fake audio file

let dataDir, store, server, base;
const calls = [];
const flaky = new Set();
let engineState = { status: 'ready', error: null, device: 'test' };

const VOICES = [
  { voiceId: 'af_zed', name: 'Zed', lang: 'a', gender: 'female' },
  { voiceId: 'bm_amy', name: 'Amy', lang: 'b', gender: 'male' },
  { voiceId: 'jf_kana', name: 'Kana', lang: 'j', gender: 'female' },
];
const LANGUAGES = [
  { code: 'a', name: 'American English', available: true, hint: null },
  { code: 'b', name: 'British English', available: true, hint: null },
  { code: 'j', name: 'Japanese', available: false, hint: 'Needs an extra install' },
];

/** Stands in for the Python worker: writes a fixed-size file instead of speaking. */
const engine = {
  start: async () => {
    if (engineState.status === 'error') throw new EngineError(engineState.error, 'not_installed');
  },
  stop() {},
  info: () => engineState,
  catalog: () => ({ voices: VOICES, languages: LANGUAGES, samples: { a: 'Sample.', b: 'Sample.', j: 'Sample.' } }),
  async synthesize({ text, voice, speed, out, onProgress, signal }) {
    calls.push({ text, voice, speed, out });
    if (text.includes('SLOW')) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 400);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new EngineError('Cancelled', 'aborted'));
        });
      });
    }
    if (text.includes('FLAKY') && !flaky.has(text)) {
      flaky.add(text);
      throw new EngineError('The Kokoro worker stopped unexpectedly (exit 9).', 'crashed');
    }
    if (text.includes('BROKEN')) throw new EngineError('Kokoro produced no audio for this text.', 'synthesis');
    const segments = text.split(/\n\s*\n/).length;
    for (let i = 1; i <= segments; i++) onProgress?.(i, segments);
    fs.writeFileSync(out, Buffer.alloc(AUDIO_BYTES, 1));
    return { durationSec: text.length / 15, bytes: AUDIO_BYTES, segments };
  },
};

const j = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
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

const create = (extra = {}) =>
  j('POST', '/api/generations', {
    title: 'Test script',
    text: 'Hello there. This is a test script about graph algorithms.',
    voiceId: 'af_zed',
    settings: {},
    ...extra,
  });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-studio-test-'));
  store = createStore(dataDir);
  const getConfig = () => ({ defaultVoiceId: 'af_zed', envFile: null });
  const runner = createRunner({ store, engine });
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

test('health and voices', async () => {
  const health = (await j('GET', '/api/health')).data;
  assert.equal(health.engine.status, 'ready');
  assert.equal(health.defaultVoiceId, 'af_zed');
  const { voices, languages } = (await j('GET', '/api/voices')).data;
  assert.deepEqual(voices.map((v) => v.voiceId), ['af_zed', 'bm_amy', 'jf_kana']);
  assert.equal(languages.find((l) => l.code === 'j').available, false);
  assert.equal((await j('GET', '/api/models')).status, 404); // ElevenLabs-era routes are gone
  assert.equal((await j('GET', '/api/subscription')).status, 404);
});

test('voice previews are rendered once and then served from disk', async () => {
  const before = calls.length;
  const [a, b] = await Promise.all([fetch(base + '/api/voices/bm_amy/preview'), fetch(base + '/api/voices/bm_amy/preview')]);
  assert.equal(a.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await a.arrayBuffer()).byteLength, AUDIO_BYTES);
  assert.equal(b.status, 200);
  await b.arrayBuffer();
  assert.equal((await fetch(base + '/api/voices/bm_amy/preview')).status, 200);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).voice, 'bm_amy');
  assert.equal((await fetch(base + '/api/voices/zz_nobody/preview')).status, 404);
});

test('generates audio end to end and serves it with Range support', async () => {
  const { status, data } = await create();
  assert.equal(status, 201);
  assert.equal(data.duplicate, false);
  const done = await waitFor(data.generation.id);
  assert.equal(done.status, 'done');
  assert.equal(done.progressDone, done.progressTotal);
  assert.equal(done.audioBytes, AUDIO_BYTES);
  assert.ok(done.durationSec > 0);
  assert.equal(done.voiceName, 'Zed'); // filled in from the voice catalog
  assert.equal(done.modelId, 'kokoro-82m');
  assert.equal(done.text.startsWith('Hello there'), true);

  const audio = await fetch(base + done.audioUrl);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await audio.arrayBuffer()).byteLength, AUDIO_BYTES);

  const ranged = await fetch(base + done.audioUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const dl = await fetch(base + done.audioUrl + '?download=1');
  assert.match(dl.headers.get('content-disposition'), /test-script\.mp3/);

  const call = calls.at(-1);
  assert.equal(call.voice, 'af_zed');
  assert.equal(call.speed, 1);
  assert.equal(fs.existsSync(call.out), false); // the temp file was moved into place
});

test('settings are reduced to what Kokoro supports', async () => {
  const { data } = await create({ title: 'Fast', text: 'Speed **test**.', settings: { speed: 9, stability: 0.2, stripMarkdown: false } });
  const done = await waitFor(data.generation.id);
  assert.deepEqual(done.settings, { speed: 2, stripMarkdown: false });
  assert.equal(calls.at(-1).speed, 2);
  assert.equal(calls.at(-1).text, 'Speed **test**.');
});

test('identical request is deduplicated unless forced', async () => {
  const first = await create({ title: 'Dedupe me', text: 'Dedupe text number one.' });
  await waitFor(first.data.generation.id);
  const again = await create({ title: 'Dedupe me', text: 'Dedupe text number one.' });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.generation.id, first.data.generation.id);
  const forced = await create({ title: 'Dedupe me', text: 'Dedupe text number one.', force: true });
  assert.equal(forced.status, 201);
  assert.notEqual(forced.data.generation.id, first.data.generation.id);
  await waitFor(forced.data.generation.id);
  // a different voice is a different config
  const other = await create({ title: 'Dedupe me', text: 'Dedupe text number one.', voiceId: 'bm_amy' });
  assert.equal(other.status, 201);
  await waitFor(other.data.generation.id);
});

test('long scripts report progress and are sent to the engine cleaned, in one piece', async () => {
  const para = (n) => `## Paragraph ${n}\n\n` + 'Words keep on flowing here. '.repeat(40);
  const text = [1, 2, 3, 4].map(para).join('\n\n');
  const before = calls.length;
  const { data } = await create({ title: 'Long one', text });
  const done = await waitFor(data.generation.id);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).text.includes('#'), false);
  assert.equal(done.progressTotal, 8);
  assert.equal(done.progressDone, 8);
});

test('full-text search with snippets, filters, tags, favorites and sorting', async () => {
  const a = await create({ title: 'Quantum notes', text: 'Entanglement and superposition explained simply for beginners.' });
  const b = await create({ title: 'Cooking intro', text: 'Chop the onions and simmer the tomatoes slowly.', tags: ['food'] });
  await waitFor(a.data.generation.id);
  await waitFor(b.data.generation.id);

  const hit = (await j('GET', '/api/generations?q=superpos')).data;
  assert.equal(hit.total, 1);
  assert.equal(hit.items[0].id, a.data.generation.id);
  assert.ok(hit.items[0].snippet.includes(MARK_START));

  // stemming: "simmering" finds "simmer"
  assert.equal((await j('GET', '/api/generations?q=simmering')).data.total, 1);
  // title match
  assert.equal((await j('GET', '/api/generations?q=quantum')).data.total, 1);
  // nothing
  assert.equal((await j('GET', '/api/generations?q=zzzzqqq')).data.total, 0);
  // hostile input does not break the query
  assert.equal((await j('GET', '/api/generations?q=' + encodeURIComponent('"); DROP TABLE x; --'))).status, 200);

  // tags and favorites
  const patched = await j('PATCH', `/api/generations/${a.data.generation.id}`, { tags: 'Physics, Intro Level', favorite: true, title: 'Quantum notes v2' });
  assert.deepEqual(patched.data.tags, ['physics', 'intro-level']);
  assert.equal(patched.data.favorite, true);
  assert.equal((await j('GET', '/api/generations?tag=physics')).data.total, 1);
  assert.equal((await j('GET', '/api/generations?favorite=1')).data.items.every((i) => i.favorite), true);
  // the search index follows edits
  assert.equal((await j('GET', '/api/generations?q=physics')).data.total, 1);
  assert.equal((await j('GET', '/api/generations?q=v2')).data.total, 1);
  const tags = (await j('GET', '/api/tags')).data.tags.map((t) => t.tag);
  assert.ok(tags.includes('food') && tags.includes('physics'));

  // voice filter + sort
  const amy = (await j('GET', '/api/generations?voiceId=bm_amy')).data;
  assert.ok(amy.total >= 1 && amy.items.every((i) => i.voiceId === 'bm_amy'));
  const titles = (await j('GET', '/api/generations?sort=title&limit=100')).data.items.map((i) => i.title.toLowerCase());
  assert.deepEqual(titles, [...titles].sort());
  assert.equal((await j('GET', '/api/generations?limit=2')).data.items.length, 2);
});

test('card previews are readable (markdown stripped, whitespace collapsed)', async () => {
  const { data } = await create({ title: 'Md', text: '# Heading\n\nSome **bold** text\n\n- a bullet' });
  await waitFor(data.generation.id);
  const item = (await j('GET', '/api/generations?q=bullet')).data.items[0];
  assert.equal(item.preview, 'Heading Some bold text a bullet');
});

test('a worker crash mid-job is retried once', async () => {
  const { data } = await create({ title: 'Flaky', text: 'FLAKY service test one.' });
  const done = await waitFor(data.generation.id);
  assert.equal(done.status, 'done');
});

test('synthesis errors surface a readable message and can be retried', async () => {
  const { data } = await create({ title: 'Broken', text: 'BROKEN voice test.' });
  const failed = await waitFor(data.generation.id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /produced no audio/);
  const retried = await j('POST', `/api/generations/${failed.id}/retry`);
  assert.equal(retried.status, 200);
  const again = await waitFor(failed.id);
  assert.equal(again.status, 'error'); // still broken, but the retry ran
  assert.equal((await j('POST', `/api/generations/${failed.id}/retry`)).status, 200);
  await waitFor(failed.id);
});

test('a queued job can be cancelled and retry only applies to failed jobs', async () => {
  const slow = await create({ title: 'Slow', text: 'SLOW job number one.' });
  const queued = await create({ title: 'Queued', text: 'This one waits behind the slow job.' });
  const cancelled = await j('POST', `/api/generations/${queued.data.generation.id}/cancel`);
  assert.equal(cancelled.data.status, 'cancelled');
  await waitFor(slow.data.generation.id);
  assert.equal((await j('GET', `/api/generations/${queued.data.generation.id}`)).data.status, 'cancelled');
  assert.equal((await j('POST', `/api/generations/${slow.data.generation.id}/retry`)).status, 409);
});

test('a running job can be cancelled mid-flight', async () => {
  const slow = await create({ title: 'Slow two', text: 'SLOW job number two, to be cancelled.' });
  await waitFor(slow.data.generation.id, ['processing']);
  await j('POST', `/api/generations/${slow.data.generation.id}/cancel`);
  const end = await waitFor(slow.data.generation.id);
  assert.equal(end.status, 'cancelled');
  assert.equal(fs.existsSync(store.audioPath(slow.data.generation.id)), false);
});

test('validation errors', async () => {
  assert.equal((await create({ text: '   ' })).status, 400);
  assert.equal((await create({ voiceId: 'bad id!' })).status, 400);
  assert.equal((await create({ voiceId: 'af_nobody' })).status, 400); // not in the catalog
  const ja = await create({ voiceId: 'jf_kana' }); // language not installed
  assert.equal(ja.status, 400);
  assert.match(ja.data.error, /Japanese/);
  assert.equal((await create({ text: '```only code```' })).status, 400);
  assert.equal((await j('GET', '/api/generations/nope')).status, 404);
  assert.equal((await j('PATCH', '/api/generations/nope', { title: 'x' })).status, 404);
  assert.equal((await j('GET', '/api/does-not-exist')).status, 404);
});

test('a missing Kokoro install is reported clearly', async () => {
  const ready = engineState;
  engineState = { status: 'error', error: 'Kokoro is not installed yet. Run `npm run setup` in the tts-studio folder.', device: null };
  assert.equal((await j('GET', '/api/health')).data.engine.status, 'error');
  const r = await create({ text: 'No engine here.' });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /npm run setup/);
  const voices = await j('GET', '/api/voices');
  assert.equal(voices.status, 503);
  assert.match(voices.data.error, /npm run setup/);
  engineState = ready;
});

test('stats and delete (removes the file and the search entry)', async () => {
  const before = (await j('GET', '/api/stats')).data;
  assert.ok(before.files >= 5);
  assert.ok(before.chars > 0 && before.seconds > 0);
  assert.ok(before.voices.some((v) => v.voiceId === 'af_zed' && v.name === 'Zed'));

  const { data } = await create({ title: 'To delete', text: 'Ephemeral unicorn script.' });
  await waitFor(data.generation.id);
  const file = store.audioPath(data.generation.id);
  assert.equal(fs.existsSync(file), true);
  assert.equal((await j('GET', '/api/generations?q=unicorn')).data.total, 1);
  assert.equal((await j('DELETE', `/api/generations/${data.generation.id}`)).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await j('GET', '/api/generations?q=unicorn')).data.total, 0);
  assert.equal((await j('GET', `/api/generations/${data.generation.id}`)).status, 404);
});

test('script download and restart recovery', async () => {
  const { data } = await create({ title: 'Script dl', text: 'Original *script* text.' });
  await waitFor(data.generation.id);
  const res = await fetch(base + `/api/generations/${data.generation.id}/script?download=1`);
  assert.equal(await res.text(), 'Original *script* text.'); // original text, not the cleaned version
  assert.match(res.headers.get('content-disposition'), /script-dl\.txt/);

  store.update(data.generation.id, { status: 'processing' });
  assert.ok(store.markInterrupted() >= 1);
  const row = store.get(data.generation.id);
  assert.equal(row.status, 'error');
  assert.match(row.error, /restart/i);
});
