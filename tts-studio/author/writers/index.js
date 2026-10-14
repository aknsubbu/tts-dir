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
  if (!writer) throw new ProviderError('There is no writer to ask.');
  // Claude Code is the sign-in of whoever runs this computer: only a writer marked as allowed to use it may.
  if (writer.kind === 'claude-code' && writer.hostClaude !== true) {
    throw new ProviderError('This profile may not use the Claude Code sign-in on the computer that hosts this. The Owner can allow it, or choose another writer.');
  }
  if (writer.kind === 'claude-code') {
    let out;
    try {
      out = await askClaude({ ...rest, prompt, schema, nonEmpty, config, model: writer.model });
    } catch (e) {
      if (e.usage) e.usage.hostFunded = true; // a request that failed still cost something
      throw e;
    }
    // hostFunded: paid for by the computer's own sign-in or keys, which the Owner may put a limit on for others.
    return { ...out, usage: { ...out.usage, provider: 'claude-code', kind: 'claude-code', costKnown: true, hostFunded: true } };
  }
  const adapter = ADAPTERS[writer.kind];
  if (!adapter) throw new ProviderError(`There is no way to ask a “${writer.kind}” provider.`);
  const { key, from } = writer.kind === 'ollama' || writer.kind === 'local' ? { key: null, from: null } : await keyFor(writer.provider, { config, secrets, profileId: writer.profileId, allowEnv: writer.hostKeys === true });

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
  const hostFunded = from === 'env';
  // A request that fails after the provider answered still cost tokens, and still came out of the same pocket.
  const settle = (e) => {
    if (e.usage) {
      const used = add(spent, e.usage);
      e.usage = { ...used, provider: writer.provider, kind: writer.kind, costUsd: costOf(used, writer.rate) ?? 0, costKnown: costOf(used, writer.rate) != null, hostFunded };
    }
    return e;
  };
  try {
    out = await once(prompt);
  } catch (e) {
    if (e.kind !== 'format') throw settle(e);
    // One retry, told what was wrong. The tokens of the unusable answer still count.
    spent = e.usage;
    try {
      out = await once(`${prompt}\n\nAn earlier answer to this could not be used: ${e.message} Answer again, with only the JSON object.`);
    } catch (e2) {
      throw settle(e2);
    }
  }
  const usage = add(spent, out.usage);
  const cost = costOf(usage, writer.rate);
  return {
    answer: out.answer,
    costUsd: cost ?? 0,
    usage: { ...usage, provider: writer.provider, kind: writer.kind, costUsd: cost ?? 0, costKnown: cost != null, hostFunded },
  };
}
