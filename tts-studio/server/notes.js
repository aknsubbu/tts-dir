import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_EXT, IMAGE_EXT, MAX_BYTES, MAX_FILES } from '../shared/limits.js';

/**
 * Files a person adds to a lesson's notes that are not plain text.
 *
 *   images   shown to Claude as pictures (handwritten notes, textbook pages, diagrams)
 *   PDFs     shown to Claude whole, pages and figures included
 *   documents (Word, RTF, OpenDocument) turned into text and added to the typed notes
 *
 * They are saved in the lesson's project, in notes/. Plain-text formats never reach this
 * file: the browser reads those itself and puts them in the notes box.
 */
const MAX_EDGE = 2000; // pixels on the long side: enough to read handwriting, small enough to send many
const SIPS = '/usr/bin/sips'; // both ship with macOS
const TEXTUTIL = '/usr/bin/textutil';

export class NotesError extends Error {}

const ext = (name) => path.extname(name).slice(1).toLowerCase();

export function kindOf(name) {
  const e = ext(name);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (DOC_EXT.includes(e)) return 'document';
  return null;
}

/** A name safe to use inside notes/: no folders, nothing odd, never empty. */
export function safeName(name, taken = new Set()) {
  const base = path.basename(String(name)).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(-80) || 'file';
  let out = base;
  for (let n = 2; taken.has(out.toLowerCase()); n += 1) {
    out = `${base.replace(/(\.[^.]+)?$/, '')}-${n}${path.extname(base)}`;
  }
  taken.add(out.toLowerCase());
  return out;
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve(stdout),
    );
  });

/**
 * Make any image a JPEG no larger than MAX_EDGE on its long side. Phone photos are HEIC,
 * which neither a browser nor Claude takes, and are several times larger than is useful.
 */
async function normalizeImage(source, dest) {
  if (!fs.existsSync(SIPS)) {
    if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext(source))) {
      throw new NotesError(`${path.basename(source)} cannot be converted on this system. Use a PNG or JPEG.`);
    }
    fs.copyFileSync(source, dest.replace(/\.jpg$/, path.extname(source).toLowerCase()));
    return dest.replace(/\.jpg$/, path.extname(source).toLowerCase());
  }
  try {
    await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', String(MAX_EDGE), source, '--out', dest]);
  } catch (e) {
    throw new NotesError(`${path.basename(source)} could not be read as an image. ${e.message}`.trim());
  }
  return dest;
}

async function documentText(source) {
  if (!fs.existsSync(TEXTUTIL)) throw new NotesError(`${path.basename(source)} cannot be read on this system. Paste its text into the notes instead.`);
  try {
    return (await run(TEXTUTIL, ['-convert', 'txt', '-stdout', source])).trim();
  } catch (e) {
    throw new NotesError(`${path.basename(source)} could not be read. ${e.message}`.trim());
  }
}

const MEDIA = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };

/**
 * Save what was uploaded with a lesson into <projectDir>/notes/.
 * `uploads` is [{ name, data }] with data in base64. Returns
 *   files  [{ name, file, kind, type, bytes }]  what Claude will be shown, `file` relative to the project
 *   text   the text of any documents, to be added to the typed notes
 */
export async function saveAttachments(projectDir, uploads) {
  if (!Array.isArray(uploads) || !uploads.length) return { files: [], text: '' };
  if (uploads.length > MAX_FILES) throw new NotesError(`A lesson can have at most ${MAX_FILES} attached files; this one has ${uploads.length}.`);
  const decoded = uploads.map((u) => {
    const name = String(u?.name || '').trim();
    const kind = kindOf(name);
    if (!kind) throw new NotesError(`${name || 'A file'} is not a kind of file notes can use. Images, PDFs, Word and RTF documents work.`);
    const bytes = Buffer.from(String(u.data || ''), 'base64');
    if (!bytes.length) throw new NotesError(`${name} is empty.`);
    return { name, kind, bytes };
  });
  const total = decoded.reduce((n, d) => n + d.bytes.length, 0);
  if (total > MAX_BYTES) {
    throw new NotesError(`The attached files add up to ${(total / 1048576).toFixed(1)} MB. The limit is ${MAX_BYTES / 1048576} MB.`);
  }

  const dir = path.join(projectDir, 'notes');
  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set();
  const files = [];
  const texts = [];
  try {
    for (const { name, kind, bytes } of decoded) {
      const saved = path.join(dir, safeName(name, taken));
      fs.writeFileSync(saved, bytes);
      if (kind === 'document') {
        const text = await documentText(saved);
        if (text) texts.push(`# From ${name}\n\n${text}`);
        continue;
      }
      let file = saved;
      if (kind === 'image') {
        // Always re-encode: it also drops location and camera details from phone photos.
        const jpg = path.join(dir, safeName(`${path.basename(saved, path.extname(saved))}.view.jpg`, taken));
        file = await normalizeImage(saved, jpg);
        fs.rmSync(saved, { force: true });
      }
      files.push({
        name,
        file: path.relative(projectDir, file).split(path.sep).join('/'),
        kind,
        type: MEDIA[ext(file)],
        bytes: fs.statSync(file).size,
      });
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { files, text: texts.join('\n\n') };
}
