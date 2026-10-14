import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../db.js';
import { createApp } from '../app.js';
import { createProfiles, ProfileError } from '../profiles.js';
import { createVersions } from '../versions.js';

let dir, videoDir, store, app, server, base, profiles;
const engine = {
  start: async () => {},
  stop() {},
  info: () => ({ status: 'ready', error: null, device: 'test' }),
  catalog: () => ({ voices: [{ voiceId: 'af_zed', name: 'Zed', lang: 'a' }], languages: [{ code: 'a', name: 'English', available: true }], samples: { a: 'Hi.' } }),
};

/** A browser: remembers its session cookie. */
function browser() {
  let cookie = '';
  const me = {
    get cookie() {
      return cookie;
    },
    async call(method, url, body) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, data, text, headers: res.headers };
    },
  };
  return me;
}

const lessonRow = (profileId, id, title, extra = {}, subject = 'quaternions') => ({
  id, profile_id: profileId, kind: 'video', title, source_name: `video/projects/${id}`, text: `${title} secret notes about ${subject}`, text_hash: `h-${id}`, config_hash: `c-${id}`,
  char_count: 10, word_count: 2, voice_id: 'af_zed', voice_name: 'Zed', model_id: 'm',
  settings_json: JSON.stringify({ project: id, quality: 'low', scenes: ['Intro'], lesson: { topic: title, review: 'render' } }),
  status: 'done', tags: 'private-tag', created_at: Date.now(), ...extra,
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-profiles-test-'));
  videoDir = path.join(dir, 'video');
  fs.mkdirSync(path.join(videoDir, 'projects'), { recursive: true });
  store = createStore(path.join(dir, 'data'));
  const config = { videoDir, defaultVoiceId: 'af_zed', keepRenders: 3, maxProfiles: 3 };
  const versions = createVersions({ store, getConfig: () => config });
  // Every test shares one address, so the per-device cap is raised here; its own test uses the default.
  profiles = createProfiles({ db: store.db, dataDir: store.dataDir, getMax: () => config.maxProfiles, ipMax: 10_000 });
  app = createApp({ getConfig: () => config, store, runner: { enqueue() {}, cancel: () => false }, engine, versions, profiles });
  return new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      r();
    });
  });
});

