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
 * Ask Claude one question with `claude -p` and return the object it answers with.
 *
 * It runs with no tools, so it can only write text back: it cannot read or change
 * anything on this machine. --safe-mode leaves out the user's hooks, plugins and
 * CLAUDE.md files, which have nothing to do with writing a lesson.
 */
export async function askClaude({ system, prompt, schema = LESSON_SCHEMA, config, signal }) {
  const bin = config.claudeBin || 'claude';
  const args = [
    '-p',
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ];
  if (config.claudeModel) args.push('--model', config.claudeModel);
  if (config.claudeEffort) args.push('--effort', config.claudeEffort);
  const cwd = path.join(os.tmpdir(), 'tts-studio-author'); // a folder with no project in it
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  for (const key of NESTING) delete env[key];

  let done;
  try {
    done = await run(bin, args, { input: prompt, cwd, env, signal, timeoutMs: config.claudeTimeoutMs });
  } catch (e) {
    if (e.message.startsWith('Could not find')) {
      throw new AuthorError(`Could not find the Claude Code command (${bin}). Install Claude Code, or set TTS_CLAUDE_BIN to where it is.`);
    }
    throw e;
  }
  return parseAnswer(done, schema);
}

/** Pull the answer out of what `claude -p --output-format json` printed. */
export function parseAnswer({ code, stdout, stderr }, schema = LESSON_SCHEMA) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const said = (stderr.trim() || stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 400);
    throw new AuthorError(`Claude did not answer${code ? ` (exit ${code})` : ''}. ${said}`.trim());
  }
  // One object, or with verbose output a list of events whose last "result" is the answer.
  const result = Array.isArray(parsed) ? parsed.findLast((m) => m?.type === 'result') : parsed;
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
  for (const key of schema.required) {
    if (typeof answer[key] !== 'string' || !answer[key].trim()) {
      throw new AuthorError(`Claude's answer is missing “${key}”.`);
    }
  }
  return { answer, costUsd: Number(result.total_cost_usd) || 0 };
}
