import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOC_EXT, IMAGE_EXT, MAX_BYTES, MAX_FILES, TEXT_EXT } from '../shared/limits.js';

/**
 * Files Claude names for a lesson's notes, read here and sent the way the page sends them:
 * text files join the notes, images, PDFs and documents go as attachments. Only those kinds,
 * within the page's limits, and never from the folders where keys and logins are kept (the
 * same list scenes may not read; see video/sandbox.py).
 */
export const PRIVATE = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.config', '.claude', '.claude.json',
  'Library/Keychains', 'Library/Cookies', 'Library/Mail', 'Library/Messages', 'Library/Safari',
  'Library/Application Support/Google', 'Library/Application Support/Firefox',
  'Library/Application Support/com.apple.TCC', 'Library/Application Support/Claude',
];
const SYSTEM = ['/etc', '/private/etc', '/var/db', '/private/var/db', '/System'];

export class FileRuleError extends Error {}

const ext = (name) => path.extname(name).slice(1).toLowerCase();

function expand(p, cwd) {
  const s = String(p || '').trim();
  if (!s) throw new FileRuleError('A file path is empty.');
  if (s === '~' || s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(cwd, s);
}

/** The real path, refused when it is inside a private folder or names no regular file. */
export function checkPath(p, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const wanted = expand(p, cwd);
  let real;
  try {
    real = fs.realpathSync(wanted);
  } catch {
    throw new FileRuleError(`There is no file at ${wanted}.`);
  }
  const inside = (dir) => real === dir || real.startsWith(dir + path.sep);
  // Compared as they really are: a home reached through a link, or a ~/.ssh or ~/.config that
  // links into a dotfiles folder, must not let a file through.
  const resolved = (dir) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  };
  const blocked = [...PRIVATE.map((d) => path.join(home, d)), ...SYSTEM].find((dir) => inside(dir) || inside(resolved(dir)));
  if (blocked) throw new FileRuleError(`${p} is in ${blocked}, where keys and private data are kept. Lessons never read from there.`);
  if (!fs.statSync(real).isFile()) throw new FileRuleError(`${p} is not a file.`);
  return real;
}

/**
 * Read the named files: [{ path, pages?, asText? }] or plain paths. Returns { notes, attachments }
 * with notes the text of text files and attachments [{ name, data, pages, asText }] in base64.
 */
export function readNoteFiles(list = [], options = {}) {
  if (list.length > MAX_FILES) throw new FileRuleError(`At most ${MAX_FILES} files can go with a lesson.`);
  const texts = [];
  const attachments = [];
  let bytes = 0;
  for (const item of list) {
    const spec = typeof item === 'string' ? { path: item } : item;
    const real = checkPath(spec.path, options);
    const name = path.basename(real);
    const e = ext(name);
    const size = fs.statSync(real).size;
    bytes += size;
    if (bytes > MAX_BYTES) throw new FileRuleError(`The files add up to more than ${MAX_BYTES / 1048576} MB, the limit for one lesson.`);
    if (TEXT_EXT.includes(e)) {
      const text = fs.readFileSync(real, 'utf8').trim();
      if (text) texts.push(`# From ${name}\n\n${text}`);
      continue;
    }
    if (!IMAGE_EXT.includes(e) && e !== 'pdf' && !DOC_EXT.includes(e)) {
      throw new FileRuleError(`${name} is not a kind of file notes can use: images, PDFs, Word, RTF and text files work.`);
    }
    attachments.push({
      name,
      data: fs.readFileSync(real).toString('base64'),
      ...(spec.pages ? { pages: String(spec.pages) } : {}),
      ...(spec.asText ? { asText: true } : {}),
    });
  }
  return { notes: texts.join('\n\n'), attachments };
}