after(() => {
  server.close();
  server.closeAllConnections?.();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- one profile, no PIN: as before ----------

test('an install with one profile and no PIN has no gate and needs no cookie', async () => {
  const b = browser();
  const session = (await b.call('GET', '/api/session')).data;
  assert.equal(session.needsGate, false);
  assert.equal(session.profile.isOwner, true);
  assert.equal((await b.call('GET', '/api/generations')).status, 200);
  assert.equal(b.cookie, '');
});

// ---------- migration ----------

test('a library from before profiles lands under the Owner, and migrating again changes nothing', () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-old-lib-'));
  fs.mkdirSync(path.join(old, 'data'), { recursive: true });
  const first = createStore(path.join(old, 'data'));
  // Pretend this was written by the version before profiles: no owner on its rows.
  first.db.exec("DROP INDEX idx_gen_profile; ALTER TABLE generations DROP COLUMN profile_id;");
  first.db.prepare(`INSERT INTO generations (id, title, text, text_hash, config_hash, char_count, word_count, voice_id, model_id, settings_json, status, created_at)
                    VALUES ('old1', 'Old lesson', 'text', 'h', 'c', 4, 1, 'af_zed', 'm', '{}', 'done', 1)`).run();
  first.close();
  for (let run = 0; run < 2; run += 1) {
    const s = createStore(path.join(old, 'data'));
    const p = createProfiles({ db: s.db, dataDir: path.join(old, 'data') });
    const owner = p.owner();
    assert.equal(p.list().length, 1);
    assert.equal(s.getRaw('old1').profile_id, owner.id);
    assert.equal(s.list(owner.id).total, 1);
    s.close();
  }
  fs.rmSync(old, { recursive: true, force: true });
});

// ---------- PINs and lockout ----------

test('a PIN is stored as a salted hash with a pepper kept private, and compared in full', () => {
  const p = createProfiles({ db: store.db, dataDir: path.join(dir, 'data') });
  const o = p.owner();
  p.setPin(o.id, '4821');
  const row = store.db.prepare('SELECT * FROM profiles WHERE id = ?').get(o.id);
  assert.notEqual(row.pin_hash, '4821');
  assert.ok(row.pin_salt.length >= 32);
  assert.equal(JSON.stringify(row).includes('4821'), false);
  const pepper = path.join(dir, 'data', 'pin-pepper');
  assert.equal(fs.statSync(pepper).mode & 0o777, 0o600);
  assert.throws(() => p.verifyPin(o.id, '4822'), (e) => e instanceof ProfileError && e.status === 401);
  assert.doesNotThrow(() => p.verifyPin(o.id, '4821'));
  assert.throws(() => p.setPin(o.id, '12345'), /exactly 4 digits/);
  assert.throws(() => p.setPin(o.id, 'abcd'), /exactly 4 digits/);
  p.clearPin(o.id);
});

test('five wrong PINs lock a profile out for 30 seconds, then longer each time, and the right PIN waits too', () => {
  let t = 1_000_000;
  const p = createProfiles({ db: store.db, dataDir: path.join(dir, 'data'), now: () => t });
  const x = p.create({ name: 'Lockout' });
  p.setPin(x.id, '1111');
  const wrong = () => {
    try {
      p.verifyPin(x.id, '0000');
    } catch (e) {
      return e;
    }
    return null;
  };
  for (let i = 0; i < 4; i += 1) assert.equal(wrong().status, 401);
  const fifth = wrong();
  assert.equal(fifth.status, 429);
  assert.equal(fifth.retryAfterSec, 30);
  // Locked: even the right PIN is refused, and says nothing but to wait.
  assert.throws(() => p.verifyPin(x.id, '1111'), (e) => e.status === 429);
  t += 31_000;
  for (let i = 0; i < 4; i += 1) assert.equal(wrong().status, 401);
  assert.equal(wrong().retryAfterSec, 60); // doubled
  t += 61_000;
  assert.doesNotThrow(() => p.verifyPin(x.id, '1111')); // right PIN after the wait resets it
  for (let i = 0; i < 4; i += 1) wrong();
  assert.equal(wrong().retryAfterSec, 30);
  // The delay stops growing at 15 minutes.
  let last = 0;
  for (let round = 0; round < 12; round += 1) {
    t += 16 * 60_000;
    for (let i = 0; i < 4; i += 1) wrong();
    last = wrong().retryAfterSec;
  }
  assert.equal(last, 900);
  p.remove(x.id);
});

test('one device cannot guess PINs across profiles without end', () => {
  const p = createProfiles({ db: store.db, dataDir: path.join(dir, 'data') });
  const ids = ['Guess A', 'Guess B', 'Guess C'].map((n) => {
    const c = p.create({ name: n, owner: false });
    p.setPin(c.id, '2222');
    return c.id;
  });
  let blocked = false;
  for (let i = 0; i < 60 && !blocked; i += 1) {
    try {
      p.verifyPin(ids[i % ids.length], String(1000 + (i % 7)), { ip: '10.0.0.9' });
    } catch (e) {
      if (e.message.includes('Too many tries from this device')) blocked = true;
    }
  }
  assert.ok(blocked);
  ids.forEach((id) => p.remove(id));
});

// ---------- two people on one install ----------

let alice, bob, aId, bId; // alice is the Owner (the lone profile), bob the one added

test('adding a second profile brings up the gate; the first stays signed in', async () => {
  alice = browser();
  const added = (await alice.call('POST', '/api/profiles', { name: 'Robin', avatar: { color: '#0f766e', glyph: 'R' } })).data.profile;
  assert.equal(added.name, 'Robin');
  assert.ok(alice.cookie.startsWith('tts_session='), 'the adder gets a session as the Owner');
  const list = (await browser().call('GET', '/api/profiles')).data;
  assert.equal(list.profiles.length, 2);
  assert.equal(list.max, 3);
  assert.deepEqual(Object.keys(list.profiles[0]).sort(), ['avatar', 'id', 'isOwner', 'locked', 'name']);
  const nobody = browser();
  assert.equal((await nobody.call('GET', '/api/generations')).status, 401);
  assert.equal((await nobody.call('GET', '/api/session')).data.needsGate, true);
  assert.equal((await nobody.call('GET', '/api/health')).status, 200);
  const me = (await alice.call('GET', '/api/session')).data.profile;
  assert.equal(me.isOwner, true);
  aId = me.id;
  bId = added.id;
  bob = browser();
  const signin = await bob.call('POST', '/api/session', { profileId: bId });
  assert.equal(signin.status, 200);
  const flags = signin.headers.get('set-cookie');
  assert.match(flags, /HttpOnly/i);
  assert.match(flags, /SameSite=Strict/i);
  assert.equal((await bob.call('GET', '/api/session')).data.profile.id, bId);
});

test('names are unique, the profile limit holds, and an avatar is a colour and a glyph', async () => {
  const b = browser();
  assert.equal((await b.call('POST', '/api/profiles', { name: 'robin' })).status, 409);
  assert.equal((await b.call('POST', '/api/profiles', { name: '' })).status, 400);
  assert.equal((await b.call('POST', '/api/profiles', { name: 'x'.repeat(40) })).status, 400);
  const third = await b.call('POST', '/api/profiles', { name: 'Third', avatar: { color: 'javascript:alert(1)', glyph: '🦊🦊🦊' } });
  assert.equal(third.status, 201);
  assert.ok(third.data.profile.avatar.color.startsWith('#'));
  assert.equal([...third.data.profile.avatar.glyph].length, 2);
  assert.equal((await b.call('POST', '/api/profiles', { name: 'Fourth' })).status, 409); // TTS_MAX_PROFILES = 3
  await alice.call('DELETE', `/api/profiles/${third.data.profile.id}`, { confirmName: 'Third' });
});

test('a locked profile needs its PIN, which lockout protects, and a wrong one says nothing more', async () => {
  const b = browser();
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '3141' })).status, 200);
  assert.equal((await b.call('GET', '/api/profiles')).data.profiles.find((p) => p.id === bId).locked, true);
  const wrong = await b.call('POST', '/api/session', { profileId: bId, pin: '0000' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(Object.keys(wrong.data).sort(), ['error']);
  assert.equal((await b.call('POST', '/api/session', { profileId: bId })).status, 401); // no PIN at all
  assert.equal((await b.call('POST', '/api/session', { profileId: bId, pin: 3141 })).status, 200); // numbers are fine
  const fresh = browser();
  let last;
  for (let i = 0; i < 5; i += 1) last = await fresh.call('POST', '/api/session', { profileId: bId, pin: '9999' });
  assert.equal(last.status, 429);
  assert.equal(last.data.retryAfterSec, 30);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal((await fresh.call('POST', '/api/session', { profileId: bId, pin: '3141' })).status, 429);
  // Even the Owner cannot get past a PIN they do not know (see the next tests); on the host,
  // `npm run profiles -- reset-pin` can, and the lock goes with the PIN.
  profiles.clearPin(bId);
  profiles.closeSessionsOf(bId);
  assert.equal((await fresh.call('POST', '/api/session', { profileId: bId })).status, 200);
  // Changing a PIN signs the profile out everywhere else, so Bob comes back in.
  assert.equal((await bob.call('POST', '/api/session', { profileId: bId })).status, 200);
});

