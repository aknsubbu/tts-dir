import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { timeAgo } from '../utils.js';
import CodeEditor, { goToLine } from './CodeEditor.jsx';

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.3];

/** Errors and warnings for one file, in the editor's terms. */
function problemsFor(file, report, fallback) {
  const all = [...(report?.errors || []).map((e) => ({ ...e, severity: 'error' })), ...(report?.warnings || []).map((w) => ({ ...w, severity: 'warning' }))];
  return all.filter((p) => (p.file || (p.where === fallback ? fallback : null)) === file);
}

/**
 * The Edit tab: the lesson's script.txt and scenes.py, its voice and speed. ⌘S saves and runs
 * the quick check (problems are underlined on their lines); Check runs the full check, which
 * speaks changed blocks and runs every scene without drawing; Render makes the next version and
 * builds it; Discard goes back to the current version.
 */
export default function EditTab({ g, voices, toast }) {
  const [src, setSrc] = useState(null); // what the server last said
  const [draft, setDraft] = useState(null); // { script, scenes, voice, speed } as edited here
  const [state, setState] = useState('idle'); // idle | saving | starting
  const [stale, setStale] = useState(null); // the files as they are on disk, when they changed underneath
  const [pane, setPane] = useState('script');
  const [error, setError] = useState('');
  const views = { script: useRef(null), scenes: useRef(null) };
  const busy = g.status === 'queued' || g.status === 'processing';

  const load = useCallback(async () => {
    try {
      const s = await api.source(g.id);
      setSrc(s);
      setDraft(fromSource(s));
      setError('');
      return s;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [g.id]);

  useEffect(() => {
    load();
  }, [load]);

  // When the lesson moves on (a check ends, a version lands), fetch again. Files changed on disk
  // while you have unsaved edits are offered for reload instead of replacing them.
  const moved = `${g.status}|${g.version}|${g.builtVersion}`;
  const lastMoved = useRef(moved);
  useEffect(() => {
    if (lastMoved.current === moved) return;
    lastMoved.current = moved;
    api.source(g.id).then((s) => {
      setSrc(s);
      setDraft((d) => {
        if (!d || s.hash === d.hash || !dirtyOf(d, src)) return fromSource(s);
        setStale(s);
        return d;
      });
    }).catch(() => {});
  }, [moved]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(draft && src && dirtyOf(draft, src));
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async ({ overwrite = false } = {}) => {
    if (!draft || busy) return src;
    setState('saving');
    try {
      const base = overwrite ? stale?.hash : draft.hash;
      const s = await api.saveSource(g.id, { base, script: draft.script, scenes: draft.scenes, voice: draft.voice, speed: draft.speed });
      setSrc(s);
      setDraft((d) => ({ ...d, hash: s.hash }));
      setStale(null);
      return s;
    } catch (e) {
      if (e.status === 409 && e.data?.current) setStale(e.data.current);
      else toast({ kind: 'error', text: e.message, ms: 9000 });
      return null;
    } finally {
      setState('idle');
    }
  };

  const start = async (what) => {
    if (dirty && !(await save())) return;
    setState('starting');
    try {
      if (what === 'build') await api.buildEdit(g.id, g.settings?.quality);
      else await api.checkEdit(g.id);
      toast({ kind: 'success', text: what === 'build' ? `Checking, then rendering v${(g.version || 0) + 1}.` : 'Checking: the narration is spoken and every scene is run. The storyboard updates when it ends.' });
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
    } finally {
      setState('idle');
    }
  };

  const discard = async () => {
    if (!window.confirm(`Throw away every change since v${src.version}?`)) return;
    try {
      const s = await api.discard(g.id);
      setSrc(s);
      setDraft(fromSource(s));
      setStale(null);
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
  };

  const reload = () => {
    setDraft(fromSource(stale));
    setSrc((s) => ({ ...s, ...stale }));
    setStale(null);
  };

  // The quick check after a save, or the full check's report when it is the newer of the two.
  const report = useMemo(() => [src?.static, src?.report].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null, [src]);
  const spokenFor = useMemo(() => {
    const out = {};
    for (const b of src?.report?.blocks || []) if (b.duration) out[b.id] = b.duration;
    return out;
  }, [src]);
  const scriptProblems = useMemo(() => problemsFor('script.txt', report, 'script.txt'), [report]);
  const scenesProblems = useMemo(() => problemsFor('scenes.py', report, 'scenes.py'), [report]);
  const english = voices.filter((v) => v.lang === 'a' || v.lang === 'b');

  if (!src || !draft) return <p className="hint">{error || 'Loading the files…'}</p>;
  if (!src.editable) {
    return <p className="status-box">This video was built from a project written by hand (<code>video/projects/{src.project}/</code>). Edit it in its folder and rebuild it from the Narrated video panel.</p>;
  }

  const problems = [...(report?.errors || []).map((p) => ({ ...p, severity: 'error' })), ...(report?.warnings || []).map((p) => ({ ...p, severity: 'warning' }))];
  const errors = report?.errors?.length || 0;
  const status = state === 'saving' ? 'Saving…' : dirty ? 'Unsaved changes' : src.draft ? `Saved, not yet rendered · differs from v${src.version}` : 'Saved';
  const which = report === src.report && src.report ? `full check ${timeAgo(src.report.at)}` : report ? 'quick check' : null;
  // A version whose build failed is built again as itself; any change makes the next one.
  const next = !dirty && !src.draft && src.version && src.builtVersion !== src.version ? src.version : (src.version || 0) + 1;

  return (
    <div className="edit-tab">
      <div className="edit-bar">
        <label className="field inline">
          <span>Voice</span>
          <select className="input" value={draft.voice || ''} disabled={busy} onChange={(e) => setDraft({ ...draft, voice: e.target.value })}>
            {english.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} ({v.lang === 'b' ? 'British' : 'American'})</option>)}
            {!english.some((v) => v.voiceId === draft.voice) && <option value={draft.voice || ''}>{draft.voice}</option>}
          </select>
        </label>
        <label className="field inline">
          <span>Speed</span>
          <select className="input" value={draft.speed} disabled={busy} onChange={(e) => setDraft({ ...draft, speed: Number(e.target.value) })}>
            {[...new Set([...SPEEDS, draft.speed])].sort().map((s) => <option key={s} value={s}>{s.toFixed(1)}×</option>)}
          </select>
        </label>
        <span className="edit-status" role="status">
          {status}
          {which ? ` · ${which}` : ''}
          {report ? ` · ${errors ? `${errors} problem${errors === 1 ? '' : 's'}` : 'no problems'}` : ''}
        </span>
        <span className="grow" />
        {(dirty || src.draft) && <button className="btn" disabled={busy} onClick={discard}>Discard</button>}
        <button className="btn" disabled={busy || !dirty || state !== 'idle'} onClick={() => save()} title="⌘S">Save</button>
        <button className="btn" disabled={busy || state !== 'idle'} onClick={() => start('check')}>Check</button>
        <button className="btn primary" disabled={busy || state !== 'idle' || errors > 0} onClick={() => start('build')} title={errors ? 'Fix the problems first' : `Check, then render as v${next}`}>
          Render v{next}
        </button>
      </div>

      {busy && <p className="status-box processing">{g.stage || 'Building'}… The files can be edited once it finishes.</p>}
      {stale && (
        <div className="banner claude-change" role="alert">
          <span>The files changed on disk since you opened them, in another editor or by a revision.</span>
          <span className="row">
            <button className="btn" onClick={reload}>Load theirs</button>
            <button className="btn" onClick={() => save({ overwrite: true })}>Keep mine</button>
          </span>
        </div>
      )}
      {g.settings?.edit && g.settings.edit.ok === false && !busy && (
        <p className="hint over-limit">The last check {g.settings.edit.error ? `could not run: ${g.settings.edit.error}` : `found ${g.settings.edit.errors} problem${g.settings.edit.errors === 1 ? '' : 's'}, so nothing was rendered`}.</p>
      )}

      <div className="pane-tabs" role="tablist" aria-label="Files">
        {[['script', 'script.txt', scriptProblems], ['scenes', 'scenes.py', scenesProblems]].map(([k, name, list]) => (
          <button key={k} role="tab" aria-selected={pane === k} className={pane === k ? 'on' : ''} onClick={() => setPane(k)}>
            {name}{list.length ? ` · ${list.length}` : ''}
          </button>
        ))}
      </div>
      <div className="editors">
        <section className={`pane ${pane === 'script' ? 'on' : ''}`}>
          <h4>script.txt {draft.script !== (src.script || '') ? <span className="hint">edited</span> : null}</h4>
          <CodeEditor label="script.txt" language="script" value={draft.script} readOnly={busy} problems={scriptProblems} durations={spokenFor} viewRef={views.script} onChange={(script) => setDraft((d) => ({ ...d, script }))} onSave={() => save()} />
        </section>
        <section className={`pane ${pane === 'scenes' ? 'on' : ''}`}>
          <h4>scenes.py {draft.scenes !== (src.scenes || '') ? <span className="hint">edited</span> : null}</h4>
          <CodeEditor label="scenes.py" language="python" value={draft.scenes} readOnly={busy} problems={scenesProblems} viewRef={views.scenes} onChange={(scenes) => setDraft((d) => ({ ...d, scenes }))} onSave={() => save()} />
        </section>
      </div>

      {problems.length > 0 && (
        <section className="block">
          <h4>Problems</h4>
          <ul className="problems">
            {problems.map((p, i) => (
              <li key={i} className={p.severity}>
                <button
                  className="link"
                  disabled={!p.line}
                  onClick={() => {
                    const k = p.file === 'script.txt' ? 'script' : 'scenes';
                    setPane(k);
                    goToLine(views[k].current, p.line);
                  }}
                >
                  {p.file ? `${p.file}${p.line ? `:${p.line}` : ''}` : p.where}
                </button>
                <span>{p.message.replace(/^line \d+: /, '')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="hint">⌘S saves and checks in a moment. Check also speaks changed blocks and runs every scene, then refreshes the storyboard. Render does both, then builds v{next}: only the blocks and scenes you changed are done again.</p>
    </div>
  );
}

const fromSource = (s) => ({ script: s.script || '', scenes: s.scenes || '', voice: s.voice, speed: s.speed, hash: s.hash });

/** Whether the page holds edits the server does not. */
function dirtyOf(d, s) {
  return d.script !== (s.script || '') || d.scenes !== (s.scenes || '') || d.voice !== s.voice || Number(d.speed) !== Number(s.speed);
}
