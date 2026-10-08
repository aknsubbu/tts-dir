import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

/** The index of the word being spoken at `t`: the last one started at or before it, or -1. */
export function wordAt(words, t) {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid][1] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The narration beside the player, with the word being spoken marked. Click a word to jump
 * there. The times come from the build's word timings, so they match the video exactly.
 */
export default function Transcript({ id, builtVersion, videoRef }) {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(-1);
  const box = useRef(null);

  useEffect(() => {
    let live = true;
    api.transcript(id).then((d) => live && setData(d), () => live && setData(false));
    return () => {
      live = false;
    };
  }, [id, builtVersion]);

  // Every word in order, each knowing its block, for one search per frame.
  const flat = useMemo(() => (data ? data.blocks.flatMap((b, bi) => b.words.map((w, wi) => [w[0], w[1], w[2], bi, wi])) : []), [data]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !flat.length) return undefined;
    let frame = 0;
    const tick = () => {
      setNow(wordAt(flat, video.currentTime));
      if (!video.paused) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    video.addEventListener('play', start);
    video.addEventListener('seeked', tick);
    video.addEventListener('timeupdate', tick);
    tick();
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('play', start);
      video.removeEventListener('seeked', tick);
      video.removeEventListener('timeupdate', tick);
    };
  }, [flat, videoRef]);

  // Keep the spoken word in view, without moving the page itself.
  const current = flat[now];
  useEffect(() => {
    const el = box.current?.querySelector('.word.now');
    if (el && box.current) {
      const top = el.offsetTop - box.current.offsetTop;
      if (top < box.current.scrollTop || top > box.current.scrollTop + box.current.clientHeight - 40) box.current.scrollTop = top - 60;
    }
  }, [current?.[3]]); // eslint-disable-line react-hooks/exhaustive-deps

  if (data === false || !data?.blocks?.length) return null;
  const seek = (t) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = t + 0.01;
    video.play?.().catch(() => {});
  };
  return (
    <section className="block transcript-block">
      <h4>Transcript</h4>
      <div className="transcript" ref={box} aria-label="Transcript: click a word to jump to it">
        {data.blocks.map((b, bi) => (
          <p key={b.id} className={current && current[3] === bi ? 'on' : ''}>
            {b.words.length
              ? b.words.map((w, wi) => (
                  <span key={wi}>
                    <button type="button" className={`word ${current && current[3] === bi && current[4] === wi ? 'now' : ''}`} onClick={() => seek(w[1])}>{w[0]}</button>{' '}
                  </span>
                ))
              : <button type="button" className="word" onClick={() => seek(b.start)}>{b.text}</button>}
          </p>
        ))}
      </div>
    </section>
  );
}