test('changing or removing a PIN needs the current one; only the Owner resets someone else\'s', async () => {
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '1234' })).status, 200);
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '5678' })).status, 401);
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '5678', currentPin: '1234' })).status, 200);
  assert.equal((await bob.call('DELETE', `/api/profiles/${bId}/pin`, {})).status, 401);
  assert.equal((await bob.call('DELETE', `/api/profiles/${bId}/pin`, { currentPin: '5678' })).status, 200);
  // Bob may not touch the Owner's PIN, nor the Owner's profile.
  assert.equal((await bob.call('PUT', `/api/profiles/${aId}/pin`, { pin: '0000' })).status, 403);
  assert.equal((await bob.call('PATCH', `/api/profiles/${aId}`, { name: 'Hacked' })).status, 403);
  // Bob may not give himself the host's resources.
  assert.equal((await bob.call('PATCH', `/api/profiles/${bId}`, { canUseHostClaude: true })).status, 403);
  assert.equal((await alice.call('PATCH', `/api/profiles/${bId}`, { canUseHostClaude: true, canUseHostKeys: false })).data.profile.canUseHostClaude, true);
  assert.equal((await alice.call('PATCH', `/api/profiles/${bId}`, { canUseHostClaude: false })).data.profile.canUseHostClaude, false);
  // The Owner can only demand their PIN for adding profiles once they have one.
  assert.equal((await alice.call('PATCH', `/api/profiles/${aId}`, { requirePinToAdd: true })).status, 409);
});

