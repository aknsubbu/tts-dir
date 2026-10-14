import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../db.js';
import { createApp } from '../app.js';
import { createProfiles } from '../profiles.js';
import { createSecrets, keyAccount, keyFor } from '../secrets.js';
import { createSettings } from '../settings.js';
import { createVersions } from '../versions.js';
import { askWriter } from '../../author/writers/index.js';
import { normalizeWriter } from '../../author/writers/plan.js';

let dir, store, secrets, profiles, factory, config, server, base, ownerId, roomId;
const engine = {
  info: () => ({ status: 'ready' }),
  catalog: () => ({ voices: [{ voiceId: 'af_heart', name: 'Heart', lang: 'a' }], languages: [{ code: 'a', name: 'English', available: true }] }),
  start: async () => {},
};
const lessons = { start: async () => {}, cancel() {}, isWritten: () => false };

function browser() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    },
  };
}

const baseConfig = () => ({
  defaultVoiceId: 'af_heart', claudeModel: '', claudeEffort: 'high', claudeFixEffort: 'low', claudePolishEffort: 'medium', claudeReadEffort: 'medium',
  claudeOutlineEffort: 'medium', lessonReview: 'render', authorVisualReview: false, lessonCapUsd: null, keys: {}, given: {}, maxProfiles: 5, lan: false,
});

let owner, roommate; // two browsers

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-profile-settings-'));
  store = createStore(dir);
  config = { ...baseConfig(), videoDir: path.join(dir, 'video') };
  secrets = createSecrets({ dataDir: dir, useKeychain: false });
  profiles = createProfiles({ db: store.db, dataDir: dir, ipMax: 10_000 });
  ownerId = profiles.owner().id;
  factory = createSettings({ db: store.db, getConfig: () => config, secrets, profiles });
  const app = createApp({ getConfig: () => config, store, runner: { enqueue() {}, cancel: () => false }, engine, lessons, settings: factory, secrets, profiles, versions: createVersions({ store, getConfig: () => config }) });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  owner = browser();
  const made = await owner.call('POST', '/api/profiles', { name: 'Roommate' }); // the Owner, still alone, stays signed in
  roomId = made.data.profile.id;
  roommate = browser();
  await roommate.call('POST', '/api/session', { profileId: roomId });
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pass = (s, id, model) => s.recordTest(id, { ok: true, at: Date.now(), model, models: [model], caps: { [model]: { structured: 'schema', images: false, pdf: false } } });

test('each profile has its own settings, and changing one does not touch the other', async () => {
  assert.equal((await owner.call('PATCH', '/api/settings', { 'lesson.defaults': { minutes: 5, quality: 'medium' }, costs: { monthCapUsd: 40 } })).status, 200);
  const mine = (await owner.call('GET', '/api/settings')).data.values;
  const theirs = (await roommate.call('GET', '/api/settings')).data.values;
  assert.equal(mine['lesson.defaults'].minutes, 5);
  assert.equal(mine.costs.monthCapUsd, 40);
  assert.equal(theirs['lesson.defaults'].minutes, 2);
  assert.equal(theirs.costs.monthCapUsd, null);
  await roommate.call('PATCH', '/api/settings', { 'lesson.defaults': { minutes: 3 }, rates: { 'openai:gpt-x': { input: 1, output: 2 } } });
  assert.equal((await owner.call('GET', '/api/settings')).data.values['lesson.defaults'].minutes, 5);
  assert.deepEqual((await owner.call('GET', '/api/settings')).data.values.rates, {});
});

test('history and undo only touch your own changes', async () => {
  const ownerHistory = (await owner.call('GET', '/api/settings/history')).data.history;
  const roomHistory = (await roommate.call('GET', '/api/settings/history')).data.history;
  assert.ok(ownerHistory.length >= 2 && roomHistory.length >= 2);
  assert.equal(ownerHistory.some((h) => roomHistory.some((r) => r.seq === h.seq)), false, 'no entry is in both');
  // The roommate cannot undo the Owner's change by its number, nor see it in the page.
  const target = ownerHistory.find((h) => h.key === 'lesson.defaults');
  assert.equal((await roommate.call('POST', '/api/settings/undo', { seq: target.seq })).status, 404);
  assert.equal((await owner.call('GET', '/api/settings')).data.values['lesson.defaults'].minutes, 5);
  // An undo with no number undoes your own last change.
  const undone = await roommate.call('POST', '/api/settings/undo', {});
  assert.equal(undone.status, 200);
  assert.equal((await owner.call('GET', '/api/settings')).data.values.costs.monthCapUsd, 40);
});

