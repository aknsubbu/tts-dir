import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthorError, run } from './proc.js';

/** What Claude must return: the three parts of a lesson. */
export const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short title for the video, at most 60 characters' },
    script: { type: 'string', description: 'Full text of script.txt' },
    scenes: { type: 'string', description: 'Full text of scenes.py' },
  },
  required: ['title', 'script', 'scenes'],
  additionalProperties: false,
};

// Set by a Claude Code session for its children. Passed on, they make the CLI think it is nested.
const NESTING = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

/**
 * The one message sent to Claude: any pictures and PDFs first, each with a line naming it,
 * then the prompt. `attachments` is [{ name, kind, type, path }] with kind 'image' or 'pdf'.
 */
export function userMessage(prompt, attachments = []) {
  const content = [];
  for (const a of attachments) {
    const data = fs.readFileSync(a.path).toString('base64');
    content.push({ type: 'text', text: `Attached to the notes: ${a.name}` });
    content.push(
      a.kind === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: a.name }
        : { type: 'image', source: { type: 'base64', media_type: a.type || 'image/jpeg', data } },
    );
  }
  content.push({ type: 'text', text: prompt });
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

/**
 * Ask Claude one question with `claude -p` and return the object it answers with.
 *
 * It runs with no tools, so it can only write text back: it cannot read or change
 * anything on this machine. Pictures and PDFs reach it inside the message itself, which
 * is why the message goes in as stream-json. --safe-mode leaves out the user's hooks,
 * plugins and CLAUDE.md files, which have nothing to do with writing a lesson.
 */
export async function askClaude({ system, prompt, attachments = [], schema = LESSON_SCHEMA, nonEmpty, config, signal, effort, model }) {
  const bin = config.claudeBin || 'claude';
  const args = [
    '-p',
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose', // stream-json output needs it
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ];
  // A model chosen in Settings, else TTS_CLAUDE_MODEL, else Claude Code's own default.
  const chosen = model === undefined || model === '' ? config.claudeModel : model;
  if (chosen) args.push('--model', chosen);
  // Each step may ask for its own effort; "auto" or empty leaves it to Claude Code.
  const level = effort === undefined ? config.claudeEffort : effort;
  if (level && level !== 'auto') args.push('--effort', level);
  const cwd = path.join(os.tmpdir(), 'tts-studio-author'); // a folder with no project in it
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  for (const key of NESTING) delete env[key];

  let done;
  try {
    const input = `${JSON.stringify(userMessage(prompt, attachments))}\n`;
    done = await run(bin, args, { input, cwd, env, signal, timeoutMs: config.claudeTimeoutMs });
  } catch (e) {
    if (e.message.startsWith('Could not find')) {
      throw new AuthorError(`Could not find the Claude Code command (${bin}). Install Claude Code, or set TTS_CLAUDE_BIN to where it is.`);
    }
    throw e;
  }
  return parseAnswer(done, schema, nonEmpty);
}

/** Every JSON value in the output: one event per line (stream-json), or a single object or list (json). */
function events(stdout) {
  try {
    const whole = JSON.parse(stdout);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    /* not one document: read it line by line */
  }
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a line that is not an event */
    }
  }
  return out;
}

/**
 * Pull the answer out of what `claude -p` printed. `nonEmpty` are the fields that must hold
 * text (all the required ones unless said otherwise: an edit's parts may be left empty).
 */
export function parseAnswer({ code, stdout, stderr }, schema = LESSON_SCHEMA, nonEmpty = schema.required) {
  const all = events(stdout);
  if (!all.length) {
    const said = (stderr.trim() || stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 400);
    throw new AuthorError(`Claude did not answer${code ? ` (exit ${code})` : ''}. ${said}`.trim());
  }
  // The last "result" event is the answer; a lone object without a type is taken as one.
  const result = all.findLast((m) => m?.type === 'result') || (all.length === 1 && !all[0].type ? all[0] : null);
  if (!result) throw new AuthorError('Claude finished without a result.');
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    throw new AuthorError(`Claude could not answer: ${String(result.result || result.subtype).slice(0, 400)}`);
  }
  let answer = result.structured_output;
  if (!answer) {
    try {
      answer = JSON.parse(String(result.result).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new AuthorError('Claude answered, but not in the format asked for.');
    }
  }
  for (const key of nonEmpty) {
    if (typeof answer[key] !== 'string' || !answer[key].trim()) {
      throw new AuthorError(`Claude's answer is missing “${key}”.`);
    }
  }
  return { answer, costUsd: Number(result.total_cost_usd) || 0, usage: readUsage(result) };
}

const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * What one request used, from Claude Code's result: tokens read fresh, read from the cache and
 * written to it, tokens written back (thinking included), the cost and the model(s) that answered.
 */
export function readUsage(result) {
  const u = result.usage || {};
  return {
    model: Object.keys(result.modelUsage || {}).join(', ') || null,
    inputTokens: count(u.input_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    outputTokens: count(u.output_tokens),
    costUsd: Number(result.total_cost_usd) || 0,
    durationMs: count(result.duration_ms),
  };
}
