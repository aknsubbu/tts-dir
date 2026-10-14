import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createLessons } from '../lessons.js';
import { createProfiles } from '../profiles.js';
import { createSecrets } from '../secrets.js';
import { createSettings } from '../settings.js';

/** The Owner's limit on what a profile spends with the host's own sign-in and keys, below the HTTP layer. */
let dir, store, profiles, factory, lessons, submitted, roomId, ownerId, config, jobSeq, failNext;

const row = (id, profileId, settings = {}, extra = {}) => ({
  id, profile_id: profileId, kind: 'video', title: id, source_name: `video/projects/${id}`, text: 'x', text_hash: id, config_hash: id, char_count: 1, word_count: 1,
  voice_id: 'af_heart', voice_name: null, model_id: 'm', status: 'queued', tags: '', created_at: Date.now(),
  settings_json: JSON.stringify({ project: id, quality: 'low', scenes: [], lesson: { topic: 't', review: 'render', ...settings } }), ...extra,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-host-'));
  store = createStore(path.join(dir, 'data'));
  config = { videoDir: path.join(dir, 'video'), keys: {}, given: {}, defaultVoiceId: 'af_heart', claudeEffort: 'high', claudeFixEffort: 'low', claudePolishEffort: 'medium', claudeReadEffort: 'medium', claudeOutlineEffort: 'medium', lessonReview: 'render' };
  profiles = createProfiles({ db: store.db, dataDir: path.join(dir, 'data') });
  ownerId = profiles.owner().id;
  roomId = profiles.create({ name: 'Room' }).id;
  profiles.update(roomId, { canUseHostClaude: true, canUseHostKeys: true, hostCapUsd: 2 });
  const secrets = createSecrets({ dataDir: path.join(dir, 'data'), useKeychain: false });
  factory = createSettings({ db: store.db, getConfig: () => config, secrets, profiles });
  submitted = [];
  jobSeq = 0;
  const jobs = { submit: (j) => { if (failNext) { failNext = false; throw new Error('the writer is busy'); } submitted.push(j); jobSeq += 1; return { id: `job-${jobSeq}` }; }, cancel() {}, get: () => ({ status: 'working' }) };
  lessons = createLessons({ store, runner: { enqueue() {} }, getConfig: () => config, jobs, settings: factory, pollMs: 60_000 });
});
after(() => {
  lessons.stop();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const start = async (id) => {
  await lessons.start(id, { topic: 't', goal: '', notes: '', minutes: 1, voice: 'af_heart', attachments: [] });
  return store.getRaw(id);
};

test('lessons started together are not each given the whole allowance', async () => {
  for (const id of ['a1', 'a2', 'a3']) store.insert(row(id, roomId));
  const one = await start('a1');
  assert.equal(one.status, 'processing');
  assert.equal(submitted.at(-1).hostCapUsd, 2, 'the first is given what is left');
  const two = await start('a2');
  assert.equal(two.status, 'error', 'the second finds it held for the first');
  assert.match(two.error, /Your other lessons are using the allowance the Owner set/);
  assert.equal(submitted.length, 1, 'and never reached the writer');
  // When the first stops, what it held is free again.
  lessons.cancel('a1');
  assert.equal((await start('a3')).status, 'processing');
  assert.equal(submitted.at(-1).hostCapUsd, 2);
  lessons.cancel('a3');
});

test('the Owner is never held to a limit, and neither is anyone with none set', async () => {
  store.insert(row('o1', ownerId));
  await start('o1');
  assert.equal(submitted.at(-1).hostCapUsd ?? null, null);
  lessons.cancel('o1');
  profiles.update(roomId, { hostCapUsd: null });
  store.insert(row('n1', roomId));
  await start('n1');
  assert.equal(submitted.at(-1).hostCapUsd ?? null, null);
  lessons.cancel('n1');
  profiles.update(roomId, { hostCapUsd: 2 });
});

test('a lesson is held to the limit even when its writer is the profile’s own key, in case the key goes', async () => {
  const room = factory.for(roomId);
  const plan = { 'writer.page': { mode: 'one', all: { provider: 'groq', model: 'llama' } } };
  await room.patch(plan);
  await room.setKey('groq', 'gsk_room_own_key_1234');
  store.insert(row('k1', roomId));
  await start('k1');
  assert.equal(submitted.at(-1).hostCapUsd, 2, 'not on the host now, but allowed no more than what is left if it ends up there');
  lessons.cancel('k1');
  const allowance = await room.hostAllowance(room.resolveWriter('page'), 0);
  assert.equal(allowance.usesHost, false);
  await room.removeKey('groq');
  assert.equal((await room.hostAllowance(room.resolveWriter('page'), 0)).usesHost, false, 'no key and no host key: nothing to use');
  config.keys = { groq: 'gsk-host-env-0000' };
  assert.equal((await room.hostAllowance(room.resolveWriter('page'), 0)).usesHost, true, 'the key went, and the host’s took over');
  config.keys = {};
});

test('a key that cannot be looked up counts as the host’s', async () => {
  const broken = createSettings({ db: store.db, getConfig: () => config, secrets: { get: async () => { throw new Error('keychain locked'); }, kind: 'keychain', where: 'x' }, profiles });
  const room = broken.for(roomId);
  await room.patch({ 'writer.page': { mode: 'one', all: { provider: 'groq', model: 'llama' } } });
  assert.equal((await room.hostAllowance(room.resolveWriter('page'), 0)).usesHost, true);
});

test('what a lesson spent that no version holds yet is counted: a waiting narration, a failed attempt, and a deleted lesson', () => {
  const settings = { scriptCostUsd: 0.75, scriptHostUsd: 0.5, outlineCostUsd: 0.25, outlineHostUsd: 0.25 };
  const month = (id) => store.stats(roomId, { excludeId: id });
  const before = store.stats(roomId);
  store.insert(row('p1', roomId, settings, { status: 'awaiting' }));
  const waiting = store.stats(roomId);
  assert.equal(Math.round((waiting.costThisMonthUsd - before.costThisMonthUsd) * 100) / 100, 1);
  assert.equal(Math.round((waiting.hostSpentThisMonthUsd - before.hostSpentThisMonthUsd) * 100) / 100, 0.75);
  assert.equal(month('p1').costThisMonthUsd, waiting.costThisMonthUsd, 'with no failed attempt there is nothing to leave out');
  // An attempt that failed and was never finished.
  store.update('p1', { settings_json: JSON.stringify({ project: 'p1', lesson: { ...settings, failedUsd: 2, failedHostUsd: 1 } }) });
  assert.equal(Math.round((store.stats(roomId).costThisMonthUsd - before.costThisMonthUsd) * 100) / 100, 3);
  // A retry leaves out the failed attempts (the job counts those itself) and nothing else.
  const retrying = store.stats(roomId, { excludeId: 'p1' });
  assert.equal(Math.round((retrying.costThisMonthUsd - before.costThisMonthUsd) * 100) / 100, 1, 'the waiting narration and outline still count');
  assert.equal(Math.round((retrying.hostSpentThisMonthUsd - before.hostSpentThisMonthUsd) * 100) / 100, 0.75);
  // Once a version holds it, the lesson's own figures are not counted again.
  store.update('p1', { settings_json: JSON.stringify({ project: 'p1', lesson: { ...settings, failedUsd: 0, failedHostUsd: 0 } }), version: 1 });
  assert.equal(store.stats(roomId).costThisMonthUsd, before.costThisMonthUsd);
  store.update('p1', { settings_json: JSON.stringify({ project: 'p1', lesson: { ...settings, failedUsd: 2, failedHostUsd: 1 } }), version: 0 });
  // Deleting it does not give the money back.
  const held = store.stats(roomId);
  store.remove('p1');
  const after = store.stats(roomId);
  assert.equal(after.costThisMonthUsd, held.costThisMonthUsd);
  assert.equal(after.hostSpentThisMonthUsd, held.hostSpentThisMonthUsd);
});

test('a failed or cancelled lesson keeps what the attempt spent, read from its log', async () => {
  await factory.for(roomId).patch({ 'writer.page': { mode: 'one', all: { provider: 'claude-code', model: '' } } });
  store.insert(row('f1', roomId));
  const log = path.join(config.videoDir, 'projects', 'f1', 'build', 'author');
  fs.mkdirSync(log, { recursive: true });
  const before = store.stats(roomId);
  await start('f1');
  fs.writeFileSync(path.join(log, 'spent.json'), JSON.stringify({ usd: 1.25, hostUsd: 0.75 }));
  lessons.cancel('f1');
  const after = store.stats(roomId);
  assert.equal(Math.round((after.costThisMonthUsd - before.costThisMonthUsd) * 100) / 100, 1.25);
  assert.equal(Math.round((after.hostSpentThisMonthUsd - before.hostSpentThisMonthUsd) * 100) / 100, 0.75);
});

test('the monthly cap is shared out the same way: lessons started together cannot each spend what is left', async () => {
  const room = factory.for(roomId);
  const spent0 = store.stats(roomId).costThisMonthUsd; // what earlier tests left on this profile
  profiles.update(roomId, { hostCapUsd: Math.round((store.stats(roomId).hostSpentThisMonthUsd + 2) * 100) / 100 }); // two dollars of the host's allowance left
  await room.patch({ costs: { monthCapUsd: Math.round((spent0 + 3) * 100) / 100 } });
  for (const id of ['m1', 'm2', 'm3']) store.insert(row(id, roomId));
  const first = await start('m1');
  assert.equal(first.status, 'processing', first.error);
  assert.equal(submitted.at(-1).capUsd, 3);
  const second = await start('m2');
  assert.equal(second.status, 'error');
  assert.match(second.error, /Your other lessons may spend what is left of this month’s cap/);
  lessons.cancel('m1');
  assert.equal((await start('m3')).status, 'processing');
  lessons.cancel('m3');
  await room.patch({ costs: { monthCapUsd: null } });
});

test('a revision that cannot start holds nothing back', async () => {
  profiles.update(roomId, { hostCapUsd: Math.round((store.stats(roomId).hostSpentThisMonthUsd + 2) * 100) / 100 });
  store.insert(row('r1', roomId, {}, { status: 'done' }));
  store.insert(row('r2', roomId));
  const root = path.join(config.videoDir, 'projects', 'r1');
  fs.mkdirSync(root, { recursive: true });
  failNext = true;
  await assert.rejects(lessons.revise('r1', { request: 'change it', scope: { kind: 'lesson' } }), /the writer is busy/);
  assert.equal((await start('r2')).status, 'processing', 'the allowance was not left held by the revision that never ran');
  assert.equal(submitted.at(-1).hostCapUsd, 2);
  lessons.cancel('r2');
});

test('what a lesson had spent when the server stopped is kept, once, however often it starts again', async () => {
  store.insert(row('i1', roomId, {}, { status: 'error' }));
  store.update('i1', { error: 'Interrupted by a server restart. Press Retry.' });
  const log = path.join(config.videoDir, 'projects', 'i1', 'build', 'author');
  fs.mkdirSync(log, { recursive: true });
  fs.writeFileSync(path.join(log, 'spent.json'), JSON.stringify({ usd: 0.8, hostUsd: 0.6 }));
  const before = store.stats(roomId);
  assert.ok(lessons.settleInterrupted() >= 1);
  lessons.settleInterrupted();
  const after = store.stats(roomId);
  assert.equal(Math.round((after.costThisMonthUsd - before.costThisMonthUsd) * 100) / 100, 0.8);
  assert.equal(Math.round((after.hostSpentThisMonthUsd - before.hostSpentThisMonthUsd) * 100) / 100, 0.6);
});
