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
import { connectorAllows } from '../profile-routes.js';
import { createMcpServer } from '../../mcp/server.js';
import { mcpHandler } from '../../mcp/http.js';

let dir, store, profiles, server, base, ownerId, robinId, theApp;
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
  theApp = app;
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

/** Every route of the API, read from the router, with parameters filled in. */
function apiRoutes(app) {
  const out = [];
  const walk = (router) => {
    for (const layer of router.stack) {
      if (layer.route && typeof layer.route.path === 'string') {
        for (const method of Object.keys(layer.route.methods)) if (method !== '_all') out.push([method.toUpperCase(), layer.route.path]);
      } else if (layer.handle?.stack) walk(layer.handle);
    }
  };
  walk(app.router);
  return out.filter(([, p]) => p !== '/').map(([m, p]) => [m, p.replace(/:ext/, 'vtt').replace(/:\w+/g, 'abc')]);
}

test('a token can do what Claude’s tools do and nothing else: the list is explicit', async () => {
  const routes = apiRoutes(theApp);
  const allowed = routes.filter(([m, p]) => connectorAllows(m, p)).map(([m, p]) => `${m} ${p}`).sort();
  assert.deepEqual(allowed, [
    'GET /generations', 'GET /generations/abc', 'GET /generations/abc/captions.vtt', 'GET /generations/abc/files', 'GET /generations/abc/outline', 'GET /generations/abc/poster',
    'GET /generations/abc/source', 'GET /generations/abc/storyboard', 'GET /generations/abc/storyboard/abc', 'GET /health', 'GET /settings', 'GET /voices',
    'PATCH /settings', 'POST /estimate', 'POST /generations/abc/approve', 'POST /generations/abc/cancel', 'POST /generations/abc/outline/redo', 'POST /generations/abc/retry',
    'POST /generations/abc/revise', 'POST /lessons', 'POST /providers/abc/test',
  ].sort());
  // And what it cannot, tried for real with a working token: deleting, editing, building, keys and providers.
  const claude = browser();
  const as = bearer(ownerToken);
  for (const [method, url, body] of [
    ['DELETE', '/api/generations/owners-lesson'], ['PATCH', '/api/generations/owners-lesson', { title: 'x' }], ['PUT', '/api/generations/owners-lesson/source', { script: 'x' }],
    ['POST', '/api/generations/owners-lesson/build', {}], ['POST', '/api/generations/owners-lesson/discard', {}], ['POST', '/api/generations/owners-lesson/restore', { version: 1 }],
    ['POST', '/api/generations', { text: 'hi' }], ['POST', '/api/videos', { project: 'x' }], ['PUT', '/api/providers/groq/key', { key: 'gsk_stolen_key_1234' }],
    ['DELETE', '/api/providers/groq/key'], ['PUT', '/api/providers/new', { baseUrl: 'https://evil.example/v1' }], ['GET', '/api/events'], ['GET', '/api/generations/owners-lesson/audio'],
  ]) assert.equal((await claude.call(method, url, body, as)).status, 403, `${method} ${url}`);
  assert.equal(store.getRaw('owners-lesson')?.title, 'Owner quaternions', 'nothing was deleted or renamed');
});

test('a token that has not been used for 90 days stops working', async () => {
  let t = 1_000_000;
  const p = createProfiles({ db: store.db, dataDir: dir, now: () => t, ipMax: 10_000 });
  const x = p.create({ name: 'Idle' });
  const made = p.createToken(x.id, 'old');
  assert.equal(p.tokenProfile(made.token).id, x.id);
  t += 89 * 24 * 3600_000;
  assert.equal(p.tokenProfile(made.token).id, x.id, 'used within 90 days, so it lives on');
  t += 89 * 24 * 3600_000;
  assert.equal(p.tokenProfile(made.token).id, x.id, '90 days from last use, not from creation');
  t += 91 * 24 * 3600_000;
  assert.equal(p.tokenProfile(made.token), null);
  assert.equal(p.listTokens(x.id).length, 0, 'and it is gone, not hidden');
  p.remove(x.id);
});

test('a token that is wrong is refused, with several profiles', async () => {
  const claude = browser();
  assert.equal((await claude.call('GET', '/api/generations', undefined, bearer('npc_nonsense'))).status, 401);
  assert.equal((await claude.call('GET', '/api/generations', undefined, { Authorization: 'Bearer ' })).status, 401);
});

