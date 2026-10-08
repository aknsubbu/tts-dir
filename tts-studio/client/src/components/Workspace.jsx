import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtBytes, fmtDate, fmtDuration, fmtNumber, fmtUsd, isActive, needsYou, routeHash, WORKSPACE_TABS } from '../utils.js';
import { Progress, StatusBadge } from './Library.jsx';
import { NoteFiles, VideoPlayer } from './Drawer.jsx';
import Storyboard from './Storyboard.jsx';
import EditTab from './EditTab.jsx';
import History from './History.jsx';
import Transcript from './Transcript.jsx';

const TAB_LABELS = { watch: 'Watch', storyboard: 'Storyboard', edit: 'Edit', history: 'History', notes: 'Notes' };
export const QUALITIES = [
  ['default', '1080p'],
  ['medium', '720p'],
  ['low', '480p, quickest'],
  ['4k', '4K'],
  ['hd', '1080p (hd)'],
];

const SOURCE = { written: 'Written', edited: 'Edited', revised: 'Revised', restored: 'Restored' };

const STEP_WORDS = { read: 'read the notes', write: 'wrote', fix: 'fixed', polish: 'polished' };

/** "Claude Code (claude-opus-5-5) wrote; This Mac: Ollama (qwen3-coder) fixed". */
export function whoWrote(writtenBy) {
  if (!writtenBy?.length) return null;
  const by = new Map();
  for (const w of writtenBy) {
    const name = `${w.label || w.provider}${w.model ? ` (${w.model})` : ''}`;
    if (!by.has(name)) by.set(name, []);
    if (!by.get(name).includes(STEP_WORDS[w.step] || w.step)) by.get(name).push(STEP_WORDS[w.step] || w.step);
  }
  return [...by.entries()].map(([name, steps]) => `${name} ${steps.join(', ')}`).join('; ');
}

/** What writing the lesson took: who wrote it, the cost and tokens, and the rounds of fixing. */
function Effort({ lesson }) {
  if (!lesson) return null;
  const u = lesson.usage;
  const who = whoWrote(lesson.writtenBy);
  return (
    <section className="block">
      <h4>What it took</h4>
      <dl className="details">
        {who && <><dt>Written by</dt><dd>{who}</dd></>}
        <dt>Cost</dt>
        <dd>
          {fmtUsd(lesson.costUsd)}
          {u ? ` · ${fmtNumber(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} tokens read (${fmtNumber(u.cacheReadTokens)} from the cache) · ${fmtNumber(u.outputTokens)} written` : ''}
        </dd>
        <dt>Rounds</dt>
        <dd>
          {lesson.fixes ? `${lesson.fixes} fix${lesson.fixes === 1 ? '' : 'es'} by the writer` : 'no fixes needed'}
          {lesson.autofixed ? ` · ${lesson.autofixed} common mistake${lesson.autofixed === 1 ? '' : 's'} fixed automatically` : ''}
          {lesson.polished ? ' · polished' : ''}
          {lesson.warnings ? ` · ${lesson.warnings} layout or timing note${lesson.warnings === 1 ? '' : 's'} left` : ''}
        </dd>
      </dl>
    </section>
  );
}

/**
 * A lesson, full width: watch it, look over its storyboard, read what it was made from.
 * Opened at #lesson/<id>/<tab>, so a link can open a lesson at the right place.
 */
