import fs from 'node:fs';
import path from 'node:path';

/**
 * Stands in for `claude -p`: same flags in, same JSON out, nothing asked of anyone.
 * It answers from <dir>/answers.json, a list used up one per call, and appends what
 * it was asked to <dir>/asked.jsonl. An answer may be:
 *   { title, script, scenes }   a normal answer
 *   { raw: "text" }             printed as is (not JSON)
 *   { error: "message" }        a result with is_error set
 *   { hang: true }              starts a child and never answers, to be cancelled
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const dir = process.env.FAKE_CLAUDE_DIR;
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
let stdin = '';
process.stdin.on('data', (d) => (stdin += d)).on('end', () => {
  const file = path.join(dir, 'answers.json');
  const answers = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = answers.shift();
  fs.writeFileSync(file, JSON.stringify(answers));
  // The message arrives as one stream-json line: text blocks, and pictures or PDFs in base64.
  const content = JSON.parse(stdin.trim().split('\\n')[0]).message.content;
  const prompt = content.filter((c) => c.type === 'text').map((c) => c.text).join('\\n');
  const blocks = content.filter((c) => c.type !== 'text').map((c) => ({ type: c.type, media: c.source.media_type, bytes: Buffer.from(c.source.data, 'base64').length }));
  fs.appendFileSync(path.join(dir, 'asked.jsonl'), JSON.stringify({ argv, stdin: prompt, blocks, cwd: process.cwd(), nested: !!process.env.CLAUDECODE }) + '\\n');
  if (!next) { console.error('fake claude: no answer left'); process.exit(1); }
  if (next.hang) {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'grandchild.pid'), String(child.pid));
    return setTimeout(() => {}, 30000);
  }
  if (next.raw !== undefined) return console.log(next.raw);
  const result = next.error
    ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: next.error }
    : {
        type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(next), structured_output: next, total_cost_usd: 0.25, duration_ms: 1200,
        usage: { input_tokens: 900, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: 4000 },
        modelUsage: { 'claude-opus-5-5': { inputTokens: 900, outputTokens: 4000 } },
      };
  // stream-json output: one event per line, the result last.
  console.log(JSON.stringify({ type: 'system', subtype: 'init', tools: [], schema: !!flag('--json-schema') }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [] } }));
  console.log(JSON.stringify(result));
});
`;

/**
 * Stands in for video/check.py. It reads the files like the real one and decides from
 * words in scenes.py: BROKEN is an error, CROWDED a warning. It records each call.
 */
const FAKE_CHECK = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root, ...flags] = process.argv.slice(2);
const scenes = fs.readFileSync(path.join(root, 'scenes.py'), 'utf8');
const script = fs.readFileSync(path.join(root, 'script.txt'), 'utf8');
// A lock file shows whether two checks ever ran at once; SLOW makes a check last long enough to tell.
const lock = path.join(process.env.FAKE_CLAUDE_DIR, 'check.lock');
const overlap = fs.existsSync(lock);
fs.writeFileSync(lock, root);
process.on('exit', () => fs.rmSync(lock, { force: true }));
if (scenes.includes('SLOW')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_DIR, 'checked.jsonl'), JSON.stringify({ root, flags, scenes, overlap }) + '\\n');
if (scenes.includes('CRASH')) { console.error('check.py: boom'); process.exit(2); }
const names = [...scenes.matchAll(/^class (\\w+)\\(VoiceoverScene/gm)].map((m) => m[1]);
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
project.scenes = names;
fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify(project, null, 2));
const errors = scenes.includes('BROKEN')
  ? [{ where: names[0] || 'scenes.py', message: 'Traceback (most recent call last):\\n  File "scenes.py", line 7, in construct\\nNameError: name \\'MathTex\\' is not defined' }]
  : scenes.includes('FIXABLE')
    ? [{ where: 'scenes.py', message: 'line 8: block "intro" has no mark "slpoe". Its marks: slope' }]
    : [];
