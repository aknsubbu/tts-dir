import { spawn } from 'node:child_process';

export class AuthorError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.code = code; // 'failed', 'aborted' or 'timeout'
  }
}

/**
 * Run a command to the end and return { code, stdout, stderr }.
 * It gets a process group of its own, so cancelling or timing out kills whatever it started too.
 */
export function run(cmd, args, { input, cwd, env, signal, timeoutMs, onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AuthorError('Cancelled', 'aborted'));
    const proc = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ended = null; // why it was killed, if it was
    const kill = () => {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      ended = 'aborted';
      kill();
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          ended = 'timeout';
          kill();
        }, timeoutMs)
      : null;
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    proc.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    proc.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
      if (onStderrLine) for (const line of d.split('\n')) if (line.trim()) onStderrLine(line.trim());
    });
    proc.stdin.on('error', () => {}); // it may exit before reading everything
    proc.stdin.end(input ?? '');
    proc.once('error', (e) => {
      done();
      reject(new AuthorError(e.code === 'ENOENT' ? `Could not find “${cmd}”.` : `Could not start ${cmd}: ${e.message}`));
    });
    proc.once('close', (code) => {
      done();
      kill(); // nothing it started may outlive it
      if (ended === 'aborted') return reject(new AuthorError('Cancelled', 'aborted'));
      if (ended === 'timeout') return reject(new AuthorError(`${cmd} did not finish within ${Math.round(timeoutMs / 60000)} minutes.`, 'timeout'));
      resolve({ code, stdout, stderr });
    });
  });
}
