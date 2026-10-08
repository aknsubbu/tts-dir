import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, parseScript, sceneNames } from '../utils.js';
import { IMAGE_EXT, MAX_FILES } from '../../../shared/limits.js';

const ACCEPT = [...IMAGE_EXT, 'pdf', 'docx', 'doc', 'rtf', 'odt'].map((e) => `.${e}`).join(',');

const base64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`));
    r.readAsDataURL(file);
  });

/** "Scene Chain", "Block [link2]", "Paused at 0:41" or "Whole lesson" ("Whole chapter" in a lesson in chapters). */
export function scopeLabel(scope, chaptered = false) {
  if (!scope || scope.kind === 'lesson') return chaptered ? 'Whole chapter' : 'Whole lesson';
  if (scope.kind === 'scene') return `Scene: ${scope.name}`;
  if (scope.kind === 'block') return `Block: [${scope.id}]`;
  return `Paused at ${fmtDuration(scope.at)}`;
}

/**
 * Ask for a change, on every tab of a written lesson: "slow down the second scene". Narrow it to
 * a scene, a block, or the moment the video is paused at; attach notes, such as a photo of the
 * notation to use; and choose whether the new version waits at its storyboard before rendering.
 */
export default function RevisionBar({ g, chapters = [], chapter = null, scope, setScope, videoRef, toast, inputRef }) {
  const [request, setRequest] = useState('');
  const [files, setFiles] = useState([]);
  const [review, setReview] = useState(g.settings?.lesson?.review === 'storyboard');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(null);
  const picker = useRef(null);

  // The moment the video is paused at, offered as a scope while it stays paused.
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return undefined;
    const onPause = () => setPaused(video.currentTime > 0.5 && !video.ended ? video.currentTime : null);
    const onPlay = () => setPaused(null);
    video.addEventListener('pause', onPause);
    video.addEventListener('play', onPlay);
    return () => {
      video.removeEventListener('pause', onPause);
      video.removeEventListener('play', onPlay);
    };
  });

  // A lesson in chapters is changed a chapter at a time: the one shown, or the one a block is in.
  const chaptered = chapters.length > 0;
  const [where, setWhere] = useState(chapter);
  useEffect(() => setWhere(scope.chapter || chapter), [chapter, scope.chapter]);
  const [own, setOwn] = useState(null); // that chapter's script and scenes
  useEffect(() => {
    if (!chaptered || !where) return undefined;
    let live = true;
    api.source(g.id, where).then((s) => live && setOwn(s), () => live && setOwn(null));
    return () => {
      live = false;
    };
  }, [g.id, where, chaptered, g.version]);

  const scenes = useMemo(() => (chaptered ? sceneNames(own?.scenes) : g.settings?.scenes || []), [chaptered, own, g.settings?.scenes]);
  const blocks = useMemo(() => parseScript(chaptered ? own?.script : g.text).map((b) => b.id), [chaptered, own, g.text]);
  const last = g.settings?.lastRevision;
  const titleOf = (id) => chapters.find((c) => c.id === id)?.title || id;

  const send = async () => {
    setBusy(true);
    try {
      const attachments = await Promise.all(files.map(async (f) => ({ name: f.name, data: await base64(f) })));
      // A paused moment names its own chapter; the server finds it from the transcript.
      const bare = { ...scope };
      delete bare.chapter;
      const to = chaptered && scope.kind !== 'time' ? { chapter: where } : {};
      await api.revise(g.id, { request, scope: bare, ...to, attachments, review: review ? 'storyboard' : 'render' });
      const what = [to.chapter ? `in “${titleOf(to.chapter)}”` : '', scope.kind === 'lesson' ? '' : scopeLabel(scope).toLowerCase()].filter(Boolean).join(', ');
      toast({ kind: 'success', text: `Asked for the change${what ? ` (${what})` : ''}. The video keeps playing until v${(g.version || 0) + 1} is ready.`, ms: 7000 });
      setRequest('');
      setFiles([]);
      setScope({ kind: 'lesson' });
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="revision-bar" aria-label="Ask for a change">
      {last && !last.ok && last.error !== 'Cancelled' && (
        <p className="hint over-limit">The last change, “{last.request.slice(0, 80)}”, could not be made: {last.error} The lesson is as it was.</p>
      )}
      <textarea
        ref={inputRef}
        className="input short"
        aria-label="What to change"
        placeholder={'Ask for a change: “slow down the second scene”, “use my notation for the loss”'}
        value={request}
        maxLength={4000}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && request.trim() && !busy) send();
        }}
      />
      <div className="row wrap">
        <div className="chips" role="group" aria-label="Which part">
          {chaptered && scope.kind !== 'time' && (
            <select
              className="input chip-select"
              aria-label="Which chapter"
              value={where || ''}
              onChange={(e) => {
                setWhere(e.target.value);
                setScope({ kind: 'lesson', chapter: e.target.value });
              }}
            >
              {chapters.map((c, n) => <option key={c.id} value={c.id}>Chapter {n + 1}: {c.title}</option>)}
            </select>
          )}
          <button type="button" className={`chip ${scope.kind === 'lesson' ? 'on' : ''}`} onClick={() => setScope({ kind: 'lesson', ...(chaptered ? { chapter: where } : {}) })}>{scopeLabel({ kind: 'lesson' }, chaptered)}</button>
          {scope.kind !== 'lesson' && (
            <span className="chip on">
              {scopeLabel(scope, chaptered)}{' '}
              <button type="button" className="chip-x" aria-label={chaptered ? 'Back to the whole chapter' : 'Back to the whole lesson'} onClick={() => setScope({ kind: 'lesson', ...(chaptered && scope.kind !== 'time' ? { chapter: where } : {}) })}>×</button>
            </span>
          )}
          {paused != null && scope.kind !== 'time' && (
            <button type="button" className="chip" onClick={() => setScope({ kind: 'time', at: Math.round(paused * 10) / 10 })}>Paused at {fmtDuration(paused)}</button>
          )}
          <select className="input chip-select" aria-label="A scene" value="" onChange={(e) => e.target.value && setScope({ kind: 'scene', name: e.target.value, ...(chaptered ? { chapter: where } : {}) })}>
            <option value="">Scene…</option>
            {scenes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input chip-select" aria-label="A block" value="" onChange={(e) => e.target.value && setScope({ kind: 'block', id: e.target.value, ...(chaptered ? { chapter: where } : {}) })}>
            <option value="">Block…</option>
            {blocks.map((b) => <option key={b} value={b}>[{b}]</option>)}
          </select>
        </div>
        <span className="grow" />
        <button type="button" className="btn" onClick={() => picker.current?.click()} disabled={files.length >= MAX_FILES}>＋ Attach notes</button>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept={ACCEPT}
          onChange={(e) => {
            setFiles((f) => [...f, ...e.target.files].slice(0, MAX_FILES));
            e.target.value = '';
          }}
        />
        <label className="check">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />
          <span>Show me the storyboard first</span>
        </label>
        <button type="button" className="btn primary" disabled={!request.trim() || busy} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
      {files.length > 0 && (
        <p className="hint">
          With {files.map((f) => f.name).join(', ')}{' '}
          <button type="button" className="link" onClick={() => setFiles([])}>Remove</button>
        </p>
      )}
    </section>
  );
}