test('an Owner with no PIN cannot reset or delete a locked profile: a session on them proves nothing', async () => {
  const victim = (await alice.call('POST', '/api/profiles', { name: 'Victim', pin: '8642' })).data.profile;
  const stranger = browser(); // anyone at the gate can sign in as a PIN-less Owner
  assert.equal((await stranger.call('POST', '/api/session', { profileId: aId })).status, 200);
  assert.equal((await stranger.call('PUT', `/api/profiles/${victim.id}/pin`, { pin: '0000' })).status, 409);
  assert.equal((await stranger.call('DELETE', `/api/profiles/${victim.id}/pin`)).status, 409);
  assert.equal((await stranger.call('DELETE', `/api/profiles/${victim.id}`, { confirmName: 'Victim' })).status, 401);
  assert.equal((await stranger.call('DELETE', `/api/profiles/${victim.id}`, { confirmName: 'Victim', pin: '0000' })).status, 401);
  assert.equal((await browser().call('POST', '/api/session', { profileId: victim.id, pin: '0000' })).status, 401);
  assert.equal(profiles.get(victim.id).locked, true);
  // The PIN's owner can do it.
  assert.equal((await stranger.call('DELETE', `/api/profiles/${victim.id}`, { confirmName: 'victim', pin: '8642' })).status, 200);
});

test('a changed PIN signs out the profile\'s other sessions', async () => {
  const other = browser();
  assert.equal((await other.call('POST', '/api/session', { profileId: bId })).status, 200);
  assert.equal((await other.call('GET', '/api/generations')).status, 200);
  // Bob has a PIN again, so the Owner must prove who they are to reset it, with a PIN of their own.
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '1111' })).status, 200);
  assert.equal((await alice.call('PUT', `/api/profiles/${aId}/pin`, { pin: '7777' })).status, 200);
  assert.equal((await alice.call('PUT', `/api/profiles/${bId}/pin`, { pin: '2468' })).status, 401); // no Owner PIN given
  assert.equal((await alice.call('PUT', `/api/profiles/${bId}/pin`, { pin: '2468', ownerPin: '0000' })).status, 401);
  assert.equal((await alice.call('PUT', `/api/profiles/${bId}/pin`, { pin: '2468', ownerPin: '7777' })).status, 200);
  assert.equal((await other.call('GET', '/api/generations')).status, 401);
  assert.equal((await bob.call('GET', '/api/generations')).status, 401);
  assert.equal((await bob.call('POST', '/api/session', { profileId: bId, pin: '2468' })).status, 200);
  assert.equal((await bob.call('DELETE', `/api/profiles/${bId}/pin`, { currentPin: '2468' })).status, 200);
});

test('the Owner can require their PIN before anyone adds a profile', async () => {
  assert.equal((await alice.call('PATCH', `/api/profiles/${aId}`, { requirePinToAdd: true })).status, 200);
  const stranger = browser();
  assert.equal((await stranger.call('POST', '/api/profiles', { name: 'Guest' })).status, 401);
  assert.equal((await stranger.call('POST', '/api/profiles', { name: 'Guest', ownerPin: '7777' })).status, 201);
  assert.equal((await bob.call('POST', '/api/profiles', { name: 'Guest 2' })).status, 401);
  const guest = (await browser().call('GET', '/api/profiles')).data.profiles.find((p) => p.name === 'Guest');
  assert.equal((await alice.call('DELETE', `/api/profiles/${guest.id}`, { confirmName: 'Guest' })).status, 401); // the Owner's PIN stands in the way
  assert.equal((await alice.call('DELETE', `/api/profiles/${guest.id}`, { pin: '7777', confirmName: 'Guest' })).status, 200);
  assert.equal((await alice.call('DELETE', `/api/profiles/${aId}/pin`, { currentPin: '7777' })).status, 200);
  // Removing the Owner's PIN also turns the requirement off.
  assert.equal((await browser().call('GET', '/api/profiles')).data.needsOwnerPinToAdd, false);
});

