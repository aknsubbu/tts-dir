import fs from 'node:fs';
import { parseJsonAnswer, ProviderError, schemaInstructions, translateError } from './common.js';

/**
 * Ollama, through its own API. Its OpenAI-compatible address cannot set the context length,
 * so a long prompt would be cut off at Ollama's small default without an error. Here the
 * context length and the schema go with each request.
 */
const url = (writer, route) => `${String(writer.baseUrl).replace(/\/+$/, '')}${route}`;

/** Enough context for the prompt and an answer, in steps of 4096 tokens. */
export function contextFor(chars, modelContext) {
  const needed = Math.ceil(chars / 3.2) + 8_000; // about 3.2 characters per token, and room for the answer
  let size = Math.max(16_384, Math.ceil(needed / 4096) * 4096);
  if (modelContext && size > modelContext) {
    if (needed > modelContext) return { size: modelContext, needed, tooSmall: true };
    size = modelContext;
  }
  return { size, needed, tooSmall: false };
}

async function call(writer, route, body, signal, timeoutMs) {
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  let res;
  try {
    res = await fetch(url(writer, route), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  } catch (e) {
    throw translateError(e, writer, signal);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw translateError({ status: res.status, message: data?.error || res.statusText }, writer, signal);
  return data;
}

export async function askOllama({ writer, system, prompt, attachments = [], schema, signal, config }) {
  if (attachments.some((a) => a.kind !== 'image')) throw new ProviderError(`${writer.label} cannot read PDFs.`, 'request');
  const images = attachments.map((a) => fs.readFileSync(a.path).toString('base64'));
  const named = attachments.length ? `${attachments.map((a, i) => `Picture ${i + 1}: ${a.name}`).join('\n')}\n\n` : '';
  const sys = `${system}\n\n${schemaInstructions(schema)}`;
  const ctx = contextFor(sys.length + prompt.length, writer.caps?.context);
  if (ctx.tooSmall) {
    throw new ProviderError(`${writer.model} has room for ${writer.caps.context.toLocaleString('en-US')} tokens, and this request needs about ${ctx.needed.toLocaleString('en-US')}. Choose a model with a longer context.`, 'request');
  }
  const started = Date.now();
  const data = await call(
    writer,
    '/api/chat',
    {
      model: writer.model,
      stream: false,
      format: writer.caps?.structured === 'schema' ? schema : 'json',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: named + prompt, ...(images.length ? { images } : {}) },
      ],
      options: { num_ctx: ctx.size },
    },
    signal,
    config?.claudeTimeoutMs || 20 * 60_000,
  );
  const usage = {
    model: data?.model || writer.model,
    inputTokens: data?.prompt_eval_count || 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: data?.eval_count || 0,
    durationMs: data?.total_duration ? Math.round(data.total_duration / 1e6) : Date.now() - started,
  };
  if (data?.done_reason === 'length') throw new ProviderError(`${writer.label}'s answer was cut off at its length limit.`, 'cut', usage);
  try {
    return { answer: parseJsonAnswer(data?.message?.content, writer.label), usage };
  } catch (e) {
    e.usage = usage;
    throw e;
  }
}

/** The models pulled into Ollama. */
export async function ollamaModels({ writer, signal }) {
  const data = await call(writer, '/api/tags', null, signal, 15_000);
  return (data?.models || []).map((m) => ({ id: m.model || m.name, context: null }));
}

/** What Ollama says about a model: its context length and whether it can see. */
export async function ollamaShow({ writer, model, signal }) {
  const data = await call(writer, '/api/show', { model }, signal, 15_000);
  const info = data?.model_info || {};
  const contextKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
  const capabilities = Array.isArray(data?.capabilities) ? data.capabilities : null;
  return { context: contextKey ? Number(info[contextKey]) : null, vision: capabilities ? capabilities.includes('vision') : null };
}