test('keys are kept per profile, under their own name, and never seen by another profile', async () => {
  assert.equal((await owner.call('PUT', '/api/providers/groq/key', { key: 'gsk_owner_secret_1111' })).status, 200);
  const view = async (b) => (await b.call('GET', '/api/settings')).data.providers.find((p) => p.id === 'groq');
  assert.equal((await view(owner)).key.set, true);
  assert.equal((await view(roommate)).key.set, false);
  assert.equal((await keyFor('groq', { config, secrets, profileId: roomId })).key, null);
  assert.equal((await keyFor('groq', { config, secrets, profileId: ownerId })).key, 'gsk_owner_secret_1111');
  await roommate.call('PUT', '/api/providers/groq/key', { key: 'gsk_room_secret_2222' });
  assert.equal((await keyFor('groq', { config, secrets, profileId: ownerId })).key, 'gsk_owner_secret_1111');
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), [keyAccount(ownerId, 'groq'), keyAccount(roomId, 'groq')].sort());
  assert.ok(!JSON.stringify((await roommate.call('GET', '/api/settings')).data).includes('gsk_'), 'a key never comes back');
  await roommate.call('DELETE', '/api/providers/groq/key');
  assert.equal((await keyFor('groq', { config, secrets, profileId: ownerId })).key, 'gsk_owner_secret_1111', 'removing yours leaves theirs');
});

test("the host's environment keys go to a profile only when the Owner allows it", async () => {
  config.keys = { openai: 'sk-host-env-key-0000' };
  const keyOf = (s) => keyFor('openai', { config, secrets, profileId: s, allowEnv: factory.for(s).perms().keys });
  assert.equal((await keyOf(ownerId)).from, 'env', 'the Owner has it by default');
  assert.equal((await keyOf(roomId)).key, null, 'a new profile does not');
  const seen = (await roommate.call('GET', '/api/settings')).data.providers.find((p) => p.id === 'openai');
  assert.equal(seen.key.set, false);
  assert.equal(seen.key.hostKey, true);
  assert.equal(seen.key.hostKeyAllowed, false);
  assert.equal(seen.configured, false);
  // Only the Owner decides.
  assert.equal((await roommate.call('PATCH', `/api/profiles/${roomId}`, { canUseHostKeys: true })).status, 403);
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostKeys: true })).status, 200);
  assert.equal((await keyOf(roomId)).from, 'env');
  assert.equal((await roommate.call('GET', '/api/settings')).data.providers.find((p) => p.id === 'openai').configured, true);
  // Their own key still comes first.
  await roommate.call('PUT', '/api/providers/openai/key', { key: 'sk-room-own-key-1234' });
  assert.equal((await keyOf(roomId)).key, 'sk-room-own-key-1234');
  await roommate.call('DELETE', '/api/providers/openai/key');
  await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostKeys: false });
  assert.equal((await keyOf(roomId)).key, null);
  config.keys = {};
});