// ---------- isolation ----------

const A_LESSON = 'lesson-of-alice';
const B_LESSON = 'lesson-of-bob';

const A_AUDIO = 'audio-of-alice';

/** Alice's lessons, with every file a read route could serve, so that her own access is proven and not only Bob's refusal. */
function seedAlice() {
  const root = path.join(videoDir, 'projects', A_LESSON);
  const put = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  put('project.json', JSON.stringify({ voice: 'af_zed', scenes: ['Intro'] }));
  put('script.txt', '[intro]\nHi there.\n');
  put('scenes.py', 'class Intro: pass\n');
  put('notes/x.png', 'PNG');
  put('outline.json', JSON.stringify({ title: 'Outline', chapters: [{ id: '01-a', title: 'A', minutes: 1 }] }));
  const board = { version: 1, duration: 3, unplayed: [], scenes: [{ name: 'Intro', error: null, end: 'x.png', issues: [], blocks: [{ id: 'intro', text: 'Hi.', duration: 3, start: 0, marks: {}, wav: 'audio/intro.wav', stills: [{ block: 'intro', mark: null, file: 'x.png', at: 1 }], issues: [] }] }] };
  put('build/check/storyboard.json', JSON.stringify(board));
  put('build/check/frames/x.png', 'PNG');
  put('build/manifest.json', JSON.stringify({ order: ['intro'], blocks: { intro: { wav: 'audio/intro.wav' } } }));
  put('build/audio/intro.wav', 'RIFF');
  put('versions/001/script.txt', 'v1');
  put('versions/001/scenes.py', 'v1');
  store.versions.insert({ generation_id: A_LESSON, n: 1, source: 'written', created_at: Date.now() });
  for (const ext of ['mp4', 'srt', 'vtt', 'jpg', 'chapters.vtt']) fs.writeFileSync(store.videoPath(A_LESSON, ext), ext);
  fs.writeFileSync(store.videoPath(A_LESSON, 'words.json'), JSON.stringify({ blocks: [] }));
  fs.writeFileSync(store.audioPath(A_AUDIO), 'MP3');
}

test('seeding: each profile has a lesson, and sees only its own', async () => {
  const withNotes = JSON.stringify({ project: A_LESSON, quality: 'low', scenes: ['Intro'], lesson: { topic: 'Alice', review: 'render', attachments: [{ name: 'x.png', file: 'notes/x.png', kind: 'image' }] } });
  store.insert(lessonRow(aId, A_LESSON, 'Alice quaternion lesson', { settings_json: withNotes, built_version: 1, version: 1 }));
  store.insert(lessonRow(aId, A_AUDIO, 'Alice spoken piece', { kind: 'audio', source_name: null }, 'harmonics'));
  store.insert(lessonRow(bId, B_LESSON, 'Bob tensor lesson', { tags: 'bobs-tag' }, 'manifolds'));
  seedAlice();
  assert.deepEqual((await alice.call('GET', '/api/generations')).data.items.map((g) => g.id).sort(), [A_AUDIO, A_LESSON]);
  assert.equal((await bob.call('GET', '/api/generations')).data.items.map((g) => g.id).join(), B_LESSON);
});

