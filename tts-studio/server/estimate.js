import { costOf, RATES, rateKey } from '../shared/rates.js';
import { CHAPTERS_FROM } from '../shared/limits.js';

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
const OUTLINE_PROMPT = 2_500; // the outline's instructions, without the guide
const PER_CHAPTER_OUTLINE = 350; // an outline's answer, per chapter
const CHAPTER_MINUTES = 4; // about how long the writer makes a chapter

// Claude Code reports its own figure afterwards; before, it is priced as the API would.
const claudeCodeRate = (model) => RATES[rateKey('anthropic', model || 'claude-opus-5-5')] || RATES['anthropic:claude-opus-5-5'];

function request(w, { input, cachedInput = 0, answer }) {
  const rate = w.kind === 'claude-code' ? claudeCodeRate(w.model) : w.rate;
  const thinking = Math.round(answer * (THINKING[w.effort] ?? 3));
  const usage = { inputTokens: input, cacheReadTokens: cachedInput, outputTokens: answer + thinking };
  return { usd: costOf(usage, rate), tokens: input + cachedInput + answer + thinking };
}

/**
 * A long lesson is an outline, then each chapter written and fixed on its own: the guide is
 * read again for every chapter (from the cache after the first) and each sees its share of
 * the notes, so it costs more per minute than a short one.
 */
export function estimateLesson(writer, { minutes = 2, notesChars = 0, images = 0, pdfPages = 0 } = {}) {
  const s = writer.steps;
  const files = images * PER_IMAGE + pdfPages * PER_PDF_PAGE;
  const notes = Math.round(notesChars / 4);
  const separateRead = files > 0 && !(s.read.provider === s.write.provider && s.read.model === s.write.model);
  const chaptered = minutes >= CHAPTERS_FROM;
  const n = chaptered ? Math.max(2, Math.round(minutes / CHAPTER_MINUTES)) : 1;
  const parts = [];
  if (separateRead) parts.push({ step: 'read', ...request(s.read, { input: files + 400, answer: Math.round(files * 0.4) }), always: true });
  const seen = separateRead ? Math.round(files * 0.4) : files; // the notes' files, as the writer sees them
  if (chaptered) {
    parts.push({ step: 'outline', ...request(s.outline || s.write, { input: OUTLINE_PROMPT + notes + seen, answer: 400 + PER_CHAPTER_OUTLINE * n }), always: true });
  }
  for (let i = 0; i < n; i += 1) {
    const answer = Math.round((minutes / n) * ANSWER_PER_MINUTE);
    const own = chaptered ? Math.round((notes + seen) / n) + PER_CHAPTER_OUTLINE * n : notes + seen;
    const cached = chaptered && i > 0 ? GUIDE : 0;
    parts.push({ step: 'write', ...request(s.write, { input: GUIDE - cached + own + 600, cachedInput: cached, answer }), always: true });
    const fix = request(s.fix, { input: answer + 1_200, cachedInput: GUIDE, answer });
    parts.push({ step: 'fix', ...fix, always: false }, { step: 'fix', ...fix, always: false });
    parts.push({ step: 'polish', ...request(s.polish, { input: answer + 1_200, cachedInput: GUIDE, answer }), always: false });
  }

  const stepOf = (p) => s[p.step] || s.write;
  const unknown = parts.filter((p) => p.usd == null).map(stepOf);
  const sum = (list) => list.reduce((t, p) => t + (p.usd || 0), 0);
  const low = sum(parts.filter((p) => p.always));
  const high = sum(parts);
  const usesClaudeCode = Object.values(s).some((w) => w.kind === 'claude-code');
  return {
    lowUsd: Math.round(low * 100) / 100,
    highUsd: Math.round(high * 100) / 100,
    free: parts.every((p) => p.usd === 0),
    unknown: [...new Set(unknown.map((w) => `${w.label}${w.model ? ` · ${w.model}` : ''}`))],
    tokens: parts.filter((p) => p.always).reduce((t, p) => t + p.tokens, 0),
    chapters: chaptered ? n : null,
    note: usesClaudeCode ? 'Claude Code on a Pro or Max plan counts against your plan; the figure is what the API would charge.' : null,
  };
}