test("a profile cannot use the host's Claude Code sign-in until the Owner allows it", async () => {
  const room = factory.for(roomId);
  await assert.rejects(room.checkWriter(room.resolveWriter('page')), /Owner has not allowed it for your profile/);
  assert.match((await roommate.call('GET', '/api/settings')).data.writerProblem, /Owner has not allowed it/);
  assert.equal((await roommate.call('POST', '/api/providers/claude-code/test', {})).status, 403);
  for (const step of ['read', 'write', 'fix', 'polish', 'outline']) assert.equal(room.resolveWriter('page').steps[step].hostClaude, false, `${step} carries the refusal, so a hand-back writer does too`);
  // The writer itself refuses too, whatever called it.
  // The pipeline rebuilds the plan before using it (normalizeWriter): the refusal and whose keys these are must survive that.
  const inPipeline = normalizeWriter(room.resolveWriter('page'), config);
  assert.equal(inPipeline.steps.write.profileId, roomId);
  assert.equal(inPipeline.steps.write.hostClaude, false);
  assert.equal(inPipeline.steps.write.hostKeys, false);
  await assert.rejects(askWriter({ writer: inPipeline.steps.write, secrets, config, prompt: 'x', schema: {} }), /may not use the Claude Code sign-in/);
  await assert.rejects(askWriter({ writer: { ...inPipeline.steps.write, hostClaude: undefined }, secrets, config, prompt: 'x', schema: {} }), /may not use the Claude Code sign-in/, 'no flag is no');
  await assert.rejects(askWriter({ secrets, config, prompt: 'x', schema: {} }), /no writer to ask/);
  const ownerStep = normalizeWriter(factory.for(ownerId).resolveWriter('page'), config).steps.write;
  assert.deepEqual([ownerStep.profileId, ownerStep.hostClaude, ownerStep.hostKeys], [ownerId, true, true]);
  // And an environment key is not reached through a plan whose profile may not use it.
  config.keys = { openai: 'sk-host-env-key-0000' };
  assert.equal((await keyFor('openai', { config, secrets, profileId: inPipeline.steps.write.profileId, allowEnv: inPipeline.steps.write.hostKeys })).key, null);
  assert.equal((await keyFor('openai', { config, secrets, profileId: ownerStep.profileId, allowEnv: ownerStep.hostKeys })).from, 'env');
  config.keys = {};
  // A model on this Mac needs nothing from the host.
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { all: { provider: 'ollama', model: 'qwen3' } } });
  assert.match((await roommate.call('GET', '/api/settings')).data.writerProblem, /has not passed its Test/);
  pass(room, 'ollama', 'qwen3');
  await room.checkWriter(room.resolveWriter('page'));
  assert.equal((await roommate.call('GET', '/api/settings')).data.writerProblem, null);
  // The Owner has the sign-in, and the profile can have it when allowed.
  await factory.for(ownerId).checkWriter(factory.for(ownerId).resolveWriter('page'));
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { all: { provider: 'claude-code', model: '' } } });
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostClaude: true })).status, 200);
  await room.checkWriter(room.resolveWriter('page'));
  await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostClaude: false });
});

test("the host's Claude Code is refused for every step, even one that is not checked for a key", async () => {
  const room = factory.for(roomId);
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { mode: 'steps', all: { provider: 'ollama', model: 'qwen3' }, steps: { outline: { provider: 'claude-code', model: '' } } } });
  pass(room, 'ollama', 'qwen3');
  await assert.rejects(room.checkWriter(room.resolveWriter('page')), /Owner has not allowed it for your profile/);
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { mode: 'one', all: { provider: 'ollama', model: 'qwen3' } } });
});

test('the House section is the Owner\'s alone', async () => {
  const mine = (await owner.call('GET', '/api/settings')).data;
  assert.deepEqual(mine.house, { maxProfiles: 5, lan: false, sandboxed: false, profileCount: 2 });
  assert.equal((await roommate.call('GET', '/api/settings')).data.house, undefined);
});

test("deleting a profile removes its settings, history and keys, and no one else's", async () => {
  const doomed = (await owner.call('POST', '/api/profiles', { name: 'Doomed' })).data.profile;
  const them = browser();
  await them.call('POST', '/api/session', { profileId: doomed.id });
  await them.call('PUT', '/api/providers/groq/key', { key: 'gsk_doomed_secret_3333' });
  await them.call('PATCH', '/api/settings', { 'lesson.defaults': { minutes: 4 } });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'))[keyAccount(doomed.id, 'groq')]);
  assert.equal((await them.call('DELETE', `/api/profiles/${doomed.id}`, { confirmName: 'doomed' })).status, 200);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  assert.equal(file[keyAccount(doomed.id, 'groq')], undefined);
  assert.ok(file[keyAccount(ownerId, 'groq')], "the Owner's key is still there");
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM settings WHERE profile_id = ?').get(doomed.id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM settings_history WHERE profile_id = ?').get(doomed.id).n, 0);
  assert.equal((await owner.call('GET', '/api/settings')).data.values['lesson.defaults'].minutes, 5);
});