// A storyboard like the real check's: one block, a still at its end.
const frames = path.join(root, 'build', 'check', 'frames');
fs.mkdirSync(frames, { recursive: true });
fs.writeFileSync(path.join(frames, 'Intro-intro.png'), 'PNG');
const still = { block: 'intro', mark: null, file: 'Intro-intro.png', at: 12.5 };
const board = { version: 1, duration: 12.5, unplayed: [], scenes: names.map((name) => ({ name, error: null, end: null, issues: [], blocks: [{ id: 'intro', text: script.trim().split('\\n').slice(1).join('\\n'), duration: 12.5, start: 0, marks: { slope: 1.5 }, wav: 'audio/intro-x.wav', stills: [still], issues: [] }] })) };
fs.writeFileSync(path.join(root, 'build', 'check', 'storyboard.json'), JSON.stringify(board));
const warnings = [...scenes.matchAll(/CROWDED/g)].map(() => ({ where: names[0], message: 'text "A" and text "B" overlap at the end of block "intro"' }));
console.error('$ narrate.py ' + root);
console.log(JSON.stringify({ ok: !errors.length, errors, warnings, scenes: names, blocks: [{ id: 'intro', words: script.split(/\\s+/).length }], duration: 12.5 }));
process.exit(errors.length ? 1 : 0);
`;

/** Stands in for video/autofix.py: rewrites FIXABLE to "autofixed" and says so. */
const FAKE_AUTOFIX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [root] = process.argv.slice(2);
const file = path.join(root, 'scenes.py');
const scenes = fs.readFileSync(file, 'utf8');
fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_DIR, 'autofixed.jsonl'), JSON.stringify({ root, args: process.argv.slice(3) }) + '\\n');
if (!scenes.includes('FIXABLE')) { console.log(JSON.stringify({ changed: false, fixes: [] })); process.exit(0); }
fs.writeFileSync(file, scenes.replace(/FIXABLE/g, 'autofixed'));
console.log(JSON.stringify({ changed: true, fixes: ['line 8: mark "slpoe" in block "intro" is "slope"'] }));
`;

export const SCRIPT = '[intro]\nEvery line has a <mark name="slope"/>slope.\n';
export const scenes = (body = '') => `from manimlib import *
from voiceover import VoiceoverScene


class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.wait(vo.remaining())${body ? `  ${body}` : ''}
`;
export const answer = (body = '', extra = {}) => ({ title: 'Slope, quickly', script: SCRIPT, scenes: scenes(body), ...extra });

/** A temp folder holding the two fakes, a video/ folder, and a config that points at them. */
export function sandbox(dir) {
  const videoDir = path.join(dir, 'video');
  fs.mkdirSync(path.join(videoDir, 'projects'), { recursive: true });
  const claudeBin = path.join(dir, 'fake-claude.js');
  const checkBin = path.join(dir, 'fake-check.js');
  const autofixBin = path.join(dir, 'fake-autofix.js');
  fs.writeFileSync(claudeBin, FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(checkBin, FAKE_CHECK, { mode: 0o755 });
  fs.writeFileSync(autofixBin, FAKE_AUTOFIX, { mode: 0o755 });
  process.env.FAKE_CLAUDE_DIR = dir;
  const config = {
    videoDir,
    claudeBin,
    claudeModel: '',
    claudeEffort: 'high',
    claudeFixEffort: 'low',
    claudePolishEffort: 'medium',
    claudeTimeoutMs: 20000,
    checkTimeoutMs: 20000,
    authorMaxFixes: 2,
    authorPolish: true,
    authorVisualReview: false,
    authorParallel: 2,
    authorCheck: [checkBin],
    authorAutofix: [autofixBin],
    authorPort: 0,
    authorUrl: '',
  };
  const lines = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return {
    config,
    getConfig: () => config,
    answers: (list) => {
      fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(list));
      fs.rmSync(path.join(dir, 'asked.jsonl'), { force: true });
      fs.rmSync(path.join(dir, 'checked.jsonl'), { force: true });
      fs.rmSync(path.join(dir, 'autofixed.jsonl'), { force: true });
    },
    autofixed: () => lines('autofixed.jsonl'),
    asked: () => lines('asked.jsonl'),
    checked: () => lines('checked.jsonl'),
    project: (name) => path.join(videoDir, 'projects', name),
    read: (name, file) => fs.readFileSync(path.join(videoDir, 'projects', name, file), 'utf8'),
    exists: (name, file) => fs.existsSync(path.join(videoDir, 'projects', name, file)),
  };
}

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
