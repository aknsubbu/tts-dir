import fs from 'node:fs';
import path from 'node:path';

// /* AR: A server started from a macOS login item may not have Homebrew on its PATH, so its two
//    usual folders are searched after PATH. On Linux and in the Docker image they are just PATH. */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The full path of the program `name` on PATH or in the usual extra folders, else null. */
export function which(name, { env = process.env, extraDirs = EXTRA_DIRS } = {}) {
  const dirs = [...(env.PATH || '').split(path.delimiter), ...extraDirs].filter(Boolean);
  return dirs.map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) || null;
}
