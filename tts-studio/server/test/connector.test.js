import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStore } from '../db.js';
import { createApp } from '../app.js';
import { createProfiles } from '../profiles.js';
import { createSecrets } from '../secrets.js';
import { createSettings } from '../settings.js';
import { createMcpServer } from '../../mcp/server.js';
import { mcpHandler } from '../../mcp/http.js';

let dir, store, profiles, server, base, ownerId, robinId;
const engine = { info: () => ({ status: 'ready' }), catalog: () => ({ voices: [], languages: [] }), start: async () => {} };

function browser() {
  let cookie = '';
  return {
    async call(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    },
  };
}
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const lesson = (profileId, id, title) => ({
  id, profile_id: profileId, kind: 'video', title, source_name: null, text: `${title} notes`, text_hash: id, config_hash: id, char_count: 5, word_count: 1,
  voice_id: 'af_zed', voice_name: 'Zed', model_id: 'm', settings_json: JSON.stringify({ project: id, lesson: { topic: title } }), status: 'done', tags: '', created_at: Date.now(),
});

let owner, robin, ownerToken, robinToken;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-connector-'));
  store = createStore(dir);
  const config = { defaultVoiceId: 'af_zed', videoDir: path.join(dir, 'video'), keys: {}, given: {}, maxProfiles: 5, claudeEffort: 'high', claudeFixEffort: 'low', claudePolishEffort: 'medium', claudeReadEffort: 'medium', claudeOutlineEffort: 'medium', lessonReview: 'render' };
  profiles = createProfiles({ db: store.db, dataDir: dir, ipMax: 10_000 });
  const secrets = createSecrets({ dataDir: dir, useKeychain: false });
  const settings = createSettings({ db: store.db, getConfig: () => config, secrets, profiles });
  const app = createApp({ getConfig: () => config, store, runner: { enqueue() {}, cancel: () => false }, engine, settings, secrets, profiles, mcp: mcpHandler() });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  owner = browser();
  ownerId = profiles.owner().id;
  robinId = (await owner.call('POST', '/api/profiles', { name: 'Robin' })).data.profile.id; // the Owner stays signed in
  robin = browser();
  await robin.call('POST', '/api/session', { profileId: robinId });
  store.insert(lesson(ownerId, 'owners-lesson', 'Owner quaternions'));
  store.insert(lesson(robinId, 'robins-lesson', 'Robin manifolds'));
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a profile makes a token, sees it once, and only a hash is kept', async () => {
  const made = await owner.call('POST', '/api/connector/tokens', { label: '  Claude   Code ' });
  assert.equal(made.status, 201);
  assert.match(made.data.token, /^npc_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.data.label, 'Claude Code');
  ownerToken = made.data.token;
  robinToken = (await robin.call('POST', '/api/connector/tokens', { label: 'Robin’s Claude' })).data.token;
  const listed = (await owner.call('GET', '/api/connector/tokens')).data.tokens;
  assert.deepEqual(listed.map((t) => t.label), ['Claude Code']);
  assert.ok(!JSON.stringify(listed).includes(ownerToken));
  store.db.pragma('wal_checkpoint(TRUNCATE)');
  assert.equal(fs.readFileSync(path.join(dir, 'studio.db')).includes(ownerToken), false, 'the token is not in the database');
  assert.equal(store.db.prepare('SELECT token_hash FROM connector_tokens').all().every((r) => r.token_hash !== ownerToken), true);
  assert.equal((await browser().call('POST', '/api/connector/tokens', {})).status, 401, 'making one needs a signed-in profile');
});

test('a token acts as exactly one profile, with no cookie and a gate in place', async () => {
  const claude = browser();
  const mine = await claude.call('GET', '/api/generations', undefined, bearer(ownerToken));
  assert.deepEqual(mine.data.items.map((g) => g.id), ['owners-lesson']);
  const theirs = await claude.call('GET', '/api/generations', undefined, bearer(robinToken));
  assert.deepEqual(theirs.data.items.map((g) => g.id), ['robins-lesson']);
  assert.equal((await claude.call('GET', '/api/generations/robins-lesson', undefined, bearer(ownerToken))).status, 404);
  assert.equal((await claude.call('GET', '/api/generations/owners-lesson', undefined, bearer(robinToken))).status, 404);
  assert.equal((await claude.call('GET', '/api/generations')).status, 401, 'no token, no cookie: the gate');
});

test('a token is Claude: it gets Claude’s limits whatever it claims, and cannot manage people', async () => {
  const claude = browser();
  const as = bearer(ownerToken);
  assert.equal((await claude.call('PATCH', '/api/settings', { costs: { lessonCapUsd: 99 } }, as)).status, 403, 'cannot raise a cap');
  assert.equal((await claude.call('PUT', '/api/providers/groq/key', { key: 'gsk_stolen_key_1234' }, as)).status, 403);
  assert.equal((await claude.call('POST', '/api/settings/undo', {}, as)).status, 403);
  assert.equal((await claude.call('PATCH', '/api/settings', { 'claude.defaults': { quality: 'medium' } }, as)).status, 200);
  for (const [method, url, body] of [
    ['POST', '/api/profiles', { name: 'Intruder' }], ['PATCH', `/api/profiles/${ownerId}`, { name: 'x' }], ['PUT', `/api/profiles/${ownerId}/pin`, { pin: '1111' }],
    ['DELETE', `/api/profiles/${robinId}`, { confirmName: 'Robin' }], ['POST', '/api/session', { profileId: robinId }], ['POST', '/api/connector/tokens', {}], ['GET', '/api/connector/tokens'], ['GET', '/api/profiles/all'],
  ]) assert.equal((await claude.call(method, url, body, as)).status, 403, `${method} ${url}`);
  assert.equal(profiles.list().length, 2);
});

