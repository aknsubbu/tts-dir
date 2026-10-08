/**
 * The kinds of model provider a lesson can be written with. The one copy: the server, the
 * lesson writer and the page all import it. Nothing here may import from Node or the browser.
 *
 *   company   who receives your topic, notes and files when this provider is used (null: this Mac)
 *   key       whether it needs an API key
 *   models    suggestions; the Test lists what the provider really offers
 */
export const PROVIDER_KINDS = {
  'claude-code': {
    label: 'Claude Code',
    company: 'Anthropic',
    key: false,
    baseUrl: null,
    note: 'Your Claude sign-in or plan, through the claude command. Nothing to set up.',
    models: [],
  },
  anthropic: {
    label: 'Claude API',
    company: 'Anthropic',
    key: true,
    baseUrl: 'https://api.anthropic.com',
    note: 'Your own Anthropic API key, billed per token.',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    label: 'OpenAI',
    company: 'OpenAI',
    key: true,
    baseUrl: 'https://api.openai.com/v1',
    note: 'Your own OpenAI API key.',
    models: [],
  },
  groq: {
    label: 'Groq',
    company: 'Groq',
    key: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    note: 'Your own Groq API key. Structured answers on some models; no PDF input.',
    models: [],
  },
  ollama: {
    label: 'This Mac: Ollama',
    company: null,
    key: false,
    baseUrl: 'http://127.0.0.1:11434',
    note: 'A model running in Ollama on this Mac. Free, and nothing leaves it.',
    models: [],
  },
  local: {
    label: 'This Mac: OpenAI-compatible',
    company: null,
    key: false,
    baseUrl: 'http://127.0.0.1:1234/v1',
    note: 'LM Studio, llama.cpp, MLX or vLLM serving an OpenAI-compatible address on this Mac.',
    models: [],
  },
  custom: {
    label: 'Other',
    company: 'the service at that address',
    key: true,
    baseUrl: '',
    note: 'Any OpenAI-compatible service: OpenRouter, Together, your own server.',
    models: [],
  },
};

/**
 * What a provider's models are assumed to do until a Test finds out. The Test records, per
 * model: structured answers ('schema', 'json' for JSON mode, or 'none'), pictures, PDFs,
 * a reasoning setting (effort), and the context length in tokens.
 */
export const KIND_CAPS = {
  'claude-code': { structured: 'schema', images: true, pdf: true, effort: true, context: 1_000_000 },
  anthropic: { structured: 'schema', images: true, pdf: true, effort: true, context: 1_000_000 },
  openai: { structured: 'schema', images: true, pdf: true, effort: false, context: null },
  groq: { structured: 'json', images: false, pdf: false, effort: false, context: null },
  ollama: { structured: 'schema', images: false, pdf: false, effort: false, context: null },
  local: { structured: 'json', images: false, pdf: false, effort: false, context: null },
  custom: { structured: 'json', images: false, pdf: false, effort: false, context: null },
};

/** Tokens of context a lesson needs: the guide (~7k), notes (up to ~15k) and the answer (~6k). */
export const CONTEXT_NEEDED = { write: 28_000, fix: 20_000 };

/** The model a step uses when none is chosen. Claude Code uses its own default. */
export const DEFAULT_MODEL = { anthropic: 'claude-opus-5-5' };

/** Built in, always listed. Custom providers are added beside them. */
export const BUILT_IN_PROVIDERS = ['claude-code', 'anthropic', 'openai', 'groq', 'ollama', 'local'];

/** The steps of writing a lesson that can each use their own provider. */
export const WRITER_STEPS = [
  ['read', 'Reading your notes'],
  ['write', 'Writing the lesson'],
  ['fix', 'Fixing and polishing'],
  ['outline', 'Outlines (long lessons)'],
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Each step's effort when the plan leaves it empty: writing needs it, a fix is mechanical. */
export const STEP_EFFORT_ENV = {
  read: 'TTS_CLAUDE_READ_EFFORT',
  write: 'TTS_CLAUDE_EFFORT',
  fix: 'TTS_CLAUDE_FIX_EFFORT',
  polish: 'TTS_CLAUDE_POLISH_EFFORT',
  outline: 'TTS_CLAUDE_OUTLINE_EFFORT',
};

/** The plan a fresh install uses: Claude Code for everything, as before. */
export const DEFAULT_PLAN = {
  mode: 'one',
  all: { provider: 'claude-code', model: '', effort: '' },
  steps: Object.fromEntries(WRITER_STEPS.map(([step]) => [step, { provider: 'claude-code', model: '', effort: '' }])),
  handBack: { after: 2 },
};

/** Who a provider sends your notes to, said plainly. */
export function destination(kind, baseUrl) {
  const k = PROVIDER_KINDS[kind];
  if (!k) return 'an unknown provider';
  if (!k.company) return 'nobody: it runs on this Mac';
  if (kind === 'custom') return baseUrl ? `the service at ${baseUrl}` : 'a service you name';
  return k.company;
}