test('revoking a token stops it at once, and only its own profile can', async () => {
  const extra = (await robin.call('POST', '/api/connector/tokens', { label: 'old laptop' })).data;
  const claude = browser();
  assert.equal((await claude.call('GET', '/api/voices', undefined, bearer(extra.token))).status, 200);
  assert.equal((await owner.call('DELETE', `/api/connector/tokens/${extra.id}`)).status, 404, 'not the Owner’s to revoke');
  assert.equal((await robin.call('DELETE', `/api/connector/tokens/${extra.id}`)).status, 200);
  assert.equal((await claude.call('GET', '/api/voices', undefined, bearer(extra.token))).status, 401);
  assert.equal((await claude.call('GET', '/api/voices', undefined, bearer(robinToken))).status, 200, 'the others still work');
});

test('there is a limit on tokens', async () => {
  const p = profiles.create({ name: 'Many' });
  for (let i = 0; i < 10; i += 1) profiles.createToken(p.id, `t${i}`);
  assert.throws(() => profiles.createToken(p.id, 'one more'), /10 connector tokens/);
  profiles.remove(p.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM connector_tokens WHERE profile_id = ?').get(p.id).n, 0, 'deleting a profile deletes its tokens');
});

test('a PIN that is new, or reset by someone else, revokes Claude’s tokens; changing your own keeps them', async () => {
  const claude = browser();
  const status = async (token) => (await claude.call('GET', '/api/voices', undefined, bearer(token))).status;
  // A profile with no PIN can be signed in to by anyone, who could make a token: so a first PIN ends them all.
  assert.equal(await status(ownerToken), 200);
  const first = await owner.call('PUT', `/api/profiles/${ownerId}/pin`, { pin: '7777' });
  assert.equal(first.status, 200);
  assert.equal(first.data.tokensRevoked, 1);
  assert.equal(await status(ownerToken), 401);
  ownerToken = (await owner.call('POST', '/api/connector/tokens', { label: 'after the PIN' })).data.token;
  assert.equal((await robin.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '1234' })).data.tokensRevoked, 1);
  assert.equal(await status(robinToken), 401);
  robinToken = (await robin.call('POST', '/api/connector/tokens', { label: 'after the PIN' })).data.token;
  // Changing a PIN you already had, with the current one, proves who you are: the connector stays.
  const changed = await robin.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '4321', currentPin: '1234' });
  assert.equal(changed.data.tokensRevoked, 0);
  assert.equal(await status(robinToken), 200);
  // Someone else resetting it is the sign it was lost or known to others.
  const reset = await owner.call('PUT', `/api/profiles/${robinId}/pin`, { pin: '5555', ownerPin: '7777' });
  assert.equal(reset.data.tokensRevoked, 1);
  assert.equal(await status(robinToken), 401);
  assert.equal(await status(ownerToken), 200);
  await robin.call('POST', '/api/session', { profileId: robinId, pin: '5555' });
  robinToken = (await robin.call('POST', '/api/connector/tokens', { label: 'again' })).data.token;
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
  // A credential that does not work is refused here too, though there is no gate to enforce: wrong, blank, malformed, revoked.
  const url = `http://127.0.0.1:${srv.address().port}/api/voices`;
  const code = async (authorization) => (await fetch(url, { headers: authorization === undefined ? {} : { Authorization: authorization } })).status;
  assert.equal(await code(undefined), 200);
  assert.equal(await code('Bearer npc_nonsense'), 401);
  assert.equal(await code('Bearer '), 401);
  assert.equal(await code('Bearer'), 401);
  assert.equal(await code('Bearer a b'), 401);
  assert.equal(await code('Basic abc'), 200, 'other schemes are not ours');
  const made = p.createToken(p.owner().id, 'solo');
  assert.equal(await code(`Bearer ${made.token}`), 200);
  p.revokeToken(p.owner().id, made.id);
  assert.equal(await code(`Bearer ${made.token}`), 401, 'revoked means refused, not "the only profile"');
  srv.close();
  s.close();
  fs.rmSync(solo, { recursive: true, force: true });
});
