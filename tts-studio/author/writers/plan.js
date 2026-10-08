import { KIND_CAPS, PROVIDER_KINDS } from '../../shared/providers.js';
import { AuthorError } from '../proc.js';

export const STEPS = ['read', 'write', 'fix', 'polish', 'outline'];

/** The plan when the dashboard sends none: Claude Code for every step, as before there were choices. */
export function defaultWriter(config) {
  const cc = (effort) => ({ provider: 'claude-code', kind: 'claude-code', label: 'Claude Code', baseUrl: null, model: config.claudeModel || '', effort: effort ?? '', caps: { ...KIND_CAPS['claude-code'] }, rate: null });
  return {
    steps: {
      read: cc(config.claudeReadEffort ?? config.claudeEffort),
      write: cc(config.claudeEffort),
      fix: cc(config.claudeFixEffort ?? config.claudeEffort),
      polish: cc(config.claudePolishEffort ?? config.claudeEffort),
      outline: cc(config.claudeOutlineEffort ?? config.claudeEffort),
    },
    handBack: { after: 0 },
  };
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/** A plan as the dashboard sent it, keeping only what the writer uses. Never holds a key. */
export function normalizeWriter(w, config) {
  if (!w || typeof w !== 'object' || !w.steps) return defaultWriter(config);
  const steps = {};
  for (const step of STEPS) {
    const s = w.steps[step] || w.steps.write;
    if (!s || !PROVIDER_KINDS[s.kind]) throw new AuthorError(`The writer plan names no usable provider for “${step}”.`);
    steps[step] = {
      provider: String(s.provider || s.kind).slice(0, 40),
      kind: s.kind,
      label: String(s.label || PROVIDER_KINDS[s.kind].label).slice(0, 80),
      baseUrl: s.baseUrl ? String(s.baseUrl) : PROVIDER_KINDS[s.kind].baseUrl,
      model: String(s.model || '').slice(0, 200),
      effort: String(s.effort || ''),
      caps: { ...KIND_CAPS[s.kind], ...(s.caps && typeof s.caps === 'object' ? s.caps : {}) },
      rate: s.rate && typeof s.rate === 'object' ? { input: num(s.rate.input), output: num(s.rate.output), cacheRead: num(s.rate.cacheRead ?? s.rate.input), cacheWrite: num(s.rate.cacheWrite ?? s.rate.input) } : null,
    };
  }
  return { steps, handBack: { after: Math.min(5, Math.max(0, Math.floor(Number(w.handBack?.after) || 0))) } };
}

export const sameModel = (a, b) => a.provider === b.provider && a.model === b.model;

/** "Claude Code" or "Groq · llama-4-maverick". */
export const who = (w) => (w.model && w.kind !== 'claude-code' ? `${w.label} · ${w.model}` : w.label);