test('search, tags, stats and the project list never show another profile\'s lessons', async () => {
  const found = (await bob.call('GET', '/api/generations?q=quaternion')).data;
  assert.equal(found.total, 0);
  assert.equal((await bob.call('GET', '/api/generations?q=quaternion&sort=relevance')).data.items.length, 0);
  assert.equal((await alice.call('GET', '/api/generations?q=quaternion')).data.total, 1);
  assert.deepEqual((await bob.call('GET', '/api/tags')).data.tags.map((t) => t.tag), ['bobs-tag']);
  assert.deepEqual((await alice.call('GET', '/api/tags')).data.tags.map((t) => t.tag), ['private-tag']);
  assert.equal((await bob.call('GET', '/api/stats')).data.files, 1);
  assert.equal((await bob.call('GET', '/api/generations?tag=private-tag')).data.total, 0);
  assert.equal((await bob.call('GET', '/api/generations?favorite=1&status=done')).data.items.every((g) => g.id === B_LESSON), true);
  // A folder one profile's lesson was written into is not listed to another, nor can it be built from.
  fs.writeFileSync(path.join(videoDir, 'projects', A_LESSON, 'project.json'), JSON.stringify({ voice: 'af_zed', scenes: ['Intro'] }));
  fs.writeFileSync(path.join(videoDir, 'projects', A_LESSON, 'script.txt'), '[intro]\nHi.\n');
  const names = (r) => r.data.projects.map((p) => p.name);
  assert.ok(names(await alice.call('GET', '/api/video/projects')).includes(A_LESSON));
  assert.ok(!names(await bob.call('GET', '/api/video/projects')).includes(A_LESSON));
  assert.equal((await bob.call('POST', '/api/videos', { project: A_LESSON })).status, 404);
  // A project nobody's lesson claims is the Owner's.
  const handmade = path.join(videoDir, 'projects', 'handmade');
  fs.mkdirSync(handmade, { recursive: true });
  fs.writeFileSync(path.join(handmade, 'project.json'), JSON.stringify({ voice: 'af_zed', scenes: ['Intro'] }));
  fs.writeFileSync(path.join(handmade, 'script.txt'), '[intro]\nHi.\n');
  assert.ok(names(await alice.call('GET', '/api/video/projects')).includes('handmade'));
  assert.ok(!names(await bob.call('GET', '/api/video/projects')).includes('handmade'));
  // Saving the same script in two profiles is not a "duplicate" of the other's.
  const mine = await alice.call('POST', '/api/generations', { title: 'Same', text: 'The very same script.', voiceId: 'af_zed' });
  const theirs = await bob.call('POST', '/api/generations', { title: 'Same', text: 'The very same script.', voiceId: 'af_zed' });
  assert.equal(mine.data.duplicate, false);
  assert.equal(theirs.data.duplicate, false);
  assert.notEqual(mine.data.generation.id, theirs.data.generation.id);
});

/** Every route of the API, read from the router itself, so a new one cannot be forgotten. */
function apiRoutes() {
  const out = [];
  const walk = (router) => {
    for (const layer of router.stack) {
      if (layer.route && typeof layer.route.path === 'string') {
        for (const method of Object.keys(layer.route.methods)) if (method !== '_all') out.push({ method: method.toUpperCase(), path: layer.route.path });
      } else if (layer.handle?.stack) walk(layer.handle);
    }
  };
  walk(app.router);
  return out;
}

// Routes that are not about one lesson: each is covered above or by its own test.
const NOT_A_LESSON = new Set([
  'GET /', // the page itself, when the client is not built
  'GET /health', 'GET /voices', 'GET /voices/:id/preview', 'GET /stats', 'GET /events', 'GET /tags', 'GET /generations', 'POST /generations',
  'GET /video/projects', 'POST /videos', 'POST /lessons',
  'GET /profiles', 'POST /profiles', 'GET /session', 'POST /session', 'DELETE /session', 'PATCH /profiles/:id', 'PUT /profiles/:id/pin', 'DELETE /profiles/:id/pin', 'DELETE /profiles/:id',
  // Settings, providers and keys are the house's until Phase 3 gives each profile its own.
  'GET /settings', 'PATCH /settings', 'POST /settings/undo', 'GET /settings/history', 'PUT /providers/:id', 'DELETE /providers/:id', 'PUT /providers/:id/key',
  'DELETE /providers/:id/key', 'POST /providers/:id/test', 'GET /providers/:id/models', 'POST /estimate', 'GET /connect',
]);

