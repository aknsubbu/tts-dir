import fs from 'node:fs';
import { AuthorError } from '../proc.js';

/**
 * A provider could not give a usable answer. `kind` says why, so the pipeline and the Test
 * can tell a format problem (worth one retry) from a missing key or a reached limit:
 *   format       the answer was not the JSON asked for
 *   request      the provider refused the request itself (often: a feature it lacks)
 *   auth         the key was refused
 *   limit        a rate or daily limit was reached
 *   model        no such model
 *   unreachable  nothing answered at the address
 *   refused      the model declined to answer
 *   cut          the answer was cut off before it ended
 */
export class ProviderError extends AuthorError {
  constructor(message, kind = 'failed', usage = null) {
    super(message);
    this.kind = kind;
    this.usage = usage; // tokens spent on an answer that could not be used
  }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** The JSON object in a model's answer: fences, a thinking preamble and stray text are dropped. */
export function parseJsonAnswer(text, label = 'The model') {
  let s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ProviderError(`${label} answered, but not with a JSON object.`, 'format');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new ProviderError(`${label} answered with JSON that does not parse (${e.message.slice(0, 120)}).`, 'format');
  }
}

/** The fields that must hold text are non-empty strings (by default, every required field). */
export function checkAnswer(answer, schema, label = 'The model', nonEmpty = schema.required || []) {
  if (!isObject(answer)) throw new ProviderError(`${label} answered, but not with a JSON object.`, 'format');
  for (const key of nonEmpty) {
    if (typeof answer[key] !== 'string' || !answer[key].trim()) throw new ProviderError(`${label}'s answer is missing “${key}”.`, 'format');
  }
  return answer;
}

/** For models without schema support: the format, said in words, added to the system prompt. */
export function schemaInstructions(schema) {
  return [
    'Answer with one JSON object and nothing else: no Markdown fence and no text before or after it.',
    'It must match this JSON Schema:',
    JSON.stringify(schema, null, 2),
    'Each string holds the complete text of that field, with line breaks written as \\n inside the string.',
  ].join('\n');
}

const base64 = (file) => fs.readFileSync(file).toString('base64');

/** The notes' pictures and PDFs, each after a line naming it, in a provider's own shape. */
export function attachmentParts(attachments, style) {
  const parts = [];
  for (const a of attachments) {
    parts.push({ type: 'text', text: `Attached to the notes: ${a.name}` });
    const data = base64(a.path);
    if (style === 'anthropic') {
      parts.push(
        a.kind === 'pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: a.name }
          : { type: 'image', source: { type: 'base64', media_type: a.type || 'image/jpeg', data } },
      );
    } else {
      parts.push(
        a.kind === 'pdf'
          ? { type: 'file', file: { filename: a.name, file_data: `data:application/pdf;base64,${data}` } }
          : { type: 'image_url', image_url: { url: `data:${a.type || 'image/jpeg'};base64,${data}` } },
      );
    }
  }
  return parts;
}

const said = (e) => String(e?.error?.error?.message || e?.error?.message || e?.error || e?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** Turn whatever an SDK or fetch threw into an AuthorError a person can act on. */
export function translateError(e, writer, signal) {
  if (e instanceof AuthorError) return e;
  const name = e?.constructor?.name || e?.name || '';
  if (signal?.aborted || name === 'APIUserAbortError' || (name === 'AbortError' && signal?.aborted)) return new AuthorError('Cancelled', 'aborted');
  const status = Number(e?.status) || 0;
  const message = said(e);
  const who = writer.label;
  if (status === 401 || status === 403) return new ProviderError(`${who} refused the key (${status}). Check it in Settings → Lesson writer. ${message}`.trim(), 'auth');
  if (status === 429) {
    const daily = /per day|daily|\bTPD\b|\bRPD\b|quota/i.test(message);
    return new ProviderError(`${who} ${daily ? 'has reached its daily limit' : 'is rate-limiting this key'}: ${message} Try again later, or choose another writer for this step.`, 'limit');
  }
  if (status === 404) return new ProviderError(`${who} has no model called “${writer.model}”. ${message}`.trim(), 'model');
  if (status >= 400 && status < 500) return new ProviderError(`${who} could not take the request (${status}): ${message}`, 'request');
  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) {
    return new ProviderError(`${who} did not answer in time.`, 'timeout');
  }
  if (name === 'APIConnectionError' || /ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(`${message} ${e?.cause?.code || ''}`)) {
    return new ProviderError(`Could not reach ${who} at ${writer.baseUrl}. Is it running?`, 'unreachable');
  }
  if (status >= 500) return new ProviderError(`${who} had a server error (${status}): ${message}`, 'server');
  return new ProviderError(`${who} failed: ${message || name || 'unknown error'}`, 'failed');
}

/** The effort levels OpenAI-style reasoning settings know. */
export const openaiEffort = (effort) => ({ low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' })[effort] || null;
