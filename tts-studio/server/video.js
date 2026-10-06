import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EngineError } from './kokoro.js';

const PROJECT_NAME = /^[A-Za-z0-9_-]{1,80}$/;

/** Video projects in video/projects/: [{ name, voice, speed, scenes, script }]. */
export function listProjects(videoDir) {
  const dir = path.join(videoDir, 'projects');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => PROJECT_NAME.test(n)).sort();
  } catch {
    return [];
  }
  return names.map((name) => readProject(videoDir, name)).filter(Boolean);
}

export function readProject(videoDir, name) {
  if (!PROJECT_NAME.test(String(name))) return null;
  const root = path.join(videoDir, 'projects', name);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
    const raw = fs.readFileSync(path.join(root, config.script || 'script.txt'), 'utf8');
    // What the library keeps and searches: the narration, without comments or mark tags.
    const script = raw
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
      .replace(/<mark\b[^>]*\/>\s?/g, '')
      .trim();
    return {
      name,
      root,
      voice: config.voice || 'af_heart',
      speed: Number(config.speed) || 1,
      scenes: Array.isArray(config.scenes) ? config.scenes : [],
      script,
    };
  } catch {
    return null;
  }
}

/**
 * Runs video/build.py for a project. A build spawns manimgl and ffmpeg in turn, so it
 * gets a process group of its own and cancelling kills the whole group.
 */
export function createVideoBuilder({ getConfig }) {
  async function build({ project, quality = 'default', onProgress, signal }) {
    if (signal?.aborted) throw new EngineError('Cancelled', 'aborted');
    const { videoDir, videoBuild } = getConfig();
    const info = readProject(videoDir, project);
    if (!info) throw new EngineError(`No video project “${project}” in ${path.join(videoDir, 'projects')}.`, 'synthesis');
    const [cmd, ...pre] = videoBuild || ['python3', path.join(videoDir, 'build.py')];
    const total = info.scenes.length + 2; // narrate, each scene, join
    let done = 0;

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, [...pre, info.root, '--quality', quality], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'], // nothing may wait on a keyboard
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      const out = [];
      const tail = [];
      let aborted = false;
      const kill = () => {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const onAbort = () => {
        aborted = true;
        kill();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      readline.createInterface({ input: proc.stdout }).on('line', (l) => l.trim() && out.push(l.trim()));
      readline.createInterface({ input: proc.stderr }).on('line', (line) => {
        // build.py echoes each step as "$ command"; manim's progress bars are noise here.
        if (line.startsWith('$ ')) onProgress?.(Math.min((done += 1), total), total);
        if (line.trim()) tail.push(line.replace(/\r/g, '').trim());
        tail.splice(0, Math.max(0, tail.length - 40));
      });
      proc.once('error', (e) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new EngineError(`Could not start the video build (${cmd}): ${e.message}`, 'synthesis'));
      });
      proc.once('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        kill(); // nothing it started may outlive it
        if (aborted) return reject(new EngineError('Cancelled', 'aborted'));
        if (code !== 0) {
          const reason = [...tail].reverse().find((l) => l.startsWith('error:')) || tail.slice(-3).join(' ');
          return reject(new EngineError(`The video build failed. ${reason}`.trim(), 'synthesis'));
        }
        const pick = (ext) => out.findLast((f) => f.endsWith(ext)); // build.py prints the results last
        const files = { mp4: pick('.mp4'), srt: pick('.srt'), vtt: pick('.vtt') };
        if (!files.mp4 || !fs.existsSync(files.mp4)) {
          return reject(new EngineError('The video build finished without reporting its video file.', 'synthesis'));
        }
        let durationSec = null;
        try {
          durationSec = JSON.parse(fs.readFileSync(path.join(path.dirname(files.mp4), 'build.json'), 'utf8')).duration;
        } catch {
          /* the library just shows no length */
        }
        resolve({ files, durationSec, segments: total });
      });
    });
  }

  return { build };
}
