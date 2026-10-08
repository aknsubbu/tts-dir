/**
 * What API providers charge, in US dollars per million tokens, for working out what a lesson
 * cost from its token counts. Ships with the app and carries its date; Settings → Costs can
 * add a rate or change one. Claude Code reports its own figure, and a model on this Mac is free.
 *
 *   input       tokens read fresh
 *   output      tokens written, thinking included
 *   cacheRead   tokens read from the prompt cache
 *   cacheWrite  tokens written to it (five-minute cache)
 *
 * Only Anthropic's rates are filled in: they were checked on the date below. Add others in
 * Settings from the provider's own price list; until then their cost shows as unknown.
 */
export const RATES_DATE = '2026-10-06';

export const RATES = {
  'anthropic:claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'anthropic:claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  // Up to 100k tokens in the prompt, which a lesson never passes.
  'anthropic:claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The rate key for a provider kind and model: "anthropic:claude-opus-5-5". */
export const rateKey = (kind, model) => `${kind}:${model}`;

/** Dollars for one request's token counts at a rate, or null when there is no rate. */
export function costOf(usage, rate) {
  if (!rate) return null;
  const n = (v) => Number(v) || 0;
  const usd =
    n(usage.inputTokens) * n(rate.input) +
    n(usage.outputTokens) * n(rate.output) +
    n(usage.cacheReadTokens) * n(rate.cacheRead ?? rate.input) +
    n(usage.cacheWriteTokens) * n(rate.cacheWrite ?? rate.input);
  return Math.round((usd / 1e6) * 1e5) / 1e5;
}
