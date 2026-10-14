import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkHost, createGuardedFetch, guardedFetch, isMetadataAddress, isMetadataName } from '../writers/net.js';
import { openaiClient } from '../writers/openai.js';

test('metadata and link-local addresses are recognised however they are written', () => {
  for (const ip of ['169.254.169.254', '169.254.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '[fd00:ec2::254]', 'FD00:EC2::254', 'fe80::1', 'febf::1', '169.254.169.254.']) assert.equal(isMetadataAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.2', '8.8.8.8', '::1', 'fd12:3456::1', '169.253.1.1', 'localhost', 'example.com']) assert.equal(isMetadataAddress(ip), false, ip);
  for (const name of ['metadata.google.internal', 'Metadata.Google.Internal.', 'instance-data']) assert.equal(isMetadataName(name), true, name);
});

test('a name that points at one is refused, whatever it is called', async () => {
  const lookup = async (h) => (h === 'innocent.example' ? [{ address: '93.184.216.34' }, { address: '169.254.169.254' }] : [{ address: '93.184.216.34' }]);
  await assert.rejects(checkHost('innocent.example', { lookup }), /not one a provider can be reached at/);
  await checkHost('fine.example', { lookup });
  await checkHost('127.0.0.1', { lookup }); // a model on this Mac
  await checkHost('192.168.1.20', { lookup }); // or another machine at home
  await checkHost('does-not-resolve.example', { lookup: async () => { throw new Error('ENOTFOUND'); } }); // the request will say so
});

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('provider requests do not follow a redirect, and still reach an ordinary address', async () => {
  assert.deepEqual(await (await guardedFetch(`http://127.0.0.1:${port}/fine`)).json(), { ok: true });
  await assert.rejects(guardedFetch(`http://127.0.0.1:${port}/go`), /answered with a redirect/);
  await assert.rejects(guardedFetch('http://169.254.169.254/latest/meta-data/'), /not one a provider can be reached at/);
});

test('the OpenAI-style client uses the guarded fetch, so a redirect from a custom address goes nowhere', async () => {
  const client = openaiClient({ key: 'k', writer: { baseUrl: `http://127.0.0.1:${port}` }, config: {} }).withOptions({ maxRetries: 0 });
  await assert.rejects(client.get('/go'), (e) => /redirect/.test(e.cause?.message || e.message)); // the SDK wraps what the guard threw
});

test('the address is checked when the connection is made, so a name cannot answer one thing to a check and another to the connection', async () => {
  const answers = {
    'good.example': [{ address: '127.0.0.1', family: 4 }],
    'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
    'mapped.example': [{ address: '::ffff:169.254.169.254', family: 6 }],
  };
  const asked = [];
  const resolve = (host, options, cb) => {
    asked.push(host);
    if (answers[host]) return cb(null, answers[host]);
    return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  };
  const guarded = createGuardedFetch({ resolve });
  // A name that leads only to a good address connects there: to the very address that was checked.
  assert.deepEqual(await (await guarded(`http://good.example:${port}/fine`)).json(), { ok: true });
  assert.ok(asked.includes('good.example'));
  // A name with a metadata address among its answers, in any spelling, is refused before any connection.
  await assert.rejects(guarded(`http://rebind.example:${port}/`), (e) => /not one a provider can be reached at/.test(e.cause?.message || e.message));
  await assert.rejects(guarded(`http://mapped.example:${port}/`), (e) => /not one a provider can be reached at/.test(e.cause?.message || e.message));
  // And a redirect from a good name is still not followed.
  await assert.rejects(guarded(`http://good.example:${port}/go`), /redirect/);
});