test('every route that takes a lesson id answers profile B exactly as it would for an id that does not exist', async () => {
  const routes = apiRoutes();
  const lessonRoutes = routes.filter((r) => r.path.startsWith('/generations/:id'));
  const unknown = routes.filter((r) => !r.path.startsWith('/generations/:id') && !NOT_A_LESSON.has(`${r.method} ${r.path}`));
  assert.deepEqual(unknown, [], 'a route was added that is neither a lesson route nor classified above');
  assert.ok(lessonRoutes.length >= 25, `expected the lesson routes, found ${lessonRoutes.length}`);

  const fill = (p, id) => p.replace(':id', id).replace(':file', 'x.png').replace(':block', 'intro').replace(':ext', 'srt').replace(':n', '1');
  const bodyFor = (method) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { action: 'render', request: 'change it', title: 'pwned', tags: 'x', favorite: true, version: 1, pin: '0000' } : undefined);
  for (const r of lessonRoutes) {
    const label = `${r.method} ${r.path}`;
    const theirs = await bob.call(r.method, `/api${fill(r.path, A_LESSON)}`, bodyFor(r.method));
    const nothing = await bob.call(r.method, `/api${fill(r.path, 'no-such-lesson')}`, bodyFor(r.method));
    assert.equal(theirs.status, 404, `${label} answered ${theirs.status} for someone else's lesson`);
    assert.equal(theirs.text, nothing.text, `${label} answers differently for a lesson that exists`);
    const theirAudio = await bob.call(r.method, `/api${fill(r.path, A_AUDIO)}`, bodyFor(r.method));
    assert.equal(theirAudio.status, 404, `${label} answered ${theirAudio.status} for someone else's audio`);
    // Positive control: every read route does answer Alice, so Bob's 404 is the ownership check and
    // not just a file that was never there.
    if (r.method === 'GET') {
      const ids = [A_LESSON, A_AUDIO];
      const answers = await Promise.all(ids.map((id) => alice.call('GET', `/api${fill(r.path, id)}`)));
      assert.ok(answers.some((a) => a.status !== 404), `${label}: Alice gets 404 on her own lessons, so this route proves nothing about Bob`);
    }
  }
  // The walk changed nothing of Alice's, whose own fixtures it never touched.
  const still = (await alice.call('GET', `/api/generations/${A_LESSON}`)).data;
  assert.equal(still.title, 'Alice quaternion lesson');
  assert.deepEqual(still.tags, ['private-tag']);
  assert.equal(still.favorite, false);
  assert.ok(fs.existsSync(store.videoPath(A_LESSON)));
  // And she can still use every read route Bob could not.
  assert.equal((await alice.call('GET', `/api/generations/${B_LESSON}`)).status, 404);
});

test('live updates go only to the profile whose lesson changed', async () => {
  const listen = async (who) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: who.cookie }, signal: ac.signal });
    assert.equal(res.status, 200);
    const seen = [];
    (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) seen.push(decoder.decode(chunk));
      } catch {
        /* closed */
      }
    })();
    return { seen, stop: () => ac.abort() };
  };
  const a = await listen(alice);
  const b = await listen(bob);
  await new Promise((r) => setTimeout(r, 50));
  store.update(A_LESSON, { title: 'Alice renamed' });
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(a.seen.join('').includes(A_LESSON), 'the owner is told');
  assert.equal(b.seen.join('').includes(A_LESSON), false, 'nobody else is');
  assert.equal(b.seen.join('').includes('Alice'), false);
  store.update(B_LESSON, { title: 'Bob renamed' });
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(b.seen.join('').includes(B_LESSON));
  assert.equal(a.seen.join('').includes(B_LESSON), false);
  // A deletion is announced to its owner only, though the row is gone by then.
  const gone = lessonRow(aId, 'to-delete', 'Short lived');
  store.insert(gone);
  await new Promise((r) => setTimeout(r, 300));
  store.remove('to-delete');
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(a.seen.join('').includes('"deleted":true'));
  assert.equal(b.seen.join('').includes('to-delete'), false);
  a.stop();
  b.stop();
});

