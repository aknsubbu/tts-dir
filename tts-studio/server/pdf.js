import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Three things done to PDFs in notes: count their pages, take their text, and keep only some
 * pages. On macOS through PDFKit (osascript runs a few lines of JavaScript for Automation);
 * elsewhere through poppler's pdfinfo, pdftotext, pdfseparate and pdfunite when installed.
 */
export class PdfError extends Error {}

const OSASCRIPT = '/usr/bin/osascript';
const useKit = () => process.platform === 'darwin' && fs.existsSync(OSASCRIPT);

// argv: command, source, [dest], [pages as JSON]. Prints JSON.
const KIT = `
ObjC.import('PDFKit');
function run(argv) {
  const [cmd, src, dest, list] = argv;
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(src));
  if (!doc || doc.isNil()) throw new Error('not a PDF');
  const n = doc.pageCount;
  if (cmd === 'info') return JSON.stringify({ pages: n });
  if (cmd === 'text') {
    const out = [];
    for (let i = 0; i < n; i++) out.push(ObjC.unwrap(doc.pageAtIndex(i).string) || '');
    return JSON.stringify(out);
  }
  if (cmd === 'pages') {
    const keep = JSON.parse(list);
    for (let i = n - 1; i >= 0; i--) if (!keep.includes(i + 1)) doc.removePageAtIndex(i);
    return JSON.stringify({ ok: doc.writeToFile(dest) });
  }
  throw new Error('unknown command');
}`;

const exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new PdfError(err.code === 'ENOENT' ? `${cmd} is not installed` : (stderr || err.message).trim().split('\n').pop())) : resolve(stdout),
    );
  });

const kit = async (...argv) => JSON.parse(await exec(OSASCRIPT, ['-l', 'JavaScript', '-e', KIT, ...argv]));

/** How many pages a PDF has. */
export async function pageCount(file) {
  if (useKit()) return (await kit('info', file)).pages;
  const out = await exec('pdfinfo', [file]);
  const m = out.match(/^Pages:\s+(\d+)/m);
  if (!m) throw new PdfError('Could not count the pages.');
  return Number(m[1]);
}

/** The text of each page, in order. A scanned page has none. */
export async function pageTexts(file) {
  if (useKit()) return kit('text', file);
  const out = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-']);
  return out.split('\f').slice(0, -1).map((p) => p.replace(/[ \t]+$/gm, '')); // pages end with a form feed
}

/**
 * Pages as typed: "1-3, 7" → [1, 2, 3, 7]. Empty means all of them. Throws on a page the
 * document does not have, so the person hears about it before anything is sent.
 */
export function parsePages(spec, count) {
  const text = String(spec ?? '').trim();
  if (!text) return null;
  const out = new Set();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:[-–](\d+))?$/);
    if (!m) throw new PdfError(`“${part}” is not a page or a range of pages, such as 3 or 2-5.`);
    const [a, b] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (a < 1 || b < a) throw new PdfError(`“${part}” is not a range of pages.`);
    if (count && b > count) throw new PdfError(`The PDF has ${count} page${count === 1 ? '' : 's'}; there is no page ${b}.`);
    for (let p = a; p <= b; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

/** Write a PDF holding only the given pages of another. */
export async function keepPages(src, dest, pages) {
  if (useKit()) {
    const { ok } = await kit('pages', src, dest, JSON.stringify(pages));
    if (!ok) throw new PdfError('Could not write the chosen pages.');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-pdf-'));
  try {
    const parts = [];
    for (const p of pages) {
      const part = path.join(dir, `p${p}.pdf`);
      await exec('pdfseparate', ['-f', String(p), '-l', String(p), src, part]);
      parts.push(part);
    }
    if (parts.length === 1) fs.copyFileSync(parts[0], dest);
    else await exec('pdfunite', [...parts, dest]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Pages as a short label: [1,2,3,7] → "1–3, 7". */
export function pagesLabel(pages) {
  const runs = [];
  for (const p of pages) {
    const last = runs.at(-1);
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}
