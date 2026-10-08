import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { MAX_CHAPTERS } from '../../../shared/limits.js';

// The colours a symbol can have, as Manim names them, and how they look on its dark background.
export const COLORS = {
  BLUE: '#58C4DD', GREEN: '#83C167', YELLOW: '#F7D96F', RED: '#FC6255', ORANGE: '#FF862F', PURPLE: '#9A72AC',
  TEAL: '#5CD0B3', PINK: '#D147BD', GOLD: '#F0AC5F', MAROON: '#C55F73', GREY: '#888888', WHITE: '#FFFFFF',
};
const MINUTES = [1, 2, 3, 4, 5, 6, 7, 8];

const total = (o) => o.chapters.reduce((t, c) => t + (Number(c.minutes) || 0), 0);
const lines = (list) => (list || []).join('\n');
const unlines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const move = (list, i, by) => {
  const out = [...list];
  const [x] = out.splice(i, 1);
  out.splice(i + by, 0, x);
  return out;
};

/** One chapter of the outline: what it is called, how long it is, and what it covers. */
function ChapterCard({ c, n, count, editable, onChange, onMove, onRemove }) {
  const set = (patch) => onChange({ ...c, ...patch });
  return (
    <li className={`outline-chapter ${c.written ? 'written' : ''}`}>
      <div className="row wrap">
        <span className="chapter-n">{n + 1}</span>
        {editable ? (
          <input className="input grow" aria-label={`Title of chapter ${n + 1}`} value={c.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
        ) : (
          <strong className="grow">{c.title}</strong>
        )}
        {editable ? (
          <select className="input" aria-label={`Length of chapter ${n + 1}`} value={c.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })}>
            {MINUTES.map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        ) : (
          <span className="hint">{c.minutes} min{c.written ? ' · written' : ''}</span>
        )}
        {editable && (
          <span className="row tight">
            <button type="button" className="btn small" disabled={n === 0} aria-label={`Move chapter ${n + 1} up`} onClick={() => onMove(-1)}>↑</button>
            <button type="button" className="btn small" disabled={n === count - 1} aria-label={`Move chapter ${n + 1} down`} onClick={() => onMove(1)}>↓</button>
            <button type="button" className="btn small" disabled={count <= 1} aria-label={`Remove chapter ${n + 1}`} onClick={onRemove}>×</button>
          </span>
        )}
      </div>
      {editable ? (
        <>
          <label className="field">
            <span>By the end, you understand</span>
            <textarea className="input short" rows={2} value={c.goal || ''} maxLength={400} onChange={(e) => set({ goal: e.target.value })} />
          </label>
          <label className="field">
            <span>It covers <span className="hint">(one point per line)</span></span>
            <textarea className="input short" rows={Math.max(2, (c.covers || []).length + 1)} value={lines(c.covers)} onChange={(e) => set({ covers: e.target.value.split('\n') })} onBlur={(e) => set({ covers: unlines(e.target.value) })} />
          </label>
          <details>
            <summary className="hint">How it joins its neighbours</summary>
            <label className="field">
              <span>Starts from</span>
              <input className="input" value={c.starts_from || ''} maxLength={300} onChange={(e) => set({ starts_from: e.target.value })} />
            </label>
            <label className="field">
              <span>Ends with</span>
              <input className="input" value={c.ends_with || ''} maxLength={300} onChange={(e) => set({ ends_with: e.target.value })} />
            </label>
          </details>
        </>
      ) : (
        <>
          {c.goal && <p>{c.goal}</p>}
          {c.covers?.length > 0 && <ul className="covers">{c.covers.map((x) => <li key={x}>{x}</li>)}</ul>}
        </>
      )}
      {c.files?.length > 0 && <p className="hint">Uses {c.files.join(', ')}</p>}
    </li>
  );
}

/**
 * A long lesson's outline: its chapters in order, each with its length and what it covers, and
 * the notation every chapter shares (each symbol keeps its colour from the first chapter to the
 * last). While it waits for you, change any of it, have it redone, or approve it and the
 * chapters are written.
 */
