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
    // The lesson writer (author/): a second small server that asks Claude for a script and scenes.
    // The dashboard starts one itself unless TTS_AUTHOR_URL points at one running elsewhere.
    authorPort: Number(pick('AUTHOR_PORT', 8790)),
    authorUrl: String(pick('TTS_AUTHOR_URL', '')).trim().replace(/\/+$/, ''),
    claudeBin: String(pick('TTS_CLAUDE_BIN', 'claude')).trim(),
    claudeModel: String(pick('TTS_CLAUDE_MODEL', '')).trim(), // empty: whatever Claude Code defaults to
    // Effort per step: writing needs it, a fix is mechanical. "auto" leaves it to Claude Code.
    claudeEffort: String(pick('TTS_CLAUDE_EFFORT', 'high')).trim(),
    claudeFixEffort: String(pick('TTS_CLAUDE_FIX_EFFORT', 'low')).trim(),
    claudePolishEffort: String(pick('TTS_CLAUDE_POLISH_EFFORT', 'medium')).trim(),
    claudeTimeoutMs: Number(pick('TTS_CLAUDE_TIMEOUT_MIN', 20)) * 60_000,
    checkTimeoutMs: 30 * 60_000,
    authorMaxFixes: Number(pick('TTS_AUTHOR_FIXES', 3)), // rounds of "here is the error, fix it"
    authorPolish: String(pick('TTS_AUTHOR_POLISH', '1')) !== '0', // one more round for timing and layout warnings
    authorVisualReview: String(pick('TTS_AUTHOR_VISUAL_REVIEW', '0')) === '1', // show Claude its own frames in that round
    authorAutofix: pick('TTS_AUTHOR_AUTOFIX', '') ? [String(pick('TTS_AUTHOR_AUTOFIX', '')).trim()] : null,
    authorParallel: Math.max(1, Number(pick('TTS_AUTHOR_PARALLEL', 2)) || 1), // requests to Claude at once
    notesImageEdge: Math.max(800, Number(pick('TTS_NOTES_IMAGE_EDGE', 1400)) || 1400), // pixels on a photo's long side
    authorCheck: pick('TTS_AUTHOR_CHECK', '') ? [String(pick('TTS_AUTHOR_CHECK', '')).trim()] : null,
    envFile,
  };
}
