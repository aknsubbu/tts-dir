import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * People who share this install: the "Who's watching?" screen (#who), the PIN prompt, the menu in
 * the header, and managing a profile (#profile). A profile is a name, an avatar (a colour and an
 * initial or emoji, never an image) and an optional 4-digit PIN. The PIN keeps housemates out of
 * each other's libraries; it is not security against someone with access to this computer.
 */

export const AVATAR_COLORS = ['#c2410c', '#0f766e', '#4338ca', '#a21caf', '#15803d', '#b91c1c', '#0369a1', '#a16207'];
const RESET_COMMAND = (name) => `npm run profiles -- reset-pin ${name}`;

export function Avatar({ profile, size = 'md' }) {
  return (
    <span className={`avatar ${size}`} style={{ background: profile?.avatar?.color }} aria-hidden="true">
      {profile?.avatar?.glyph}
    </span>
  );
}

function Padlock() {
  return (
    <svg className="padlock" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M5 7V5a3 3 0 1 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7zm1.5 0h3V5a1.5 1.5 0 0 0-3 0z" />
    </svg>
  );
}

/** A dialog that keeps focus inside and closes on Escape. */
function Modal({ label, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    return () => previous?.focus?.();
  }, []);
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')];
    if (!focusable.length) return;
    const [first, last] = [focusable[0], focusable[focusable.length - 1]];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="people-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="people-modal" role="dialog" aria-modal="true" aria-label={label} ref={ref} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}

/** Four boxes that take one digit each and move on by themselves. Calls onDone with the 4 digits. */
export function PinBoxes({ label, onDone, disabled = false, reset = 0 }) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = useRef([]);
  useEffect(() => {
    setDigits(['', '', '', '']);
  }, [reset]);
  useEffect(() => {
    if (!disabled) refs.current[0]?.focus();
  }, [disabled, reset]);

  const put = (i, raw) => {
    const typed = raw.replace(/\D/g, '');
    const next = digits.slice();
    if (!typed) {
      next[i] = '';
      setDigits(next);
      return;
    }
    for (let k = 0; k < typed.length && i + k < 4; k += 1) next[i + k] = typed[k];
    setDigits(next);
    refs.current[Math.min(3, i + typed.length)]?.focus();
    if (next.every(Boolean)) onDone(next.join(''));
  };
  const onKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      e.preventDefault();
      setDigits((d) => d.map((x, j) => (j === i - 1 ? '' : x)));
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < 3) refs.current[i + 1]?.focus();
  };
  return (
    <div className="pin-boxes" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="pin-box"
          type="text" data-lpignore="true" data-1p-ignore="true"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={4}
          aria-label={`${label}, digit ${i + 1} of 4`}
          value={d}
          disabled={disabled}
          onChange={(e) => put(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Ask for a profile's PIN and sign in with it. A wrong one shakes, and too many lock it for a while. */
export function PinEntry({ profile, onCancel, onSuccess }) {
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (pin) => {
    setBusy(true);
    try {
      const r = await api.signIn(profile.id, pin);
      onSuccess(r.profile);
    } catch (e) {
      setShake((n) => n + 1);
      const seconds = e.data?.retryAfterSec || 0;
      setWait(seconds);
      setError(seconds ? 'Too many wrong PINs.' : e.status === 401 ? 'That PIN is not right.' : e.message);
      setBusy(false);
    }
  };
  const locked = wait > 0;
  return (
    <Modal label={`PIN for ${profile.name}`} onClose={onCancel}>
      <div className="pin-head">
        <Avatar profile={profile} size="lg" />
        <h2>{profile.name}</h2>
        <p className="hint">Enter your 4-digit PIN.</p>
      </div>
      <div className={`pin-shake ${shake ? 'shake' : ''}`} key={shake}>
        <PinBoxes label={`PIN for ${profile.name}`} onDone={submit} disabled={busy || locked} reset={shake} />
      </div>
      <p className="pin-status" role="status" aria-live="polite">
        {locked ? `${error} Try again in ${clock(wait)}.` : error}
      </p>
      <div className="row">
        <button className="link" onClick={() => setForgot((f) => !f)} aria-expanded={forgot}>Forgot PIN?</button>
        <span className="grow" />
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
      {forgot && (
        <div className="hint forgot">
          <p>The Owner can reset it from <b>Manage profile</b>, or you can remove it on the computer that runs Narrated Proofs:</p>
          <p><code>{RESET_COMMAND(profile.name)}</code></p>
          <p>Whoever has access to that computer can already read everything here, which is why this needs no PIN.</p>
        </div>
      )}
    </Modal>
  );
}

function Swatches({ value, onChange, label = 'Colour' }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {AVATAR_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`swatch ${value === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

const digitsOnly = (s) => s.replace(/\D/g, '').slice(0, 4);
function PinField({ label, value, onChange, hint }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input pin-field" type="text" data-lpignore="true" data-1p-ignore="true" inputMode="numeric" pattern="[0-9]*" maxLength={4} autoComplete="off" aria-describedby={hint ? `${id}-hint` : undefined} value={value} onChange={(e) => onChange(digitsOnly(e.target.value))} />
      {hint && <span className="hint" id={`${id}-hint`}>{hint}</span>}
    </div>
  );
}

function AddProfile({ onCancel, onAdded, needsOwnerPin }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[1]);
  const [glyph, setGlyph] = useState('');
  const [pin, setPin] = useState('');
  const [ownerPin, setOwnerPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = { avatar: { color, glyph: glyph || [...name.trim()][0]?.toUpperCase() || '?' } };

  const submit = async (e) => {
    e.preventDefault();
    if (pin && pin.length !== 4) return setError('A PIN is exactly 4 digits.');
    setBusy(true);
    setError('');
    try {
      const made = (await api.addProfile({ name, avatar: { color, glyph }, ...(pin ? { pin } : {}), ...(needsOwnerPin ? { ownerPin } : {}) })).profile;
      const entered = await api.signIn(made.id, pin || undefined);
      onAdded(entered.profile);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal label="Add profile" onClose={onCancel}>
      <form onSubmit={submit} className="people-form">
        <h2>Add profile</h2>
        <div className="row"><Avatar profile={shown} size="lg" /><label className="field grow">Name<input className="input" autoFocus maxLength={24} value={name} onChange={(e) => setName(e.target.value)} /></label></div>
        <Swatches value={color} onChange={setColor} />
        <label className="field">Initial or emoji<input className="input glyph-input" maxLength={4} value={glyph} placeholder={shown.avatar.glyph} onChange={(e) => setGlyph(e.target.value)} /></label>
        <PinField label="PIN (optional)" value={pin} onChange={setPin} hint="4 digits. It keeps others out of your lessons; it is not strong security." />
        {needsOwnerPin && <PinField label="Owner’s PIN" value={ownerPin} onChange={setOwnerPin} hint="The Owner asked to approve new profiles." />}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="row">
          <span className="grow" />
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>Add and open</button>
        </div>
      </form>
    </Modal>
  );
}

/** "Who's watching?": a tile per profile, a padlock on locked ones, Add profile, and Manage profiles. */
export function WhoIsWatching({ onSignedIn, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [manage, setManage] = useState(false);
  const [pinFor, setPinFor] = useState(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.profiles().then(setData, (e) => setError(e.message));
  }, []);

  const entered = (profile) => onSignedIn(profile, { manage });
  const choose = async (p) => {
    if (p.locked) return setPinFor(p);
    try {
      entered((await api.signIn(p.id)).profile);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <main className="who" aria-labelledby="who-title">
      {onBack && <button className="link who-back" onClick={onBack}>← Back</button>}
      <h1 id="who-title">{manage ? 'Manage profiles' : 'Who’s watching?'}</h1>
      {error && <p className="field-error" role="alert">{error}</p>}
      {!data && !error && <p className="hint">Loading…</p>}
      {data && (
        <ul className="who-grid">
          {data.profiles.map((p) => (
            <li key={p.id}>
              <button className={`tile ${manage ? 'managing' : ''}`} onClick={() => choose(p)} aria-label={`${p.name}${p.locked ? ', locked with a PIN' : ''}${manage ? ', edit this profile' : ''}`}>
                <span className="tile-avatar">
                  <Avatar profile={p} size="xl" />
                  {p.locked && <span className="lock-badge"><Padlock /></span>}
                  {manage && <span className="pencil" aria-hidden="true">✎</span>}
                </span>
                <span className="tile-name">{p.name}</span>
              </button>
            </li>
          ))}
          {data.canAdd && (
            <li>
              <button className="tile add" onClick={() => setAdding(true)}>
                <span className="tile-avatar"><span className="avatar xl add-avatar" aria-hidden="true">+</span></span>
                <span className="tile-name">Add profile</span>
              </button>
            </li>
          )}
        </ul>
      )}
      <button className="btn" aria-pressed={manage} onClick={() => setManage((m) => !m)}>{manage ? 'Done' : 'Manage profiles'}</button>
      {pinFor && <PinEntry profile={pinFor} onCancel={() => setPinFor(null)} onSuccess={entered} />}
      {adding && <AddProfile needsOwnerPin={data?.needsOwnerPinToAdd} onCancel={() => setAdding(false)} onAdded={entered} />}
    </main>
  );
}

/** Your avatar in the header, and what it opens: switch, manage, sign out. */
export function ProfileMenu({ profile }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  if (!profile) return null;
  const go = (hash) => {
    setOpen(false);
    window.location.hash = hash;
  };
  const signOut = async () => {
    setOpen(false);
    await api.signOut().catch(() => {});
    window.location.hash = '#who';
    window.dispatchEvent(new Event('tts:signin'));
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      setOpen(false);
      box.current?.querySelector('button')?.focus();
    }
  };
  return (
    <div className="profile-menu" ref={box} onKeyDown={onKeyDown}>
      <button className="profile-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Switch or manage profiles">
        <Avatar profile={profile} size="sm" />
        <span className="profile-name">{profile.name}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" autoFocus onClick={() => go('#who')}>Switch profile</button>
          <button role="menuitem" onClick={() => go('#profile')}>Manage profile</button>
          <button role="menuitem" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, children, disabled = false }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Deleting a profile: its lessons and keys go too, so it asks for a PIN where there is one, and the name. */
function DeleteProfile({ target, pinOwner, you, onDone, toast }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  // Whose PIN stands in the way: your own for your own profile, the Owner's for someone else's, or theirs when the Owner has none.
  const gate = target.id === you.id ? (you.locked ? 'Your PIN' : null) : you.locked ? 'Your PIN (the Owner’s)' : target.locked ? `${target.name}’s PIN` : null;
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.deleteProfile(target.id, { confirmName: name, ...(pin ? { pin } : {}) });
      toast?.({ kind: 'success', text: `Deleted ${target.name} and everything in it.` });
      onDone(target.id === you.id);
    } catch (err) {
      setError(err.message);
    }
  };
  if (!open) return <button className="btn danger small" onClick={() => setOpen(true)}>Delete {target.name}…</button>;
  return (
    <form className="people-form danger-zone" onSubmit={submit}>
      <p><b>This deletes {target.name}’s lessons, settings and keys. It cannot be undone.</b></p>
      {gate && <PinField label={gate} value={pin} onChange={setPin} />}
      {gate === null && pinOwner && <p className="hint">Set a PIN on your own profile to protect this.</p>}
      <label className="field">Type “{target.name}” to confirm<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn danger" disabled={name.trim().toLowerCase() !== target.name.toLowerCase()}>Delete forever</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Keep it</button>
      </div>
    </form>
  );
}

/** What the Owner decides about another profile: what it may borrow from this computer, and its PIN. */
function OtherProfile({ p, you, reload, toast }) {
  const [resetOpen, setResetOpen] = useState(false);
  const [ownerPin, setOwnerPin] = useState('');
  const [fresh, setFresh] = useState('');
  const [error, setError] = useState('');
  const patch = (body) => api.patchProfile(p.id, body).then(reload, (e) => toast?.({ kind: 'error', text: e.message }));
  const reset = async (remove) => {
    setError('');
    try {
      if (remove) await api.removePin(p.id, { ownerPin });
      else await api.setPin(p.id, { pin: fresh, ownerPin });
      toast?.({ kind: 'success', text: remove ? `Removed ${p.name}’s PIN.` : `Set a new PIN for ${p.name}.` });
      setResetOpen(false);
      setOwnerPin('');
      setFresh('');
      reload();
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <li className="other-profile">
      <div className="row"><Avatar profile={p} /><strong>{p.name}</strong>{p.locked && <span className="badge"><Padlock /> PIN</span>}</div>
      <Toggle checked={p.canUseHostClaude} onChange={(v) => patch({ canUseHostClaude: v })}>May use this Mac’s Claude sign-in</Toggle>
      <Toggle checked={p.canUseHostKeys} onChange={(v) => patch({ canUseHostKeys: v })}>May use the host’s API keys (the ones in .env)</Toggle>
      {p.locked && !resetOpen && <button className="link" onClick={() => setResetOpen(true)}>Reset {p.name}’s PIN…</button>}
      {resetOpen && (
        you.locked ? (
          <div className="people-form">
            <PinField label="Your PIN (the Owner’s)" value={ownerPin} onChange={setOwnerPin} hint="Resetting someone’s PIN signs them out everywhere." />
            <PinField label="New PIN (leave empty to remove it)" value={fresh} onChange={setFresh} />
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="row">
              <button className="btn" disabled={fresh.length !== 4 || ownerPin.length !== 4} onClick={() => reset(false)}>Set new PIN</button>
              <button className="btn" disabled={ownerPin.length !== 4} onClick={() => reset(true)}>Remove PIN</button>
              <button className="link" onClick={() => setResetOpen(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <p className="hint">Set a PIN on your own profile first, so only you can do this. Or, on the computer that runs Narrated Proofs: <code>{RESET_COMMAND(p.name)}</code></p>
        )
      )}
      <DeleteProfile target={p} you={you} onDone={reload} toast={toast} />
    </li>
  );
}

/** Manage the signed-in profile (#profile): name and avatar, PIN, delete; and for the Owner, everyone else. */
export function ManageProfile({ profile, onClose, onChanged, toast }) {
  const [all, setAll] = useState(null);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.avatar.color);
  const [glyph, setGlyph] = useState(profile.avatar.glyph);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pinError, setPinError] = useState('');
  const [error, setError] = useState('');

  // Only the Owner sees the others, with what each may borrow from this computer.
  const load = useCallback(() => (profile.isOwner ? api.allProfiles().then((r) => setAll(r.profiles)).catch(() => {}) : undefined), [profile.isOwner]);
  const reload = useCallback(() => {
    load();
    onChanged();
  }, [load, onChanged]);
  useEffect(() => {
    load();
  }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.patchProfile(profile.id, { name, avatar: { color, glyph } });
      toast?.({ kind: 'success', text: 'Saved.' });
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  const pinAction = (fn, done) => async () => {
    setPinError('');
    try {
      const r = await fn();
      toast?.({ kind: 'success', text: r?.tokensRevoked ? `${done} Claude’s connector tokens for this profile were revoked: make new ones in Settings → Connect Claude.` : done, ms: r?.tokensRevoked ? 10000 : undefined });
      setCurrent('');
      setNext('');
      reload();
    } catch (err) {
      setPinError(err.message);
    }
  };
  const others = (all || []).filter((p) => p.id !== profile.id);
  const you = profile;

  return (
    <div className="workspace settings" role="dialog" aria-modal="true" aria-label="Manage profile">
      <div className="ws-top">
        <header className="ws-head">
          <div className="ws-row">
            <button className="link ws-back" onClick={onClose}>← Library</button>
            <h2 className="settings-title">Manage profile</h2>
          </div>
        </header>
      </div>
      <div className="ws-body settings-body">
        <section className="block">
          <h3>You</h3>
          <form className="people-form" onSubmit={save}>
            <div className="row"><Avatar profile={{ avatar: { color, glyph } }} size="lg" /><label className="field grow">Name<input className="input" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} /></label></div>
            <Swatches value={color} onChange={setColor} />
            <label className="field">Initial or emoji<input className="input glyph-input" maxLength={4} value={glyph} onChange={(e) => setGlyph(e.target.value)} /></label>
            {error && <p className="field-error" role="alert">{error}</p>}
            <div><button className="btn primary" disabled={!name.trim()}>Save</button></div>
          </form>
        </section>

        <section className="block">
          <h3>PIN</h3>
          <p className="hint">{you.locked ? 'Your profile asks for a PIN when someone opens it.' : 'Add a 4-digit PIN to keep housemates out of your lessons. It is privacy between people sharing a computer, not strong security.'}</p>
          <div className="people-form">
            {you.locked && <PinField label="Current PIN" value={current} onChange={setCurrent} />}
            <PinField label={you.locked ? 'New PIN' : 'PIN'} value={next} onChange={setNext} />
            {pinError && <p className="field-error" role="alert">{pinError}</p>}
            <div className="row">
              <button className="btn" disabled={next.length !== 4 || (you.locked && current.length !== 4)} onClick={pinAction(() => api.setPin(you.id, { pin: next, ...(you.locked ? { currentPin: current } : {}) }), you.locked ? 'PIN changed.' : 'PIN set.')}>{you.locked ? 'Change PIN' : 'Set PIN'}</button>
              {you.locked && <button className="btn" disabled={current.length !== 4} onClick={pinAction(() => api.removePin(you.id, { currentPin: current }), 'PIN removed.')}>Remove PIN</button>}
            </div>
          </div>
        </section>

        {you.isOwner && (
          <section className="block">
            <h3>The Owner</h3>
            <Toggle checked={you.requirePinToAdd} disabled={!you.locked} onChange={(v) => api.patchProfile(you.id, { requirePinToAdd: v }).then(reload, (e) => toast?.({ kind: 'error', text: e.message }))}>
              Ask for my PIN before anyone adds a profile
            </Toggle>
            {!you.locked && <p className="hint">Set a PIN on your profile first.</p>}
            <h3>Other profiles</h3>
            {others.length === 0 && <p className="hint">No one else yet. They can add themselves from “Who’s watching?”.</p>}
            <ul className="other-profiles">
              {others.map((p) => <OtherProfile key={p.id} p={p} you={you} reload={reload} toast={toast} />)}
            </ul>
          </section>
        )}

        {!you.isOwner && (
          <section className="block">
            <h3>Delete this profile</h3>
            <DeleteProfile target={you} you={you} onDone={() => { window.location.hash = '#who'; window.dispatchEvent(new Event('tts:signin')); }} toast={toast} />
          </section>
        )}
      </div>
    </div>
  );
}