test('a token that is wrong is refused, even where there is no gate', async () => {
  const claude = browser();
  assert.equal((await claude.call('GET', '/api/generations', undefined, bearer('npc_nonsense'))).status, 401);
  assert.equal((await claude.call('GET', '/api/generations', undefined, { Authorization: 'Bearer ' })).status, 401);
});

test('revoking a token stops it at once, and only its own profile can', async () => {
  const extra = (await robin.call('POST', '/api/connector/tokens', { label: 'old laptop' })).data;
  const claude = browser();
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(extra.token))).status, 200);
  assert.equal((await owner.call('DELETE', `/api/connector/tokens/${extra.id}`)).status, 404, 'not the Owner’s to revoke');
  assert.equal((await robin.call('DELETE', `/api/connector/tokens/${extra.id}`)).status, 200);
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(extra.token))).status, 401);
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(robinToken))).status, 200, 'the others still work');
});

test('there is a limit on tokens', async () => {
  const p = profiles.create({ name: 'Many' });
  for (let i = 0; i < 10; i += 1) profiles.createToken(p.id, `t${i}`);
  assert.throws(() => profiles.createToken(p.id, 'one more'), /10 connector tokens/);
  profiles.remove(p.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM connector_tokens WHERE profile_id = ?').get(p.id).n, 0, 'deleting a profile deletes its tokens');
});

test('the Owner resetting someone’s PIN revokes their tokens; changing your own does not', async () => {
  assert.equal((await owner.call('PUT', `/api/profiles/${ownerId}/pin`, { pin: '7777' })).status, 200);
  assert.equal((await robin.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '1234' })).status, 200);
  assert.equal((await robin.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '4321', currentPin: '1234' })).status, 200);
  const claude = browser();
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(robinToken))).status, 200, 'your own change keeps your connector');
  assert.equal((await owner.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '5555', ownerPin: '7777' })).status, 200);
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(robinToken))).status, 401, 'a reset by someone else does not');
  assert.equal((await claude.call('GET', '/api/stats', undefined, bearer(ownerToken))).status, 200);
  robinToken = (await (async () => { // Robin signs in again with the new PIN and makes a fresh token
    await robin.call('POST', '/api/session', { profileId: robinId, pin: '5555' });
    return robin.call('POST', '/api/connector/tokens', { label: 'again' });
  })()).data.token;
});

test('a token works through the MCP connector, over HTTP and in memory: Claude sees only its profile', async () => {
  const connect = async (token) => {
    const mcp = createMcpServer({ baseUrl: base, token, waitMs: 500, pollMs: 20 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(b);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(a);
    return client;
  };
  const said = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const mine = await connect(ownerToken);
  const found = await mine.callTool({ name: 'search_lessons', arguments: {} });
  assert.match(said(found), /owners-lesson/);
  assert.doesNotMatch(said(found), /robins-lesson/);
  const stranger = await mine.callTool({ name: 'get_lesson', arguments: { id: 'robins-lesson' } });
  assert.equal(stranger.isError, true);
  assert.match(said(await (await connect(robinToken)).callTool({ name: 'search_lessons', arguments: {} })), /robins-lesson/);
  // No token while people share the dashboard: Claude is told how to connect, not given a stack trace.
  const tokenless = await (await connect(null)).callTool({ name: 'search_lessons', arguments: {} });
  assert.equal(tokenless.isError, true);
  assert.match(said(tokenless), /Settings → Connect Claude/);
  // A revoked or wrong token says so.
  const wrong = await (await connect('npc_wrong')).callTool({ name: 'search_lessons', arguments: {} });
  assert.match(said(wrong), /does not accept this connector’s token/);
  // /mcp over HTTP forwards the Authorization header it is given.
  const http = new Client({ name: 'http', version: '1' });
  await http.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer(ownerToken) } }));
  assert.match(said(await http.callTool({ name: 'search_lessons', arguments: {} })), /owners-lesson/);
  await http.close();
});

test('with one profile and no PIN, /mcp works with no token, as before', async () => {
  const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'np-solo-'));
  const s = createStore(solo);
  const p = createProfiles({ db: s.db, dataDir: solo });
  s.insert(lesson(p.owner().id, 'solo-lesson', 'Solo'));
  const app = createApp({ getConfig: () => ({ defaultVoiceId: 'af_zed', keys: {}, given: {} }), store: s, runner: { enqueue() {}, cancel: () => false }, engine, profiles: p });
  const srv = await new Promise((r) => {
    const x = app.listen(0, '127.0.0.1', () => r(x));
  });
  const mcp = createMcpServer({ baseUrl: `http://127.0.0.1:${srv.address().port}`, waitMs: 500, pollMs: 20 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  const r = await client.callTool({ name: 'search_lessons', arguments: {} });
  assert.match(r.content[0].text, /solo-lesson/);
  srv.close();
  s.close();
  fs.rmSync(solo, { recursive: true, force: true });
});
