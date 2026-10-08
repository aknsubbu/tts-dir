import Anthropic from '@anthropic-ai/sdk';
import { attachmentParts, parseJsonAnswer, ProviderError, translateError } from './common.js';

// Server-side fallback re-runs a declined request on the model Anthropic recommends, inside the
// same call. Haiku has none, so it is left out there.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const anthropicClient = ({ key, writer, config }) =>
  new Anthropic({ apiKey: key, baseURL: writer.baseUrl || undefined, maxRetries: 3, timeout: config?.claudeTimeoutMs || 20 * 60_000 });

/**
 * The Claude API with your own key, through Anthropic's SDK. Structured output holds the answer
 * to the schema, effort is passed as is, and the guide is a cache breakpoint, so fix rounds
 * read it at the cache rate.
 */
export async function askAnthropic({ writer, key, system, prompt, attachments = [], schema, signal, config, effort }) {
  if (!key) throw new ProviderError(`${writer.label} has no key. Add one in Settings → Lesson writer, or set ANTHROPIC_API_KEY.`, 'auth');
  const client = anthropicClient({ key, writer, config });
  const params = {
    model: writer.model,
    max_tokens: 64_000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [...attachmentParts(attachments, 'anthropic'), { type: 'text', text: prompt }] }],
    output_config: { format: { type: 'json_schema', schema }, ...(effort && effort !== 'auto' ? { effort } : {}) },
  };
  if (!/haiku/i.test(writer.model)) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' });

  const started = Date.now();
  let msg;
  try {
    msg = await client.beta.messages.stream(params, { signal }).finalMessage();
  } catch (e) {
    throw translateError(e, writer, signal);
  }
  const u = msg.usage || {};
  const usage = {
    model: msg.model || writer.model,
    inputTokens: u.input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    durationMs: Date.now() - started,
  };
  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details?.category ? ` (${msg.stop_details.category})` : '';
    throw new ProviderError(`${writer.label} declined to answer${why}.`, 'refused', usage);
  }
  if (msg.stop_reason === 'max_tokens') throw new ProviderError(`${writer.label}'s answer was cut off at its length limit.`, 'cut', usage);
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { answer: parseJsonAnswer(text, writer.label), usage };
  } catch (e) {
    e.usage = usage;
    throw e;
  }
}

/** The models this key can use. */
export async function anthropicModels({ writer, key, config }) {
  const client = anthropicClient({ key, writer, config });
  const out = [];
  for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, context: m.max_input_tokens || null });
  return out;
}
