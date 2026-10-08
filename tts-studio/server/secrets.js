import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SERVICE = 'Narrated Proofs';
const SECURITY = '/usr/bin/security';

// A key written into the page is one of these characters: what API keys are made of.
// Quotes and backslashes are refused, so a key can never break out of the Keychain command.
const KEY_SHAPE = /^[A-Za-z0-9._~+/=:-]{8,512}$/;

export class SecretError extends Error {}

/** Environment variables that hold a built-in provider's key. They win over a stored key. */
export const ENV_KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', groq: 'GROQ_API_KEY' };

/**
 * A provider's key and where it came from ('env', 'keychain' or 'file'), or { key: null }.
 * Keys are looked up when a request is made, never passed between processes.
 */
export async function keyFor(providerId, { config, secrets }) {
  const fromEnv = ENV_KEYS[providerId] && config.keys?.[providerId];
  if (fromEnv) return { key: fromEnv, from: 'env' };
  const stored = secrets ? await secrets.get(providerId) : null;
  return stored ? { key: stored, from: secrets.kind } : { key: null, from: null };
}

/**
 * Where provider keys are kept: the macOS Keychain, or elsewhere a file in the data folder
 * that only this user can read. A key goes in once and is never sent back to the page:
 * describe() says whether one is set and how it ends, nothing more.
 *
 * The Keychain is driven through `security -i`, which reads its commands from stdin, so a
 * key never appears in a command line where other processes could see it.
 */
export function createSecrets({ dataDir, useKeychain = true }) {
  useKeychain = useKeychain && process.platform === 'darwin' && fs.existsSync(SECURITY);
  const file = path.join(dataDir, 'secrets.json');

  const readFile = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeFile = (all) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  };

  const keychain = (stdin) =>
    new Promise((resolve, reject) => {
      const proc = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err += d));
      proc.on('error', reject);
      proc.on('close', (code) => (code ? reject(new SecretError(err.trim() || `security exited ${code}`)) : resolve(out)));
      proc.stdin.end(stdin);
    });

  const find = (account) =>
    new Promise((resolve) => {
      execFile(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { timeout: 10_000 }, (e, stdout) => resolve(e ? null : stdout.trim() || null));
    });

  // An account is a provider's id: letters, digits and dashes, so it is safe inside the command too.
  const checkAccount = (account) => {
    if (!/^[a-z0-9-]{1,40}$/.test(account)) throw new SecretError('That provider id is not usable.');
  };

  async function set(account, value) {
    checkAccount(account);
    const key = String(value || '').trim();
    if (!KEY_SHAPE.test(key)) throw new SecretError('That does not look like an API key: 8 to 512 letters, digits and . _ ~ + / = : - only.');
    if (useKeychain) {
      await keychain(`add-generic-password -U -s "${SERVICE}" -a "${account}" -w "${key}"\n`);
    } else {
      writeFile({ ...readFile(), [account]: key });
    }
    return describe(key);
  }

  async function get(account) {
    checkAccount(account);
    return useKeychain ? find(account) : readFile()[account] || null;
  }

  async function remove(account) {
    checkAccount(account);
    if (useKeychain) {
      await keychain(`delete-generic-password -s "${SERVICE}" -a "${account}"\n`).catch(() => {});
    } else {
      const all = readFile();
      delete all[account];
      writeFile(all);
    }
  }

  return { set, get, remove, kind: useKeychain ? 'keychain' : 'file', where: useKeychain ? 'the macOS Keychain' : file };
}

/** What the page may see of a key: that it is set, and its last four characters. */
export function describe(key) {
  return key ? { set: true, hint: `…${String(key).slice(-4)}` } : { set: false, hint: null };
}