test('settings and keys from before profiles go to the Owner, and migrating again changes nothing', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'np-old-settings-'));
  const s0 = createStore(old);
  // What the version before profiles wrote: one settings table with no owner, history without one, keys by provider.
  s0.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
              CREATE TABLE settings_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_json TEXT, new_json TEXT, by TEXT NOT NULL, at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0, undo_of INTEGER);
              INSERT INTO settings VALUES ('lesson.defaults', '{"minutes":7,"quality":"low","review":"render","visualReview":false,"voiceId":""}', 1, 'you');
              INSERT INTO settings_history (key, old_json, new_json, by, at) VALUES ('lesson.defaults', NULL, '{"minutes":7}', 'you', 1);`);
  const sec = createSecrets({ dataDir: old, useKeychain: false });
  await sec.set('anthropic', 'sk-ant-legacy-key-1234');
  for (let run = 0; run < 2; run += 1) {
    const p = createProfiles({ db: s0.db, dataDir: old });
    const f = createSettings({ db: s0.db, getConfig: () => config, secrets: sec, profiles: p });
    await f.migrateKeys();
    const o = p.owner().id;
    assert.equal(f.for(o).get('lesson.defaults').minutes, 7);
    assert.equal(f.for(o).history().length, 1);
    assert.equal((await keyFor('anthropic', { config, secrets: sec, profileId: o })).key, 'sk-ant-legacy-key-1234');
    assert.equal(await sec.get('anthropic'), null, 'the old account is gone');
    const second = p.create({ name: 'Second' }).id;
    assert.equal(f.for(second).get('lesson.defaults').minutes, 2, "the Owner's settings are not inherited");
    p.remove(second);
  }
  s0.close();
  const peek = new Database(path.join(old, 'studio.db'), { readonly: true });
  assert.equal(peek.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'settings_legacy'").get().n, 0);
  peek.close();
  fs.rmSync(old, { recursive: true, force: true });
});

test("a profile's keys are never reachable by naming another profile's account", async () => {
  await assert.rejects(secrets.set('p-x"; delete-generic-password -a "y', 'sk-test-12345678'), /not usable/);
  await assert.rejects(secrets.set('P-UPPER', 'sk-test-12345678'), /not usable/);
});

test("starting a lesson is checked against the profile's own writer, keys and spending", async () => {
  const start = (b) => b.call('POST', '/api/lessons', { topic: 'Dot products', minutes: 1 });
  // The roommate's writer is Claude Code, which the Owner has not lent them.
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { mode: 'one', all: { provider: 'claude-code', model: '' } } });
  const refused = await start(roommate);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Owner has not allowed it/);
  // With a writer of their own that works, they can; the Owner's writer is not theirs to lend.
  const room = factory.for(roomId);
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { all: { provider: 'ollama', model: 'qwen3' } } });
  pass(room, 'ollama', 'qwen3');
  assert.equal((await start(roommate)).status, 201);
  // The Owner's monthly cap is counted against the Owner's own spend, not the roommate's.
  const mine = store.insert({ id: 'owners-lesson', profile_id: ownerId, kind: 'video', title: 'Owner', source_name: null, text: 'x', text_hash: 'h', config_hash: 'c', char_count: 1, word_count: 1, voice_id: 'af_heart', voice_name: null, model_id: 'm', settings_json: '{}', status: 'done', tags: '', created_at: Date.now() });
  assert.ok(mine);
  store.versions.insert({ generation_id: 'owners-lesson', n: 1, source: 'written', created_at: Date.now(), cost_usd: 3 });
  assert.equal((await owner.call('PATCH', '/api/settings', { costs: { monthCapUsd: 1 } })).status, 200);
  const capped = await start(owner);
  assert.equal(capped.status, 400);
  assert.match(capped.data.error, /monthly cap of \$1\.00/);
  await roommate.call('PATCH', '/api/settings', { costs: { monthCapUsd: 1 } });
  assert.equal((await start(roommate)).status, 201, "the roommate has spent nothing, whatever the Owner has");
  assert.equal((await owner.call('GET', '/api/settings')).data.costThisMonthUsd, 3);
  assert.equal((await roommate.call('GET', '/api/settings')).data.costThisMonthUsd, 0);
});

test("the Owner limits what a profile spends with the host's Claude sign-in, and it holds", async () => {
  const start = (b) => b.call('POST', '/api/lessons', { topic: 'Eigenvalues', minutes: 1 });
  const room = factory.for(roomId);
  const spend = (usd, n) => {
    if (!store.getRaw('rooms-lesson')) store.insert({ id: 'rooms-lesson', profile_id: roomId, kind: 'video', title: 'Room', source_name: null, text: 'x', text_hash: 'r', config_hash: 'r', char_count: 1, word_count: 1, voice_id: 'af_heart', voice_name: null, model_id: 'm', settings_json: '{}', status: 'done', tags: '', created_at: Date.now() });
    store.versions.insert({ generation_id: 'rooms-lesson', n, source: 'written', created_at: Date.now(), cost_usd: usd, host_usd: usd });
  };
  await roommate.call('PATCH', '/api/settings', { costs: { monthCapUsd: null } }); // the profile's own cap is a separate thing
  // Allowed Claude Code, with a $1 limit: nothing spent yet, so a lesson may start.
  assert.equal((await roommate.call('PATCH', `/api/profiles/${roomId}`, { hostCapUsd: 1 })).status, 403, 'not theirs to set');
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostClaude: true, hostCapUsd: '1.234' })).data.profile.hostCapUsd, 1.23);
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { hostCapUsd: -5 })).status, 400);
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { hostCapUsd: 'lots' })).status, 400);
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { mode: 'one', all: { provider: 'claude-code', model: '' } } });
  assert.equal((await start(roommate)).status, 201);
  assert.equal(store.stats(roomId).hostSpentThisMonthUsd, 0);
  // Spent past it: a lesson on the host's sign-in is refused, with what to do instead.
  spend(1.5, 1);
  assert.equal(store.stats(roomId).hostSpentThisMonthUsd, 1.5);
  const refused = await start(roommate);
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /\$1\.23 a month, set by the Owner\) is used up/);
  const page = (await roommate.call('GET', '/api/settings')).data;
  assert.deepEqual(page.hostAllowance, { capUsd: 1.23, spentUsd: 1.5 });
  assert.equal((await owner.call('GET', '/api/settings')).data.hostAllowance, undefined, 'the Owner has no limit');
  const seen = (await owner.call('GET', '/api/profiles/all')).data.profiles.find((p) => p.id === roomId);
  assert.deepEqual([seen.hostCapUsd, seen.hostSpentUsd], [1.23, 1.5]);
  // A writer that is not the host's is not limited: a model on this Mac, or a key of their own.
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { all: { provider: 'ollama', model: 'qwen3' } } });
  pass(room, 'ollama', 'qwen3');
  assert.equal((await start(roommate)).status, 201);
  await roommate.call('PATCH', '/api/settings', { 'writer.page': { all: { provider: 'claude-code', model: '' } } });
  // Raising it, or removing it, lets them start again. The lesson's own cap is what is left of the allowance.
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { hostCapUsd: 5 })).status, 200);
  assert.equal((await start(roommate)).status, 201);
  assert.equal((await room.hostAllowance(room.resolveWriter('page'), 1.5)).leftUsd, 3.5);
  assert.equal((await owner.call('PATCH', `/api/profiles/${roomId}`, { hostCapUsd: null })).data.profile.hostCapUsd, null);
  assert.equal(await room.hostAllowance(room.resolveWriter('page'), 99), null, 'no limit set');
  // A deleted lesson's host spending stays counted.
  store.remove('rooms-lesson');
  assert.equal(store.stats(roomId).hostSpentThisMonthUsd, 1.5);
  await owner.call('PATCH', `/api/profiles/${roomId}`, { canUseHostClaude: false });
});

test('without a sandbox, only the Owner runs code they wrote while others share the install', async () => {
  store.insert({ id: 'code-lesson', profile_id: roomId, kind: 'video', title: 'Code', source_name: null, text: 'x', text_hash: 'c', config_hash: 'c', char_count: 1, word_count: 1, voice_id: 'af_heart', voice_name: null, model_id: 'm', settings_json: JSON.stringify({ project: 'code-lesson', lesson: { topic: 't' } }), status: 'done', tags: '', created_at: Date.now() });
  for (const [method, url, body] of [['PUT', 'source', { scenes: 'import os' }], ['POST', 'check', {}], ['POST', 'build', {}], ['POST', 'restore', { version: 1 }]]) {
    config.sandboxed = false;
    const refused = await roommate.call(method, `/api/generations/code-lesson/${url}`, body);
    assert.equal(refused.status, 403, `${method} ${url}`);
    assert.match(refused.data.error, /no sandbox, so only the Owner/);
    // Another profile's lesson is still a plain 404: the check about code is not a way to learn it exists.
    assert.equal((await owner.call(method, `/api/generations/code-lesson/${url}`, body)).status, 404, 'not the Owner’s lesson');
    config.sandboxed = true;
    assert.notEqual((await roommate.call(method, `/api/generations/code-lesson/${url}`, body)).status, 403, 'with a sandbox it is allowed');
  }
  config.sandboxed = false;
  assert.equal((await roommate.call('GET', '/api/generations/code-lesson/source')).status !== 403, true, 'reading is fine');
  assert.equal((await owner.call('GET', '/api/settings')).data.house.sandboxed, false);
  store.remove('code-lesson');
  config.sandboxed = undefined;
});
