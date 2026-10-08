import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { CONTEXT_NEEDED, DEFAULT_MODEL, KIND_CAPS } from '../../shared/providers.js';
import { run } from '../proc.js';
import { askClaude } from '../claude.js';
import { anthropicModels, askAnthropic } from './anthropic.js';
import { askOllama, ollamaModels, ollamaShow } from './ollama.js';
import { askOpenAI, openaiModels } from './openai.js';
import { translateError } from './common.js';

/**
 * A provider's Test: is the key good, which models are there, and for the chosen model what
 * works — a structured answer (and how), a picture, a PDF, a reasoning setting — how long the
 * context is and how fast it writes. Each check is a tiny request costing a fraction of a cent.
 *
 * Returns { ok, at, model, models, caps: { [model]: caps }, notes, error, ms }.
 */
const WORD = { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false };
const OPENAI_LIKE = ['openai', 'groq', 'local', 'custom'];
const ADAPTER = { anthropic: askAnthropic, openai: askOpenAI, groq: askOpenAI, local: askOpenAI, custom: askOpenAI, ollama: askOllama };

// ---- tiny test files ----------------------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A plain square of one colour, as a PNG. */
export function squarePng(size = 64, [r, g, b] = [220, 30, 30]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A one-page PDF with one line of text on it. */
export function textPdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function testFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-probe-'));
  const png = path.join(dir, 'square.png');
  const pdf = path.join(dir, 'word.pdf');
  fs.writeFileSync(png, squarePng());
  fs.writeFileSync(pdf, textPdf('PINEAPPLE'));
  return {
    dir,
    image: { name: 'square.png', kind: 'image', type: 'image/png', path: png },
    pdf: { name: 'word.pdf', kind: 'pdf', type: 'application/pdf', path: pdf },
  };
}

// ---- the test -------------------------------------------------------------------------------

export async function listModels({ writer, key, config, signal }) {
  if (writer.kind === 'claude-code') return [];
  if (writer.kind === 'anthropic') return anthropicModels({ writer, key, config });
  if (writer.kind === 'ollama') return ollamaModels({ writer, signal });
  return openaiModels({ writer, key, config });
}

