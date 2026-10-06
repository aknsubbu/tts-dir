import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Optional settings can live in a .env here or in the folder above (tts-dir).
function candidateEnvFiles() {
  const dirs = [process.env.TTS_ENV_DIR, ROOT, path.dirname(ROOT)].filter(Boolean);
  return dirs.map((d) => path.join(d, '.env'));
}

/** The Python that has Kokoro installed: TTS_PYTHON, else the venv `npm run setup` creates. */
function findPython(override) {
  const candidates = override ? [override] : [path.join(ROOT, '.venv', 'bin', 'python')];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

/**
 * Read config fresh on every call so editing the .env takes effect without a restart.
 * Real environment variables win over the .env file.
 */
export function loadConfig() {
  let values = {};
  let envFile = null;
  for (const file of candidateEnvFiles()) {
    try {
      if (fs.statSync(file).isFile()) {
        values = parse(fs.readFileSync(file));
        envFile = file;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  const pick = (key, fallback) => process.env[key] || values[key] || fallback;
  return {
    python: findPython(String(pick('TTS_PYTHON', '')).trim()),
    device: String(pick('TTS_DEVICE', '')).trim(), // auto (default), mps or cpu
    defaultVoiceId: String(pick('TTS_VOICE', 'af_heart')).trim(),
    port: Number(pick('PORT', 8787)),
    host: '127.0.0.1', // local only; the dashboard is never exposed to your network
    dataDir: path.resolve(pick('TTS_DATA_DIR', path.join(ROOT, 'data'))),
    // Narrated videos: the video/ folder next to tts-studio, and the command that builds one
    // (default: python3 video/build.py). TTS_VIDEO_BUILD names another executable.
    videoDir: path.resolve(pick('TTS_VIDEO_DIR', path.join(path.dirname(ROOT), 'video'))),
    videoBuild: pick('TTS_VIDEO_BUILD', '') ? [String(pick('TTS_VIDEO_BUILD', '')).trim()] : null,
    envFile,
  };
}
