#!/usr/bin/env node
// The MCP connector over stdio, for the Claude desktop app and Claude Code:
//   claude mcp add narrated-proofs -- node /path/to/tts-studio/mcp/stdio.js
// It talks to the running dashboard (NARRATED_PROOFS_URL, default http://127.0.0.1:8787).
// With TTS_MCP_AUTOSTART=1 it starts the dashboard when it finds it not running.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, DEFAULT_URL } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = (process.env.NARRATED_PROOFS_URL || DEFAULT_URL).replace(/\/+$/, '');

async function startDashboard() {
  if (process.env.TTS_MCP_AUTOSTART !== '1') return false;
  const child = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], { cwd: path.join(here, '..'), detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
  }
  return false;
}

const server = createMcpServer({ baseUrl, onDown: startDashboard });
await server.connect(new StdioServerTransport());
