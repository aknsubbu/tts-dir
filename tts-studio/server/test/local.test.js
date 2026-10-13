import test from 'node:test';
import assert from 'node:assert/strict';
import { localOnly, isPrivateNetwork } from '../local.js';

function run(mw, headers, method = 'GET') {
  let status = 200;
  let passed = false;
  const res = { status: (s) => ((status = s), { json: () => {} }) };
  mw({ headers, method }, res, () => (passed = true));
  return passed ? 200 : status;
}

test('private addresses, .local and bare names count as the network; public names do not', () => {
  for (const ok of ['192.168.1.156', '10.0.0.4', '172.20.1.1', 'macbook', 'mac.local']) assert.ok(isPrivateNetwork(ok), ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', 'evil.example.com', '192.169.1.1']) assert.ok(!isPrivateNetwork(bad), bad);
});

test('by default only localhost answers', () => {
  const mw = localOnly();
  assert.equal(run(mw, { host: 'localhost:8787' }), 200);
  assert.equal(run(mw, { host: '192.168.1.156:8787' }), 403);
});

test('with LAN on, a private address answers, but other sites and rebinding names do not', () => {
  const mw = localOnly({ lan: () => true });
  assert.equal(run(mw, { host: '192.168.1.156:8787' }), 200);
  assert.equal(run(mw, { host: '192.168.1.156:8787', origin: 'http://192.168.1.156:8787' }, 'POST'), 200);
  assert.equal(run(mw, { host: '192.168.1.156:8787', origin: 'https://evil.example.com' }, 'POST'), 403);
  assert.equal(run(mw, { host: 'evil.example.com' }), 403);
  assert.equal(run(mw, { host: '192.168.1.156:8787', origin: 'http://192.168.1.99:8787' }, 'POST'), 403);
});
