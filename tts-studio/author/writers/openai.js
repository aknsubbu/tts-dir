import OpenAI from 'openai';
import { attachmentParts, openaiEffort, parseJsonAnswer, ProviderError, schemaInstructions, translateError } from './common.js';

export const openaiClient = ({ key, writer, config }) =>
  new OpenAI({ apiKey: key || 'not-needed', baseURL: writer.baseUrl, maxRetries: 3, timeout: config?.claudeTimeoutMs || 20 * 60_000 });

/**
 * Anything that speaks OpenAI's chat completions: OpenAI itself, Groq, LM Studio, llama.cpp,
 * MLX, vLLM, OpenRouter. The answer's format follows what the model was found to support:
 *   schema   a JSON schema the server holds the answer to
 *   json     JSON mode, with the schema described in the system prompt
 *   none     the schema described, and the answer read out of whatever comes back
 */
export async function askOpenAI({ writer, key, system, prompt, attachments = [], schema, signal, config, effort }) {
  const client = openaiClient({ key, writer, config });
  const structured = writer.caps?.structured || 'json';
  const body = {
    model: writer.model,
    messages: [
      { role: 'system', content: structured === 'schema' ? system : `${system}\n\n${schemaInstructions(schema)}` },
      { role: 'user', content: attachments.length ? [...attachmentParts(attachments, 'openai'), { type: 'text', text: prompt }] : prompt },
    ],
  };
  if (structured === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: schema.title || 'answer', schema, strict: true } };
  else if (structured === 'json') body.response_format = { type: 'json_object' };
  if (writer.caps?.effort && openaiEffort(effort)) body.reasoning_effort = openaiEffort(effort);

  const started = Date.now();
  let res;
  try {
    res = await client.chat.completions.create(body, { signal });
  } catch (e) {
    throw translateError(e, writer, signal);
  }
  const u = res.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens || 0;
  const usage = {
    model: res.model || writer.model,
    inputTokens: Math.max(0, (u.prompt_tokens || 0) - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: u.completion_tokens || 0,
    durationMs: Date.now() - started,
  };
  const choice = res.choices?.[0];
  if (!choice) throw new ProviderError(`${writer.label} sent back no answer.`, 'format', usage);
  if (choice.message?.refusal) throw new ProviderError(`${writer.label} declined to answer: ${String(choice.message.refusal).slice(0, 200)}`, 'refused', usage);
  if (choice.finish_reason === 'length') throw new ProviderError(`${writer.label}'s answer was cut off at its length limit.`, 'cut', usage);
  try {
    return { answer: parseJsonAnswer(choice.message?.content, writer.label), usage };
  } catch (e) {
    e.usage = usage;
    throw e;
  }
}

/** The models offered at that address, with their context length when the list gives one. */
export async function openaiModels({ writer, key, config }) {
  const client = openaiClient({ key, writer, config });
  const out = [];
  for await (const m of client.models.list()) out.push({ id: m.id, context: m.context_window || m.context_length || m.max_model_len || null });
  return out;
}
