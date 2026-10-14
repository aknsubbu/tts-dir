import express from 'express';
import { COOKIE, ProfileError, SESSION_MAX_AGE_S } from './profiles.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The session token in the Cookie header, if any. */
export function tokenOf(req) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Sets req.profile from the session cookie (or the lone profile of an install with nothing to choose). */
export const attachProfile = (profiles) => (req, res, next) => {
  req.sessionToken = tokenOf(req);
  const { profile, implicit } = profiles.whoIs(req.sessionToken);
  req.profile = profile;
  req.implicitProfile = implicit;
  next();
};

/** Everything past the sign-in routes needs a profile. */
export const requireProfile = (req, res, next) => {
  if (!req.profile) return res.status(401).json({ error: 'Choose who is watching first.', signIn: true });
  next();
};

const asHttp = (e) => (e instanceof ProfileError ? Object.assign(new Error(e.message), { status: e.status, retryAfterSec: e.retryAfterSec }) : e);
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(asHttp(e));
  }
};
const ipOf = (req) => req.socket.remoteAddress || '';

/** The public face of a profile: enough for the "Who's watching?" screen, nothing else. */
const tile = ({ id, name, avatar, locked, isOwner }) => ({ id, name, avatar, locked, isOwner });

/**
 * Routes (under /api):
 *   GET    /profiles              public: the tiles, and whether more may be added
 *   GET    /session               who this browser is, and whether it must choose
 *   POST   /session               { profileId, pin? }
 *   DELETE /session
 *   POST   /profiles              { name, avatar?, pin?, ownerPin? }   public, like Add profile on the gate
 *   GET    /profiles/all          the Owner's view: every profile with what it may borrow from the host
 *   PATCH  /profiles/:id          { name?, avatar?, canUseHostClaude?, canUseHostKeys?, requirePinToAdd? }
 *   PUT    /profiles/:id/pin      { pin, currentPin? }
 *   DELETE /profiles/:id/pin      { currentPin? }
 *   DELETE /profiles/:id          { pin?, confirmName }
 */
