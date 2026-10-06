import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtBytes, fmtDate, fmtDuration, fmtNumber, highlightParts, isActive } from '../utils.js';
import { Marked, Progress, StatusBadge } from './Library.jsx';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

function Player({ src, autoplay }) {
  const audio = useRef(null);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate, src]);

  const skip = (s) => {
    if (audio.current) audio.current.currentTime = Math.max(0, audio.current.currentTime + s);
  };

  return (
    <div className="player">
      <audio
        key={src}
        ref={audio}
        src={src}
        controls
        preload="metadata"
        autoPlay={autoplay}
        onLoadedMetadata={() => {
          if (audio.current) audio.current.playbackRate = rate;
        }}
      />
      <div className="row player-controls">
        <button className="btn small" onClick={() => skip(-15)} aria-label="Back 15 seconds">⟲ 15s</button>
        <button className="btn small" onClick={() => skip(15)} aria-label="Forward 15 seconds">15s ⟳</button>
        <span className="grow" />
        {SPEEDS.map((s) => (
          <button key={s} className={`btn small ${rate === s ? 'primary' : ''}`} aria-pressed={rate === s} onClick={() => setRate(s)}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

function VideoPlayer({ g, autoplay }) {
  return (
    <div className="player">
      <video key={g.videoUrl} src={g.videoUrl} controls preload="metadata" autoPlay={autoplay} playsInline>
        <track kind="captions" src={`/api/generations/${g.id}/captions.vtt`} srcLang="en" label="Captions" default />
      </video>
    </div>
  );
}

export default function Drawer({
  id, autoplay, summary, query, allTags,
  onClose, onPatch, onFavorite, onDelete, onCancel, onRetry, onRegenerate, toast,
}) {
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [tagInput, setTagInput] = useState('');

  // Fetch the full record (with script text) when opened and whenever the status changes.
  useEffect(() => {
    let live = true;
    api
      .get(id)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setLoadError('');
      })
      .catch((e) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [id, summary?.status]);

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

  const parts = useMemo(() => (g?.text ? highlightParts(g.text, query || '') : []), [g?.text, query]);
  const hits = parts.filter((p) => p.hit).length;

  const patch = async (body) => {
    try {
      const updated = await onPatch(id, body);
      setDetail((d) => ({ ...d, ...updated }));
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
  };

  const commitTitle = () => {
    const t = title.trim();
    if (!t) setTitle(g.title);
    else if (t !== g.title) patch({ title: t });
  };

  const addTags = () => {
    const incoming = tagInput.split(',').map((t) => t.trim()).filter(Boolean);
    setTagInput('');
    if (incoming.length) patch({ tags: [...g.tags, ...incoming] });
  };

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(g.text);
      toast({ kind: 'success', text: 'Script copied.', ms: 2000 });
    } catch {
      toast({ kind: 'error', text: 'Couldn’t access the clipboard.' });
    }
  };

  const s = g?.settings;

  return (
    <div className="drawer-wrap">
      <div className="backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Script details">
        {!g ? (
          <div className="drawer-body">
            <button className="icon-btn close" onClick={onClose} aria-label="Close">×</button>
            <p className="hint">{loadError || 'Loading…'}</p>
          </div>
        ) : (
          <div className="drawer-body">
            <div className="row drawer-head">
              <input
                className="input title-input grow"
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
              <button className="icon-btn close" onClick={onClose} aria-label="Close">×</button>
            </div>

            {g.status === 'done' ? (
              g.kind === 'video' ? <VideoPlayer g={g} autoplay={autoplay} /> : <Player src={g.audioUrl} autoplay={autoplay} />
            ) : (
              <div className={`status-box ${g.status}`}>
                <div className="row">
                  <StatusBadge g={g} />
                  <span className="grow" />
                  {isActive(g) && <button className="btn small" onClick={() => onCancel(g)}>Cancel</button>}
                  {(g.status === 'error' || g.status === 'cancelled') && (
                    <button className="btn small primary" onClick={() => onRetry(g)}>Retry</button>
                  )}
                </div>
                {isActive(g) && <Progress g={g} />}
                {g.error && <p className="card-error">{g.error}</p>}
              </div>
            )}

            <div className="actions">
              {g.status === 'done' && g.kind !== 'video' && (
                <a className="btn primary" href={`${g.audioUrl}?download=1`} download>Download MP3</a>
              )}
              {g.status === 'done' && g.kind === 'video' && (
                <>
                  <a className="btn primary" href={`${g.videoUrl}?download=1`} download>Download MP4</a>
                  <a className="btn" href={`/api/generations/${g.id}/captions.srt?download=1`} download>Captions (SRT)</a>
                </>
              )}
              <a className="btn" href={`/api/generations/${g.id}/script?download=1`} download>Download script</a>
              {g.kind !== 'video' && <button
                className="btn"
                title="Run this script again with the voice and settings currently selected on the left"
                onClick={async () => {
                  await onRegenerate(g, g.text);
                  onClose();
                }}
              >
                Regenerate
              </button>}
              <button className={`btn ${g.favorite ? 'primary' : ''}`} aria-pressed={g.favorite} onClick={() => onFavorite(g)}>
                {g.favorite ? '★ Favorited' : '☆ Favorite'}
              </button>
              <button className="btn danger" onClick={() => onDelete(g)}>Delete</button>
            </div>

            <section className="block">
              <h4>Tags</h4>
              <div className="tag-row">
                {g.tags.map((t) => (
                  <span key={t} className="tag">
                    #{t}
                    <button aria-label={`Remove tag ${t}`} onClick={() => patch({ tags: g.tags.filter((x) => x !== t) })}>×</button>
                  </span>
                ))}
                <input
                  className="tag-input"
                  list="known-tags"
                  placeholder="Add a tag…"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      addTags();
                    }
                  }}
                  onBlur={addTags}
                />
                <datalist id="known-tags">
                  {allTags.filter((t) => !g.tags.includes(t.tag)).map((t) => (
                    <option key={t.tag} value={t.tag} />
                  ))}
                </datalist>
              </div>
            </section>

            <section className="block">
              <h4>Details</h4>
              <dl className="details">
                <dt>Voice</dt><dd>{g.voiceName || g.voiceId}</dd>
                <dt>Length</dt><dd>{fmtNumber(g.wordCount)} words · {fmtNumber(g.charCount)} characters</dd>
                {g.status === 'done' && (
                  <>
                    <dt>{g.kind === 'video' ? 'Video' : 'Audio'}</dt><dd>{fmtDuration(g.durationSec)} · {fmtBytes(g.audioBytes)}</dd>
                  </>
                )}
                {s && g.kind === 'video' && (
                  <>
                    <dt>Project</dt>
                    <dd>{s.project} · {s.scenes?.join(', ')} · {s.quality} quality</dd>
                  </>
                )}
                {s && g.kind !== 'video' && (
                  <>
                    <dt>Settings</dt>
                    <dd>
                      speed {s.speed}×
                      {s.stripMarkdown ? ' · markdown stripped' : ''}
                    </dd>
                  </>
                )}
                {g.sourceName && (<><dt>Source file</dt><dd>{g.sourceName}</dd></>)}
                <dt>Created</dt><dd>{fmtDate(g.createdAt)}</dd>
                {g.finishedAt && g.status === 'done' && (<><dt>Finished</dt><dd>{fmtDate(g.finishedAt)}</dd></>)}
              </dl>
            </section>

            <section className="block grow-block">
              <div className="row">
                <h4 className="grow">
                  Script
                  {query && hits > 0 && <small className="hint"> · {hits} match{hits === 1 ? '' : 'es'} for “{query}”</small>}
                </h4>
                <button className="link" onClick={copyScript}>Copy</button>
              </div>
              <pre className="script"><Marked parts={parts} /></pre>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
