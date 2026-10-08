import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, stillAt } from '../utils.js';

const MARK = /<mark\s+name\s*=\s*["']([A-Za-z0-9_-]+)["']\s*\/>/g;

/** Narration with each mark shown as a small tag where it falls. */
export function Narration({ text }) {
  const parts = [];
  let last = 0;
  for (const m of String(text || '').matchAll(MARK)) {
    parts.push(text.slice(last, m.index));
    parts.push(<span className="markchip" key={m.index} title={`mark "${m[1]}"`}>{m[1]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(String(text || '').slice(last));
  return <p className="board-text">{parts}</p>;
}

const stillLabel = (s) => (s.mark ? `at “${s.mark}”` : 'end of block');

function BlockCard({ block, current, onPlay, playingHere }) {
  const stills = useMemo(() => [...(block.stills || [])].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity)), [block.stills]);
  const [picked, setPicked] = useState(null);
  const shown = current || stills.find((s) => s.file === picked) || stills.find((s) => s.mark == null) || stills[stills.length - 1];
  return (
    <article className={`board-card ${block.issues?.length ? 'warned' : ''} ${playingHere ? 'playing' : ''}`} aria-label={`Block ${block.id}`}>
      <div className="still">
        {shown ? <img src={shown.url} alt={`${block.scene}, block ${block.id}, ${stillLabel(shown)}`} loading="lazy" /> : <span className="still-empty">No picture</span>}
        {shown && <span className="still-tag">{stillLabel(shown)}</span>}
      </div>
      <div className="board-meta">
        <b>[{block.id}]</b>
        <span>{block.scene}</span>
        <span>{block.duration != null ? `${block.duration.toFixed(1)} s` : '—'}</span>
        {block.issues?.length > 0 && <span className="badge awaiting" title={block.issues.map((i) => i.message).join('\n')}>{block.issues.length}</span>}
      </div>
      <Narration text={block.text} />
      {block.issues?.map((i) => <p key={i.message} className="board-issue">{i.message}</p>)}
      <div className="strip">
        {stills.map((s) => (
          <button
            key={s.file}
            type="button"
            className={`thumb ${shown?.file === s.file ? 'on' : ''}`}
            aria-label={`Show the still ${stillLabel(s)}`}
            aria-pressed={shown?.file === s.file}
            onClick={() => setPicked(s.file)}
          >
            <img src={s.url} alt="" loading="lazy" />
          </button>
        ))}
        <span className="grow" />
        {block.audioUrl && (
          <button type="button" className="btn small" onClick={onPlay} aria-label={`Play the narration of block ${block.id}`}>
            {playingHere ? '■' : '▶'} {block.duration != null ? `${block.duration.toFixed(1)} s` : ''}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * A lesson's storyboard: per scene, each narration block with the stills the check took at
 * its marks and at its end, its narration and its problems. Played as an animatic, the
 * narration runs block after block and the picture changes on the marked words.
 */
export default function Storyboard({ id, version, refreshKey }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState('');
  const audio = useRef(null);
  const [anim, setAnim] = useState({ playing: false, index: 0, t: 0, single: false });

  useEffect(() => {
    let live = true;
    setError('');
    api
      .storyboard(id, version || undefined)
      .then((b) => live && setBoard(b))
      .catch((e) => live && (setBoard(null), setError(e.message)));
    return () => {
      live = false;
    };
  }, [id, version, refreshKey]);

  const blocks = useMemo(
    () => (board?.scenes || []).flatMap((scene) => (scene.blocks || []).map((b) => ({ ...b, scene: scene.name }))),
    [board],
  );
  const total = blocks.reduce((n, b) => n + (b.duration || 0), 0);
  const elapsed = blocks.slice(0, anim.index).reduce((n, b) => n + (b.duration || 0), 0) + anim.t;
  const stillCount = blocks.reduce((n, b) => n + (b.stills?.length || 0), 0);
  const warnings = blocks.reduce((n, b) => n + (b.issues?.length || 0), 0) + (board?.scenes || []).reduce((n, s) => n + (s.issues?.length || 0), 0);
  const canPlay = blocks.some((b) => b.audioUrl);
  const stage = blocks.length ? stillAt(blocks, anim.index, anim.playing || anim.t ? anim.t : Infinity) : null;

  // While playing, follow the audio clock closely enough that pictures change on the word.
  useEffect(() => {
    if (!anim.playing) return undefined;
    let frame;
    const tick = () => {
      if (audio.current) setAnim((a) => (a.playing ? { ...a, t: audio.current.currentTime } : a));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [anim.playing]);

  const playFrom = (index, single = false) => {
    const el = audio.current;
    const block = blocks[index];
    if (!el || !block?.audioUrl) return setAnim((a) => ({ ...a, playing: false }));
    el.src = block.audioUrl;
    setAnim({ playing: true, index, t: 0, single });
    el.play().catch(() => setAnim((a) => ({ ...a, playing: false })));
  };
  const stop = () => {
    audio.current?.pause();
    setAnim((a) => ({ ...a, playing: false }));
  };
  const onEnded = () => {
    const next = blocks.findIndex((b, i) => i > anim.index && b.audioUrl);
    if (anim.single || next === -1) return setAnim((a) => ({ ...a, playing: false, t: blocks[a.index]?.duration ?? a.t }));
    playFrom(next);
  };

  if (error) return <p className="hint board-empty">{error}</p>;
  if (!board) return <p className="hint board-empty">Loading the storyboard…</p>;

  const current = blocks[anim.index];
  return (
    <div className="storyboard">
      <audio ref={audio} onEnded={onEnded} preload="none" hidden />
      <section className="animatic" aria-label="Animatic">
        <div className="still big">
          {stage ? <img src={stage.url} alt={`${current?.scene}, ${stillLabel(stage)}`} /> : <span className="still-empty">The scene starts empty</span>}
        </div>
        <div className="animatic-side">
          <div className="row">
            <button type="button" className="btn primary small" disabled={!canPlay} onClick={() => (anim.playing ? stop() : playFrom(anim.playing || anim.t ? anim.index : blocks.findIndex((b) => b.audioUrl)))}>
              {anim.playing ? '❚❚ Pause' : '▶ Play as animatic'}
            </button>
            <span className="hint tabular">{fmtDuration(elapsed)} / {fmtDuration(total)}</span>
          </div>
          <div className="meter slim" role="progressbar" aria-valuenow={Math.round((elapsed / (total || 1)) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="meter-fill" style={{ width: `${Math.min(100, (elapsed / (total || 1)) * 100)}%` }} />
          </div>
          {current && (
            <>
              <p className="hint">[{current.id}] · {current.scene}</p>
              <Narration text={current.text} />
            </>
          )}
          <p className="hint">
            {blocks.length} block{blocks.length === 1 ? '' : 's'} · {board.scenes.length} scene{board.scenes.length === 1 ? '' : 's'} · {stillCount} stills
            {warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}
          </p>
          {!canPlay && <p className="hint">The narration is kept for the current version only, so this storyboard plays silently.</p>}
          <p className="hint">Stills come from the check, which skips animations: each shows where things end up, not how they move.</p>
        </div>
      </section>

      {board.unplayed?.length > 0 && (
        <p className="warn">No scene plays {board.unplayed.map((b) => `[${b}]`).join(', ')}.</p>
      )}

      {board.scenes.map((scene) => (
        <section key={scene.name} className="board-scene" aria-label={`Scene ${scene.name}`}>
          <h4>
            {scene.name}
            <small className="hint"> · {scene.blocks.length} block{scene.blocks.length === 1 ? '' : 's'}</small>
          </h4>
          {scene.error && <pre className="board-error">{scene.error}</pre>}
          {scene.issues?.map((i) => <p key={i.message} className="board-issue">{i.message}</p>)}
          <div className="board-grid">
            {scene.blocks.map((b) => {
              const index = blocks.findIndex((x) => x.id === b.id && x.scene === scene.name);
              const here = anim.playing && anim.index === index;
              return (
                <BlockCard
                  key={b.id}
                  block={blocks[index]}
                  current={here ? stillAt(blocks, index, anim.t) : null}
                  playingHere={here}
                  onPlay={() => (here ? stop() : playFrom(index, true))}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
