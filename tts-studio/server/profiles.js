import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * People who share one install. A profile is a name, an avatar, an optional 4-digit PIN and
 * its own library. This is privacy between housemates, not security against someone set on
 * getting in: a LAN speaks plain HTTP, and whoever can read the data folder can read it all.
 *
 * A PIN is kept as scrypt(HMAC(pepper, pin), salt). The pepper is a random file in the data
 * folder, mode 0600, so the database alone does not let anyone try PINs offline.
 */

export class ProfileError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  avatar_json          TEXT NOT NULL,
  pin_hash             TEXT,
  pin_salt             TEXT,
  is_owner             INTEGER NOT NULL DEFAULT 0,
  can_use_host_claude  INTEGER NOT NULL DEFAULT 0,
  can_use_host_keys    INTEGER NOT NULL DEFAULT 0,
  require_pin_to_add   INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
CREATE TABLE IF NOT EXISTS pin_attempts (
  profile_id    TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0
);
`;

export const COOKIE = 'tts_session';
export const PIN_SHAPE = /^\d{4}$/;
export const COLORS = ['#c2410c', '#0f766e', '#4338ca', '#a21caf', '#15803d', '#b91c1c', '#0369a1', '#a16207'];
const NAME_MAX = 24;
const LOCK_AFTER = 5; // wrong tries
const LOCK_FIRST_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX_ATTEMPTS = 30;
const IDLE_LOCKED_MS = 7 * 24 * 3600_000; // a locked profile's session ends after a week unused
const IDLE_OPEN_MS = 90 * 24 * 3600_000;
export const SESSION_MAX_AGE_S = IDLE_OPEN_MS / 1000;

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
// Lowercase hex, because a profile's id is part of the name its keys are kept under.
const newId = () => crypto.randomBytes(8).toString('hex');

/** `getMax` is read on every use, so TTS_MAX_PROFILES can change with a restart of nothing but the .env. */
export function createProfiles({ db, dataDir, getMax = () => 5, now = () => Date.now(), ipMax = IP_MAX_ATTEMPTS }) {
  db.exec(SCHEMA);

  // ---------- the pepper ----------
  const pepperFile = path.join(dataDir, 'pin-pepper');
  function pepper() {
    try {
      return fs.readFileSync(pepperFile);
    } catch {
      fs.mkdirSync(dataDir, { recursive: true });
      const fresh = crypto.randomBytes(32);
      try {
        fs.writeFileSync(pepperFile, fresh, { mode: 0o600, flag: 'wx' });
        return fresh;
      } catch {
        return fs.readFileSync(pepperFile); // another process made it first
      }
    }
  }
  try {
    fs.chmodSync(pepperFile, 0o600);
  } catch {
    /* not made yet */
  }
  const derive = (pin, salt) => crypto.scryptSync(crypto.createHmac('sha256', pepper()).update(pin).digest(), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });

  // ---------- profiles ----------
  const toRow = (r) =>
    r && {
      id: r.id,
      name: r.name,
      avatar: JSON.parse(r.avatar_json),
      locked: !!r.pin_hash,
      isOwner: !!r.is_owner,
      canUseHostClaude: !!r.can_use_host_claude,
      canUseHostKeys: !!r.can_use_host_keys,
      requirePinToAdd: !!r.require_pin_to_add,
      createdAt: r.created_at,
    };
  const raw = (id) => db.prepare('SELECT * FROM profiles WHERE id = ?').get(String(id ?? ''));
  const get = (id) => toRow(raw(id));
  const list = () => db.prepare('SELECT * FROM profiles ORDER BY created_at, rowid').all().map(toRow);
  const owner = () => toRow(db.prepare('SELECT * FROM profiles WHERE is_owner = 1').get());

  const cleanName = (value) => {
    const name = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new ProfileError('A profile needs a name.');
    if ([...name].length > NAME_MAX) throw new ProfileError(`A name is at most ${NAME_MAX} characters.`);
    return name;
  };
  const checkUnique = (name, exceptId = '') => {
    const taken = db.prepare('SELECT id FROM profiles WHERE lower(name) = lower(?) AND id != ?').get(name, exceptId);
    if (taken) throw new ProfileError('Another profile already has that name.', 409);
  };
  /** An avatar is a colour and one or two characters (an initial or an emoji). Never an image. */
  const cleanAvatar = (value, name, index = 0) => {
    const a = value && typeof value === 'object' ? value : {};
    const color = COLORS.includes(a.color) ? a.color : COLORS[index % COLORS.length];
    const glyph = [...String(a.glyph ?? '').trim()].slice(0, 2).join('') || [...name][0].toUpperCase();
    return { color, glyph };
  };

  function create({ name, avatar, owner: isOwner = false }) {
    const clean = cleanName(name);
    if (!isOwner && list().length >= getMax()) throw new ProfileError(`This install allows ${getMax()} profiles.`, 409);
    checkUnique(clean);
    const id = newId();
    db.prepare(
      `INSERT INTO profiles (id, name, avatar_json, is_owner, can_use_host_claude, can_use_host_keys, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, clean, JSON.stringify(cleanAvatar(avatar, clean, list().length)), isOwner ? 1 : 0, isOwner ? 1 : 0, isOwner ? 1 : 0, now());
    return get(id);
  }

  function update(id, patch = {}) {
    const row = raw(id);
    if (!row) throw new ProfileError('No such profile.', 404);
    const sets = {};
    if (patch.name !== undefined) {
      sets.name = cleanName(patch.name);
      checkUnique(sets.name, id);
    }
    if (patch.avatar !== undefined) sets.avatar_json = JSON.stringify(cleanAvatar(patch.avatar, sets.name || row.name));
    // The Owner always has the host's resources; for anyone else the Owner decides.
    if (!row.is_owner) {
      if (patch.canUseHostClaude !== undefined) sets.can_use_host_claude = patch.canUseHostClaude ? 1 : 0;
      if (patch.canUseHostKeys !== undefined) sets.can_use_host_keys = patch.canUseHostKeys ? 1 : 0;
    }
    if (patch.requirePinToAdd !== undefined && row.is_owner) {
      if (patch.requirePinToAdd && !row.pin_hash) throw new ProfileError('Set a PIN on the Owner profile first.', 409);
      sets.require_pin_to_add = patch.requirePinToAdd ? 1 : 0;
    }
    const keys = Object.keys(sets);
    if (keys.length) db.prepare(`UPDATE profiles SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...sets, id });
    return get(id);
  }

  // ---------- PINs and lockout ----------
  const ipHits = new Map(); // ip -> times of recent wrong or right tries
  function ipGate(ip) {
    if (!ip) return;
    const t = now();
    const recent = (ipHits.get(ip) || []).filter((x) => t - x < IP_WINDOW_MS);
    if (recent.length >= ipMax) {
      ipHits.set(ip, recent);
      throw new ProfileError('Too many tries from this device. Wait a few minutes.', 429, { retryAfterSec: Math.ceil((IP_WINDOW_MS - (t - recent[0])) / 1000) });
    }
    recent.push(t);
    ipHits.set(ip, recent);
  }

  const attempts = (id) => db.prepare('SELECT * FROM pin_attempts WHERE profile_id = ?').get(id) || { failures: 0, locked_until: 0 };

  /** Seconds a profile is locked out for, or 0. */
  const lockedFor = (id) => Math.max(0, Math.ceil((attempts(id).locked_until - now()) / 1000));

  /**
   * Check a PIN. Throws when wrong or when the profile is locked out; returns when right or when
   * the profile has no PIN. A locked-out profile refuses even the right PIN, or the lock is pointless.
   * A wrong PIN says nothing but that it was wrong (and how long to wait, once locked).
   */
  function verifyPin(id, pin, { ip = '' } = {}) {
    const row = raw(id);
    if (!row) throw new ProfileError('That PIN is not right.', 401);
    if (!row.pin_hash) return;
    ipGate(ip);
    const wait = lockedFor(id);
    if (wait) throw new ProfileError('Too many wrong PINs. Try again later.', 429, { retryAfterSec: wait });
    let ok = false;
    if (PIN_SHAPE.test(String(pin ?? ''))) {
      const expected = Buffer.from(row.pin_hash, 'hex');
      ok = crypto.timingSafeEqual(derive(String(pin), row.pin_salt), expected);
    }
    if (ok) {
      db.prepare('DELETE FROM pin_attempts WHERE profile_id = ?').run(id);
      return;
    }
    const failures = attempts(id).failures + 1;
    let lockedUntil = 0;
    let retryAfterSec = 0;
    if (failures % LOCK_AFTER === 0) {
      const ms = Math.min(LOCK_FIRST_MS * 2 ** (failures / LOCK_AFTER - 1), LOCK_MAX_MS);
      lockedUntil = now() + ms;
      retryAfterSec = Math.ceil(ms / 1000);
    }
    db.prepare(
      `INSERT INTO pin_attempts (profile_id, failures, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
    ).run(id, failures, lockedUntil);
    throw new ProfileError('That PIN is not right.', retryAfterSec ? 429 : 401, retryAfterSec ? { retryAfterSec } : {});
  }

  function setPin(id, pin) {
    if (!raw(id)) throw new ProfileError('No such profile.', 404);
    if (!PIN_SHAPE.test(String(pin ?? ''))) throw new ProfileError('A PIN is exactly 4 digits.');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE profiles SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(derive(String(pin), salt).toString('hex'), salt, id);
    db.prepare('DELETE FROM pin_attempts WHERE profile_id = ?').run(id);
  }

  function clearPin(id) {
    db.prepare('UPDATE profiles SET pin_hash = NULL, pin_salt = NULL' + (raw(id)?.is_owner ? ', require_pin_to_add = 0' : '') + ' WHERE id = ?').run(id);
    db.prepare('DELETE FROM pin_attempts WHERE profile_id = ?').run(id);
  }

  // ---------- sessions ----------
  /** A new session for a profile: the token goes in a cookie, only its hash is kept. */
  function openSession(profileId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    db.prepare('INSERT INTO sessions (token_hash, profile_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(sha(token), profileId, t, t);
    return token;
  }

  /** The profile row a token belongs to, or null (unknown, or idle for too long). */
  function sessionProfile(token) {
    if (!token) return null;
    const hash = sha(String(token));
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
    if (!s) return null;
    const row = raw(s.profile_id);
    const idle = row?.pin_hash ? IDLE_LOCKED_MS : IDLE_OPEN_MS;
    if (!row || now() - s.last_used > idle) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return null;
    }
    if (now() - s.last_used > 60_000) db.prepare('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(now(), hash);
    return toRow(row);
  }

  const closeSession = (token) => token && db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(String(token)));
  /** Every session of a profile, except (optionally) the one making the change. */
  const closeSessionsOf = (profileId, exceptToken = null) =>
    db.prepare('DELETE FROM sessions WHERE profile_id = ? AND token_hash != ?').run(profileId, exceptToken ? sha(String(exceptToken)) : '');

  // ---------- removing ----------
  /** The database side of deleting a profile. The caller removes its lessons and files first. */
  function remove(id) {
    const row = raw(id);
    if (!row) throw new ProfileError('No such profile.', 404);
    if (row.is_owner) throw new ProfileError('The Owner profile cannot be deleted.', 403);
    db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(id);
    db.prepare('DELETE FROM pin_attempts WHERE profile_id = ?').run(id);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  // ---------- first run and migration ----------
  /**
   * Make sure an Owner exists and holds every lesson that had no owner. Safe to run again:
   * it only fills in what is missing. A library from before profiles lands under the Owner.
   */
  function ensureOwner() {
    let o = owner();
    if (!o) o = create({ name: 'Owner', owner: true, avatar: { color: COLORS[0], glyph: 'O' } });
    db.prepare("UPDATE generations SET profile_id = ? WHERE profile_id = ''").run(o.id);
    return o;
  }
  ensureOwner();

  /**
   * Who a request is. A session cookie names a profile. With no cookie, an install of one profile
   * and no PIN is that profile: nothing to choose, as before profiles existed.
   */
  function whoIs(token) {
    const own = sessionProfile(token);
    if (own) return { profile: own, implicit: false };
    const all = list();
    if (all.length === 1 && !all[0].locked) return { profile: all[0], implicit: true };
    return { profile: null, implicit: false };
  }

  return {
    list, get, owner, create, update, remove, ensureOwner,
    verifyPin, setPin, clearPin, lockedFor,
    openSession, sessionProfile, closeSession, closeSessionsOf, whoIs,
    max: () => getMax(),
    needsGate: () => {
      const all = list();
      return !(all.length === 1 && !all[0].locked);
    },
  };
}