export default function Workspace({ id, tab, autoplay, summary, voices = [], onClose, onPatch, onDelete, onCancel, onRetry, onApprove, toast }) {
  const videoRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [versions, setVersions] = useState(null);
  const [quality, setQuality] = useState('');

  // The full record (with its script) on opening, and again when its status or version moves.
  useEffect(() => {
    let live = true;
    api
      .get(id)
      .then((d) => live && (setDetail(d), setLoadError('')))
      .catch((e) => live && setLoadError(e.message));
    api.versions(id).then((v) => live && setVersions(v)).catch(() => {});
    return () => {
      live = false;
    };
  }, [id, summary?.status, summary?.version, summary?.builtVersion]);

  // Opened from a link, a lesson may not be in the library's current page, which is what brings
  // live changes here; follow it directly while something is happening to it.
  useEffect(() => {
    if (summary || !detail || !(isActive(detail) || needsYou(detail))) return undefined;
    const t = setInterval(() => api.get(id).then(setDetail).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [id, summary, detail]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const g = useMemo(() => (detail ? { ...detail, ...(summary || {}), text: detail.text } : null), [detail, summary]);
  useEffect(() => {
    if (g) setTitle(g.title);
  }, [g?.id, g?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (g?.settings?.quality) setQuality((q) => q || g.settings.quality);
  }, [g?.settings?.quality]);

  const s = g?.settings;
  const lesson = s?.lesson;
  const current = versions?.versions?.find((v) => v.n === versions.current);

  const commitTitle = async () => {
    const t = title.trim();
    if (!t) return setTitle(g.title);
    if (t === g.title) return;
    try {
      const updated = await onPatch(id, { title: t });
      setDetail((d) => ({ ...d, ...updated }));
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
  };

  const tabLink = (t) => routeHash(id, t);

  return (
    <div className="workspace" role="dialog" aria-modal="true" aria-label="Lesson">
      {!g ? (
        <div className="ws-loading">
          <button className="link" onClick={onClose}>← Library</button>
          <p className="hint">{loadError || 'Loading…'}</p>
        </div>
      ) : (
        <>
          <div className="ws-top">
          <header className="ws-head">
            <div className="ws-row">
            <button className="link ws-back" onClick={onClose}>← Library</button>
            <input
              className="input title-input ws-title"
              value={title}
              aria-label="Title"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setTitle(g.title);
                  e.currentTarget.blur();
                }
              }}
            />
            </div>
            <div className="ws-row">
            {g.version > 0 && (
              <span className="chip" title={current ? `Made ${fmtDate(current.createdAt)}` : ''}>
                v{g.version}
                {current ? ` · ${SOURCE[current.source] || current.source}` : ''}
                {g.builtVersion && g.builtVersion !== g.version ? ` · playing v${g.builtVersion}` : ''}
              </span>
            )}
            <StatusBadge g={g} />
            <span className="grow" />
            {needsYou(g) && (
              <div className="row approve">
                <select className="input" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
                  {QUALITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <button className="btn primary" onClick={() => onApprove(g, { quality })}>Approve and render</button>
              </div>
            )}
            {(isActive(g) || needsYou(g)) && <button className="btn" onClick={() => onCancel(g)}>{needsYou(g) ? 'Don’t render' : 'Cancel'}</button>}
            {(g.status === 'error' || g.status === 'cancelled') && <button className="btn primary" onClick={() => onRetry(g)}>Retry</button>}
            <details className="menu">
              <summary className="btn">Download</summary>
              <div className="menu-list">
                {g.videoUrl && <a href={`${g.videoUrl}?download=1`} download>Video (MP4)</a>}
                {g.videoUrl && <a href={`/api/generations/${g.id}/captions.srt?download=1`} download>Captions (SRT)</a>}
                {g.videoUrl && <a href={`/api/generations/${g.id}/captions.vtt?download=1`} download>Captions (VTT)</a>}
                <a href={`/api/generations/${g.id}/script?download=1`} download>Narration (text)</a>
              </div>
            </details>
            <button className="btn danger" onClick={() => onDelete(g)}>Delete</button>
            </div>
          </header>

          <nav className="ws-tabs" role="tablist" aria-label="Lesson views">
            {WORKSPACE_TABS.map((t) => (
              <a key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} href={tabLink(t)}>
                {TAB_LABELS[t]}
                {t === 'storyboard' && needsYou(g) && <span className="dot-note" aria-label="waiting for you" />}
              </a>
            ))}
          </nav>
          </div>

          <div className="ws-body">
            {tab === 'watch' && (
              <div className="ws-watch">
                {g.videoUrl ? (
                  <div className="watch-row">
                    <VideoPlayer g={g} autoplay={autoplay} videoRef={videoRef} />
                    <Transcript id={g.id} builtVersion={g.builtVersion} videoRef={videoRef} />
                  </div>
                ) : (
                  <div className={`status-box ${g.status}`}>
                    <p>{needsYou(g) ? 'Nothing is rendered yet. Look over the storyboard, then approve it to render.' : 'The video appears here once it is built.'}</p>
                    {needsYou(g) && <a className="btn primary" href={tabLink('storyboard')}>Open the storyboard</a>}
                  </div>
                )}
                {(isActive(g) || g.error) && (
                  <div className={`status-box ${g.status}`}>
                    <div className="row">
                      <StatusBadge g={g} />
                      {g.videoUrl && isActive(g) && <span className="hint">Playing v{g.builtVersion} until the new one is built.</span>}
                    </div>
                    {isActive(g) && <Progress g={g} />}
                    {g.error && g.status !== 'done' && <p className="card-error">{g.error}</p>}
                  </div>
                )}
                <Effort lesson={lesson} />
                <section className="block">
                  <h4>Details</h4>
                  <dl className="details">
                    <dt>Voice</dt><dd>{g.voiceName || g.voiceId}</dd>
                    <dt>Narration</dt><dd>{fmtNumber(g.wordCount)} words</dd>
                    {g.videoUrl && <><dt>Video</dt><dd>{fmtDuration(g.durationSec)} · {fmtBytes(g.audioBytes)} · {s?.quality} quality</dd></>}
                    {s && <><dt>Files</dt><dd><code>video/projects/{s.project}/</code></dd></>}
                    <dt>Created</dt><dd>{fmtDate(g.createdAt)}</dd>
                  </dl>
                </section>
              </div>
            )}
            {tab === 'storyboard' && <Storyboard id={g.id} refreshKey={`${g.version}-${g.status}`} />}
            {tab === 'edit' && <EditTab g={g} voices={voices} toast={toast} />}
            {tab === 'history' && <History g={g} toast={toast} />}
            {tab === 'notes' && (
              <div className="ws-notes">
                {lesson && (
                  <section className="block">
                    <h4>What you asked for</h4>
                    <dl className="details">
                      <dt>Topic</dt><dd>{lesson.topic}</dd>
                      {lesson.goal && <><dt>To understand</dt><dd>{lesson.goal}</dd></>}
                      <dt>Length</dt><dd>about {lesson.minutes} minute{lesson.minutes === 1 ? '' : 's'}</dd>
                    </dl>
                  </section>
                )}
                <NoteFiles id={g.id} attachments={lesson?.attachments} />
                <section className="block grow-block">
                  <h4>Narration</h4>
                  <pre className="script">{g.text}</pre>
                </section>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