export default function Outline({ g, quality, onApprove, toast }) {
  const [outline, setOutline] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [state, setState] = useState('idle'); // idle | saving | approving | redoing
  const [redo, setRedo] = useState('');

  useEffect(() => {
    let live = true;
    api.outline(g.id).then(
      (o) => live && (setOutline(o), setDraft(o), setError('')),
      (e) => live && setError(e.status === 404 ? 'The outline appears here once it is written.' : e.message),
    );
    return () => {
      live = false;
    };
  }, [g.id, g.status, g.stage]);

  if (!draft) return <p className="hint">{error || 'Loading the outline…'}</p>;
  const editable = !!outline.waiting && g.status === 'awaiting';
  const dirty = JSON.stringify(draft) !== JSON.stringify(outline);
  const setChapter = (i, c) => setDraft((d) => ({ ...d, chapters: d.chapters.map((x, j) => (j === i ? c : x)) }));
  const setSymbol = (i, patch) => setDraft((d) => ({ ...d, notation: d.notation.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  // What the server keeps: covers without blank lines, and new chapters named by their titles.
  const clean = (d) => ({ ...d, chapters: d.chapters.map((c) => ({ ...c, covers: unlines(lines(c.covers)) })) });

  const save = async () => {
    setState('saving');
    try {
      const { outline: saved } = await api.saveOutline(g.id, clean(draft));
      const next = { ...saved, waiting: true };
      setOutline(next);
      setDraft(next);
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
    } finally {
      setState('idle');
    }
  };
  const approve = async () => {
    setState('approving');
    await onApprove(g, { quality, action: 'chapters', ...(dirty ? { outline: clean(draft) } : {}), chapters: draft.chapters.length });
    setState('idle');
  };
  const askRedo = async () => {
    setState('redoing');
    try {
      await api.redoOutline(g.id, redo);
      toast({ kind: 'success', text: 'Writing the outline again. It waits here for you when it is done.' });
      setRedo('');
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
    } finally {
      setState('idle');
    }
  };

  const n = draft.chapters.length;
  return (
    <div className="outline-tab">
      <section className="block">
        {editable ? (
          <>
            <label className="field">
              <span>Lesson title</span>
              <input className="input" value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </label>
            <label className="field">
              <span>The thread through it</span>
              <textarea className="input short" value={draft.through_line || ''} maxLength={300} onChange={(e) => setDraft({ ...draft, through_line: e.target.value })} />
            </label>
          </>
        ) : (
          <>
            <h3>{draft.title}</h3>
            {draft.through_line && <p>{draft.through_line}</p>}
          </>
        )}
        <p className="hint">
          {n} chapter{n === 1 ? '' : 's'} · about {total(draft)} minutes
          {editable ? '. Change anything here, then approve it and each chapter is written on its own, with this notation.' : ''}
        </p>
      </section>

      <section className="block">
        <h4>Notation</h4>
        <p className="hint">Every chapter writes these symbols the same way, in the same colour.</p>
        {draft.notation.length === 0 && <p className="hint">No shared symbols.</p>}
        <ul className="notation">
          {draft.notation.map((s, i) => (
            <li key={i} className="row wrap">
              <span className="swatch" style={{ background: COLORS[s.color.replace(/_[A-E]$/, '')] || '#888' }} aria-hidden="true" />
              {editable ? (
                <>
                  <input className="input mono symbol" aria-label={`Symbol ${i + 1}, in LaTeX`} value={s.tex} maxLength={40} onChange={(e) => setSymbol(i, { tex: e.target.value })} />
                  <input className="input grow" aria-label={`What symbol ${i + 1} means`} value={s.meaning} maxLength={120} onChange={(e) => setSymbol(i, { meaning: e.target.value })} />
                  <select className="input" aria-label={`Colour of symbol ${i + 1}`} value={s.color} onChange={(e) => setSymbol(i, { color: e.target.value })}>
                    {[...new Set([...Object.keys(COLORS), s.color])].map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
                  </select>
                  <button type="button" className="btn small" aria-label={`Remove symbol ${i + 1}`} onClick={() => setDraft({ ...draft, notation: draft.notation.filter((_, j) => j !== i) })}>×</button>
                </>
              ) : (
                <>
                  <code>{s.tex}</code>
                  <span>{s.meaning}</span>
                </>
              )}
            </li>
          ))}
        </ul>
        {editable && draft.notation.length < 16 && (
          <button type="button" className="btn small" onClick={() => setDraft({ ...draft, notation: [...draft.notation, { tex: '', meaning: '', color: Object.keys(COLORS)[draft.notation.length % 8] }] })}>
            ＋ Add a symbol
          </button>
        )}
      </section>

      <section className="block">
        <h4>Chapters</h4>
        <ol className="outline-chapters">
          {draft.chapters.map((c, i) => (
            <ChapterCard
              key={c.id || `new-${i}`}
              c={c}
              n={i}
              count={n}
              editable={editable}
              onChange={(next) => setChapter(i, next)}
              onMove={(by) => setDraft({ ...draft, chapters: move(draft.chapters, i, by) })}
              onRemove={() => setDraft({ ...draft, chapters: draft.chapters.filter((_, j) => j !== i) })}
            />
          ))}
        </ol>
        {editable && n < MAX_CHAPTERS && (
          <button type="button" className="btn small" onClick={() => setDraft({ ...draft, chapters: [...draft.chapters, { id: '', title: '', minutes: 3, goal: '', covers: [], from_notes: '', files: [], starts_from: '', ends_with: '' }] })}>
            ＋ Add a chapter
          </button>
        )}
      </section>

      {editable && (
        <>
          <div className="outline-actions row wrap">
            <span className="hint">{dirty ? 'Changed here, not yet saved.' : 'Saved.'}</span>
            <span className="grow" />
            {dirty && <button type="button" className="btn" onClick={() => setDraft(outline)} disabled={state !== 'idle'}>Undo changes</button>}
            {dirty && <button type="button" className="btn" onClick={save} disabled={state !== 'idle' || draft.chapters.some((c) => !c.title.trim())}>{state === 'saving' ? 'Saving…' : 'Save'}</button>}
            <button type="button" className="btn primary" onClick={approve} disabled={state !== 'idle' || draft.chapters.some((c) => !c.title.trim())}>
              {state === 'approving' ? 'Starting…' : `Write the ${n} chapter${n === 1 ? '' : 's'}`}
            </button>
          </div>
          <section className="block">
            <h4>Or ask for another outline</h4>
            <textarea className="input short" aria-label="What to change in the outline" placeholder="“Fewer chapters, and start from the chain rule”" value={redo} maxLength={2000} onChange={(e) => setRedo(e.target.value)} />
            <div className="row">
              <span className="grow" />
              <button type="button" className="btn" disabled={!redo.trim() || state !== 'idle'} onClick={askRedo}>{state === 'redoing' ? 'Asking…' : 'Write it again'}</button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
