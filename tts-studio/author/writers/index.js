import { askClaude } from '../claude.js';
import { costOf } from '../../shared/rates.js';
import { keyFor } from '../../server/secrets.js';
import { askAnthropic } from './anthropic.js';
import { askOllama } from './ollama.js';
import { askOpenAI } from './openai.js';
import { checkAnswer, ProviderError } from './common.js';

/**
 * One interface over every provider. A writer is one step's choice, as the dashboard resolves it:
 *   { provider, kind, label, baseUrl, model, effort, caps, rate }
 * It never carries a key: keys are looked up here, from the environment or the Keychain.
 * Without a writer, Claude Code answers, as before there were choices.
 *
 * Returns { answer, costUsd, usage } with usage naming the provider and model that answered.
 */
const ADAPTERS = { anthropic: askAnthropic, openai: askOpenAI, groq: askOpenAI, local: askOpenAI, custom: askOpenAI, ollama: askOllama };

const add = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const out = { ...b };
  for (const k of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'durationMs']) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
};

export async function askWriter({ writer, secrets, config, schema, prompt, nonEmpty, ...rest }) {
  if (!writer || writer.kind === 'claude-code') {
    const out = await askClaude({ ...rest, prompt, schema, nonEmpty, config, model: writer ? writer.model : undefined });
    return { ...out, usage: { ...out.usage, provider: 'claude-code', kind: 'claude-code', costKnown: true } };
  }
  const adapter = ADAPTERS[writer.kind];
  if (!adapter) throw new ProviderError(`There is no way to ask a “${writer.kind}” provider.`);
  const { key } = writer.kind === 'ollama' || writer.kind === 'local' ? { key: null } : await keyFor(writer.provider, { config, secrets });

  const once = async (text) => {
    const out = await adapter({ writer, key, config, schema, prompt: text, ...rest });
    try {
      checkAnswer(out.answer, schema, writer.label, nonEmpty);
    } catch (e) {
      e.usage = out.usage;
      throw e;
    }
    return out;
  };
  let out;
  let spent = null;
  try {
    out = await once(prompt);
  } catch (e) {
    if (e.kind !== 'format') throw e;
    // One retry, told what was wrong. The tokens of the unusable answer still count.
    spent = e.usage;
    out = await once(`${prompt}\n\nAn earlier answer to this could not be used: ${e.message} Answer again, with only the JSON object.`);
  }
  const usage = add(spent, out.usage);
  const cost = costOf(usage, writer.rate);
  return {
    answer: out.answer,
    costUsd: cost ?? 0,
    usage: { ...usage, provider: writer.provider, kind: writer.kind, costUsd: cost ?? 0, costKnown: cost != null },
  };
}
