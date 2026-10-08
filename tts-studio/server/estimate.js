import { costOf, RATES, rateKey } from '../shared/rates.js';

/**
 * About what a lesson will cost to write, before it is written: a range from "written right
 * the first time" to "two fixes and a polish". Token counts come from the example lesson
 * (the guide is about 6,500 tokens; a minute of video is about 1,700 tokens of script and
 * scenes) and thinking grows with effort. It is a guide, not a quote: the version records
 * what each lesson really cost.
 */
const GUIDE = 6_500;
const ANSWER_PER_MINUTE = 1_700;
const THINKING = { low: 0.3, medium: 1.5, high: 4, xhigh: 6, max: 8, auto: 3, '': 3 };
const PER_IMAGE = 1_600; // a photo at about 1400 pixels on its long side
const PER_PDF_PAGE = 2_000; // a page's text and its picture

// Claude Code reports its own figure afterwards; before, it is priced as the API would.
const claudeCodeRate = (model) => RATES[rateKey('anthropic', model || 'claude-opus-5-5')] || RATES['anthropic:claude-opus-5-5'];

function request(w, { input, cachedInput = 0, answer }) {
  const rate = w.kind === 'claude-code' ? claudeCodeRate(w.model) : w.rate;
  const thinking = Math.round(answer * (THINKING[w.effort] ?? 3));
  const usage = { inputTokens: input, cacheReadTokens: cachedInput, outputTokens: answer + thinking };
  return { usd: costOf(usage, rate), tokens: input + cachedInput + answer + thinking };
}

export function estimateLesson(writer, { minutes = 2, notesChars = 0, images = 0, pdfPages = 0 } = {}) {
  const s = writer.steps;
  const answer = minutes * ANSWER_PER_MINUTE;
  const files = images * PER_IMAGE + pdfPages * PER_PDF_PAGE;
  const notes = Math.round(notesChars / 4);
  const separateRead = files > 0 && !(s.read.provider === s.write.provider && s.read.model === s.write.model);
  const parts = [];
  if (separateRead) parts.push({ step: 'read', ...request(s.read, { input: files + 400, answer: Math.round(files * 0.4) }), always: true });
  const writeInput = GUIDE + notes + (separateRead ? Math.round(files * 0.4) : files) + 600;
  parts.push({ step: 'write', ...request(s.write, { input: writeInput, answer }), always: true });
  const fixInput = answer + 1_200;
  const fix = request(s.fix, { input: fixInput, cachedInput: GUIDE, answer });
  parts.push({ step: 'fix', ...fix, always: false }, { step: 'fix', ...fix, always: false });
  parts.push({ step: 'polish', ...request(s.polish, { input: fixInput, cachedInput: GUIDE, answer }), always: false });

  const unknown = parts.filter((p) => p.usd == null).map((p) => s[p.step]);
  const sum = (list) => list.reduce((n, p) => n + (p.usd || 0), 0);
  const low = sum(parts.filter((p) => p.always));
  const high = sum(parts);
  const usesClaudeCode = Object.values(s).some((w) => w.kind === 'claude-code');
  return {
    lowUsd: Math.round(low * 100) / 100,
    highUsd: Math.round(high * 100) / 100,
    free: parts.every((p) => p.usd === 0),
    unknown: [...new Set(unknown.map((w) => `${w.label}${w.model ? ` · ${w.model}` : ''}`))],
    tokens: parts.filter((p) => p.always).reduce((n, p) => n + p.tokens, 0),
    note: usesClaudeCode ? 'Claude Code on a Pro or Max plan counts against your plan; the figure is what the API would charge.' : null,
  };
}