test('spending is counted per profile', async () => {
  store.versions.insert({ generation_id: A_LESSON, n: 2, source: 'revised', created_at: Date.now(), cost_usd: 1.25 });
  assert.equal((await alice.call('GET', '/api/stats')).data.costThisMonthUsd, 1.25);
  assert.equal((await bob.call('GET', '/api/stats')).data.costThisMonthUsd, 0);
  // The monthly cap is the house's one number, so it is held against everyone's spend together.
  store.versions.insert({ generation_id: B_LESSON, n: 1, source: 'written', created_at: Date.now(), cost_usd: 0.5 });
  assert.equal((await bob.call('GET', '/api/stats')).data.costThisMonthUsd, 0.5);
  assert.equal(store.houseSpendThisMonth(), 1.75);
});

test('a live-updates stream ends when its session does', async () => {
  const who = browser();
  assert.equal((await who.call('POST', '/api/session', { profileId: bId })).status, 200);
  const res = await fetch(`${base}/api/events`, { headers: { Cookie: who.cookie } });
  let ended = false;
  (async () => {
    try {
      for await (const chunk of res.body) void chunk;
    } catch {
      /* reset */
    }
    ended = true;
  })();
  await new Promise((r) => setTimeout(r, 50));
  await who.call('DELETE', '/api/session');
  store.update(B_LESSON, { title: 'Bob again' }); // the next change finds the session gone
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(ended, true);
});

// ---------- deleting a profile ----------

test('deleting a profile takes its lessons and files with it, and leaves everyone else\'s alone', async () => {
  // Bob's lesson has files and a project folder.
  fs.writeFileSync(store.videoPath(B_LESSON), 'MP4');
  fs.mkdirSync(path.join(videoDir, 'projects', B_LESSON), { recursive: true });
  const nameWrong = await bob.call('DELETE', `/api/profiles/${bId}`, { confirmName: 'nope' });
  assert.equal(nameWrong.status, 400);
  assert.equal((await alice.call('DELETE', `/api/profiles/${aId}`, { confirmName: 'Owner' })).status, 403);
  assert.equal((await bob.call('DELETE', `/api/profiles/${aId}`, { confirmName: 'Owner' })).status, 403);
  // With a PIN, deleting needs it.
  assert.equal((await bob.call('PUT', `/api/profiles/${bId}/pin`, { pin: '1357' })).status, 200);
  assert.equal((await bob.call('DELETE', `/api/profiles/${bId}`, { confirmName: 'Robin' })).status, 401);
  assert.equal((await bob.call('DELETE', `/api/profiles/${bId}`, { confirmName: 'robin', pin: '1357' })).status, 200);
  assert.equal(store.getRaw(B_LESSON), undefined);
  assert.equal(fs.existsSync(store.videoPath(B_LESSON)), false);
  assert.equal(fs.existsSync(path.join(videoDir, 'projects', B_LESSON)), false);
  // The profile and its sessions are gone: Bob's cookie is nothing now, and with one profile left
  // and no PIN the install has no gate, so he is no one in particular (the lone Owner), not Bob.
  assert.equal((await bob.call('GET', '/api/session')).data.profile.isOwner, true);
  assert.equal((await bob.call('GET', '/api/session')).data.implicit, true);
  assert.equal((await alice.call('GET', `/api/generations/${A_LESSON}`)).status, 200);
  assert.equal(fs.existsSync(path.join(videoDir, 'projects', A_LESSON)), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE profile_id = ?').get(bId).n, 0);
  // Back to one profile without a PIN: the gate is gone, as at the start.
  assert.equal((await browser().call('GET', '/api/session')).data.needsGate, false);
});

test('the .db file keeps no PIN and no session token in clear', () => {
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  const bytes = fs.readFileSync(path.join(dir, 'data', 'studio.db'));
  const token = alice.cookie.split('=')[1];
  assert.equal(bytes.includes(token), false);
  for (const pin of ['3141', '5678', '2468', '7777', '1357']) assert.equal(bytes.includes(`"${pin}"`), false);
  const peek = new Database(path.join(dir, 'data', 'studio.db'), { readonly: true });
  assert.ok(peek.prepare('SELECT COUNT(*) AS n FROM sessions').get().n >= 0);
  peek.close();
});