export function profileRoutes({ profiles, removeProfileData }) {
  const open = express.Router(); // before the sign-in check
  const guarded = express.Router(); // after it

  const setCookie = (req, res, token) =>
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: SESSION_MAX_AGE_S * 1000 });

  const full = (p) => p && { ...tile(p), canUseHostClaude: p.canUseHostClaude, canUseHostKeys: p.canUseHostKeys, requirePinToAdd: p.requirePinToAdd };

  open.get('/profiles', (req, res) => {
    const all = profiles.list();
    res.json({ profiles: all.map(tile), max: profiles.max(), canAdd: all.length < profiles.max(), needsOwnerPinToAdd: !!profiles.owner().requirePinToAdd });
  });

  open.get('/session', (req, res) => {
    res.json({ profile: full(req.profile), needsGate: profiles.needsGate(), implicit: !!req.implicitProfile });
  });

  open.post(
    '/session',
    wrap(async (req, res) => {
      const b = req.body || {};
      const target = profiles.get(b.profileId);
      if (!target) throw httpError(404, 'No such profile.');
      profiles.verifyPin(target.id, b.pin, { ip: ipOf(req) });
      // Switching profiles ends the session you had.
      if (req.sessionToken) profiles.closeSession(req.sessionToken);
      setCookie(req, res, profiles.openSession(target.id));
      res.json({ profile: full(target) });
    }),
  );

  open.delete('/session', (req, res) => {
    if (req.sessionToken) profiles.closeSession(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  open.post(
    '/profiles',
    wrap(async (req, res) => {
      const b = req.body || {};
      const owner = profiles.owner();
      if (owner.requirePinToAdd && !req.profile?.isOwner) profiles.verifyPin(owner.id, b.ownerPin, { ip: ipOf(req) });
      if (b.pin !== undefined && b.pin !== null && b.pin !== '' && !/^\d{4}$/.test(String(b.pin))) throw httpError(400, 'A PIN is exactly 4 digits.');
      const made = profiles.create({ name: b.name, avatar: b.avatar });
      // Whoever adds the second profile to a one-profile install stays signed in as the first.
      if (req.implicitProfile) setCookie(req, res, profiles.openSession(req.profile.id));
      if (b.pin) profiles.setPin(made.id, String(b.pin));
      res.status(201).json({ profile: full(profiles.get(made.id)) });
    }),
  );

  const target = (req) => {
    const p = profiles.get(req.params.id);
    if (!p) throw httpError(404, 'No such profile.');
    return p;
  };
  const ownerOrSelf = (req, p) => {
    if (req.profile.id !== p.id && !req.profile.isOwner) throw httpError(403, 'Only the Owner can change another profile.');
  };

  guarded.get('/profiles/all', (req, res) => {
    if (!req.profile.isOwner) throw httpError(403, 'Only the Owner sees that.');
    res.json({ profiles: profiles.list().map(full) });
  });

  guarded.patch(
    '/profiles/:id',
    wrap(async (req, res) => {
      const p = target(req);
      ownerOrSelf(req, p);
      const b = req.body || {};
      const ownerOnly = ['canUseHostClaude', 'canUseHostKeys', 'requirePinToAdd'];
      if (ownerOnly.some((k) => b[k] !== undefined) && !req.profile.isOwner) throw httpError(403, 'Only the Owner decides that.');
      res.json({ profile: full(profiles.update(p.id, b)) });
    }),
  );

  /**
   * Changing or removing a PIN needs the current one. The Owner may reset someone else's, but only
   * by proving they are the Owner with their own PIN: a session on a PIN-less Owner is not proof,
   * since anyone at the gate can have one. With no Owner PIN there is the host command instead.
   */
  const authorisePinChange = (req, p) => {
    const b = req.body || {};
    if (req.profile.id === p.id) {
      if (p.locked) profiles.verifyPin(p.id, b.currentPin, { ip: ipOf(req) });
    } else if (req.profile.isOwner && !p.isOwner) {
      if (!p.locked) return; // nothing to get past
      if (!req.profile.locked) throw httpError(409, 'Set a PIN on the Owner profile first, or run: npm run profiles -- reset-pin <name> on the machine that hosts this.');
      profiles.verifyPin(req.profile.id, b.ownerPin, { ip: ipOf(req) });
    } else {
      throw httpError(403, 'Only the Owner can reset another profile\'s PIN.');
    }
  };
  const afterPinChange = (req, p) => profiles.closeSessionsOf(p.id, req.profile.id === p.id ? req.sessionToken : null);

  guarded.put(
    '/profiles/:id/pin',
    wrap(async (req, res) => {
      const p = target(req);
      authorisePinChange(req, p);
      profiles.setPin(p.id, String((req.body || {}).pin ?? ''));
      afterPinChange(req, p);
      if (req.implicitProfile) setCookie(req, res, profiles.openSession(p.id)); // the PIN is new: stay in
      res.json({ profile: full(profiles.get(p.id)) });
    }),
  );

  guarded.delete(
    '/profiles/:id/pin',
    wrap(async (req, res) => {
      const p = target(req);
      authorisePinChange(req, p);
      profiles.clearPin(p.id);
      afterPinChange(req, p);
      res.json({ profile: full(profiles.get(p.id)) });
    }),
  );

  guarded.delete(
    '/profiles/:id',
    wrap(async (req, res) => {
      const p = target(req);
      if (p.isOwner) throw httpError(403, 'The Owner profile cannot be deleted.');
      ownerOrSelf(req, p);
      const b = req.body || {};
      // A PIN stands in the way of deleting a profile: its own, or the Owner's when the Owner has one.
      // A locked profile with a PIN-less Owner can only be deleted by someone who knows its PIN.
      const gate = req.profile.id === p.id || req.profile.locked ? req.profile : p;
      profiles.verifyPin(gate.id, b.pin, { ip: ipOf(req) });
      if (String(b.confirmName ?? '').trim().toLowerCase() !== p.name.toLowerCase()) throw httpError(400, `Type the profile name (“${p.name}”) to confirm.`);
      await removeProfileData(p.id);
      profiles.remove(p.id);
      if (req.profile.id === p.id) res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    }),
  );

  return { open, guarded };
}
