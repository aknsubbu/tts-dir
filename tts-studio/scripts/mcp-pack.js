#!/usr/bin/env node
// Package the MCP connector as a Claude desktop extension: extension/narrated-proofs.mcpb.
// Not in dist/, which the page's build empties every time it runs.
// Open the file and the desktop app installs it. The extension runs mcp/stdio.js from this
// folder, so it works on this Mac only, and only while the folder stays where it is.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './mcpb-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stdio = path.join(root, 'mcp', 'stdio.js');

const manifest = buildManifest({ version: pkg.version, url: process.env.NARRATED_PROOFS_URL });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mcpb-'));
fs.mkdirSync(path.join(work, 'server'));
fs.writeFileSync(path.join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// The entry point only starts the connector that lives in this folder, with its own packages.
fs.writeFileSync(path.join(work, 'server', 'index.js'), `// Runs the Narrated Proofs connector from where it is installed.\nawait import(${JSON.stringify(new URL(`file://${stdio}`).href)});\n`);
fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify({ name: 'narrated-proofs-mcpb', private: true, type: 'module' }, null, 2)}\n`);

const out = path.join(root, 'extension', 'narrated-proofs.mcpb');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
try {
  execFileSync('zip', ['-q', '-r', out, '.'], { cwd: work });
} catch {
  console.error('Could not run zip. Add the connector to the desktop app with the config entry from Settings → Connect Claude instead.');
  process.exit(1);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n  ${out}\n  Open it to install the connector in the Claude desktop app. It runs ${stdio}.\n`);