export async function probe({ provider, model, key, config, signal }) {
  const started = Date.now();
  const out = { ok: false, at: Date.now(), model: model || null, models: [], caps: {}, notes: [], error: null, ms: 0 };
  const writer = { provider: provider.id, kind: provider.kind, label: provider.label, baseUrl: provider.baseUrl, model: model || '', caps: { ...KIND_CAPS[provider.kind] }, rate: null };
  const files = testFiles();
  try {
    if (provider.kind === 'claude-code') return await probeClaudeCode({ out, writer, config, signal, files });
    if (provider.needsKey === true && !key) throw new Error(`${provider.label} has no key yet. Add it first.`);

    let listed = [];
    try {
      listed = await listModels({ writer, key, config, signal });
    } catch (e) {
      throw translateError(e, writer, signal);
    }
    out.models = listed.map((m) => m.id).sort();
    writer.model = model || DEFAULT_MODEL[provider.kind] || out.models[0] || '';
    if (!writer.model) throw new Error(`${provider.label} answered, but offers no models.`);
    out.model = writer.model;
    const caps = { structured: 'none', images: false, pdf: false, effort: false, context: listed.find((m) => m.id === writer.model)?.context || null, tokensPerSec: null };
    const ask = (extra) => ADAPTER[provider.kind]({ writer: { ...writer, caps: { ...writer.caps, ...extra.caps } }, key, config, signal, system: 'You answer questions with one word, as JSON.', schema: WORD, ...extra });

    // A structured answer: the schema if the server takes one, else JSON mode, else plain text.
    const modes = OPENAI_LIKE.includes(provider.kind) ? ['schema', 'json', 'none'] : [KIND_CAPS[provider.kind].structured];
    let lastError = null;
    for (const mode of modes) {
      try {
        const t0 = Date.now();
        const { answer, usage } = await ask({ caps: { structured: mode, effort: false }, prompt: 'Reply with the word "ready".' });
        if (typeof answer.word !== 'string') throw new Error('no word');
        caps.structured = mode;
        const secs = (usage.durationMs || Date.now() - t0) / 1000;
        if (usage.outputTokens > 3 && secs > 0) caps.tokensPerSec = Math.round(usage.outputTokens / secs);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (!['request', 'format'].includes(e.kind)) throw e;
      }
    }
    if (lastError) throw lastError;
    const base = { structured: caps.structured };

    if (OPENAI_LIKE.includes(provider.kind)) {
      try {
        await ask({ caps: { ...base, effort: true }, prompt: 'Reply with the word "ready".', effort: 'low' });
        caps.effort = true;
      } catch (e) {
        if (!['request', 'format'].includes(e.kind)) throw e;
      }
    } else if (provider.kind === 'anthropic') caps.effort = true;

    if (provider.kind === 'ollama') {
      const shown = await ollamaShow({ writer, model: writer.model, signal }).catch(() => ({}));
      caps.context = shown.context || caps.context;
      if (shown.vision === false) out.notes.push('Ollama says this model cannot see pictures.');
    }
    if (provider.kind === 'anthropic') caps.context = caps.context || 1_000_000;

    try {
      const { answer } = await ask({ caps: base, prompt: 'What colour is the square in the picture? Reply with one word.', attachments: [files.image] });
      caps.images = /red/i.test(answer.word);
      if (!caps.images) out.notes.push(`Asked for the colour of a red square, it said “${String(answer.word).slice(0, 30)}”.`);
    } catch (e) {
      if (!['request', 'format'].includes(e.kind)) throw e;
    }
    if (provider.kind !== 'ollama' && provider.kind !== 'groq') {
      try {
        const { answer } = await ask({ caps: base, prompt: 'What word is written in the PDF? Reply with that word.', attachments: [files.pdf] });
        caps.pdf = /pineapple/i.test(answer.word);
      } catch (e) {
        if (!['request', 'format'].includes(e.kind)) throw e;
      }
    }

    if (caps.context && caps.context < CONTEXT_NEEDED.write) {
      out.notes.push(`Its context is ${caps.context.toLocaleString('en-US')} tokens. Writing a lesson needs about ${CONTEXT_NEEDED.write.toLocaleString('en-US')}, a fix about ${CONTEXT_NEEDED.fix.toLocaleString('en-US')}.`);
    }
    if (caps.structured !== 'schema') out.notes.push(caps.structured === 'json' ? 'No schema support: answers use JSON mode and are checked.' : 'No structured answers: the JSON is read out of plain text, which fails more often.');
    out.caps[writer.model] = caps;
    out.ok = true;
  } catch (e) {
    if (e.code === 'aborted') throw e;
    out.error = e.message;
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
    out.ms = Date.now() - started;
  }
  return out;
}

/** Claude Code: the command is there, signed in, and answers. Pictures and PDFs it always takes. */
async function probeClaudeCode({ out, writer, config, signal, files }) {
  const bin = config.claudeBin || 'claude';
  const version = await run(bin, ['--version'], { signal, timeoutMs: 20_000 }).catch((e) => ({ code: 1, stdout: '', stderr: e.message }));
  if (version.code) throw new Error(`Could not run ${bin}. Install Claude Code, or set TTS_CLAUDE_BIN to where it is.`);
  out.notes.push(`Claude Code ${version.stdout.trim().split(/\s+/)[0] || ''}`.trim());
  const t0 = Date.now();
  const { answer, usage } = await askClaude({
    system: 'You answer questions with one word, as JSON.',
    prompt: 'What colour is the square in the picture? Reply with one word.',
    attachments: [files.image],
    schema: WORD,
    config,
    signal,
    effort: 'low',
    model: writer.model,
  });
  out.model = usage.model || writer.model || null;
  const caps = { ...KIND_CAPS['claude-code'], tokensPerSec: null };
  if (!/red/i.test(answer.word)) out.notes.push(`Asked for the colour of a red square, it said “${String(answer.word).slice(0, 30)}”.`);
  const secs = (usage.durationMs || Date.now() - t0) / 1000;
  if (usage.outputTokens > 3 && secs > 0) caps.tokensPerSec = Math.round(usage.outputTokens / secs);
  out.caps[writer.model || ''] = caps;
  out.ok = true;
  return out;
}
