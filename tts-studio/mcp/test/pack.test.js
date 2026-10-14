import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest } from '../../scripts/mcpb-manifest.js';

test('the desktop extension asks for a connector token and hands it to the connector', () => {
  const m = buildManifest({ version: '1.2.3' });
  assert.equal(m.manifest_version, '0.3', 'user_config needs 0.3');
  assert.deepEqual(m.user_config.token, { type: 'string', title: 'Connector token', description: m.user_config.token.description, sensitive: true, required: false });
  assert.equal(m.server.mcp_config.env.NARRATED_PROOFS_TOKEN, '${user_config.token}');
  assert.equal(m.server.mcp_config.env.NARRATED_PROOFS_URL, 'http://127.0.0.1:8787');
  assert.equal(buildManifest({ version: '1', url: 'http://127.0.0.1:9000' }).server.mcp_config.env.NARRATED_PROOFS_URL, 'http://127.0.0.1:9000');
  assert.equal(m.tools.length, 15);
});
