import { useState } from 'react';
import { fmtDuration, fmtNumber, fmtUsd, isActive, needsYou, parseSnippet, timeAgo } from '../utils.js';

export function Marked({ parts }) {
  return parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
}

export function StatusBadge({ g }) {
  if (g.status === 'done') return null;
  if (needsYou(g)) return <span className="badge awaiting">{g.stage || 'Needs you'}</span>;
  const label =
    g.status === 'queued'
      ? 'Queued'
      : g.status === 'processing'
        ? g.stage // a lesson Claude is still writing says what it is doing
          ? g.stage
          : g.progressTotal > 1
            ? `${g.kind === 'video' ? 'Building' : 'Generating'} ${g.progressDone}/${g.progressTotal}`
            : g.kind === 'video'
              ? 'Building'
              : 'Generating'
        : g.status === 'error'
          ? 'Failed'
          : 'Cancelled';
  return <span className={`badge ${g.status}`}>{label}</span>;
}

/** Six frames in a grid: a lesson whose storyboard is waiting to be looked over. */
function StoryboardIcon() {
  return (
    <svg viewBox="0 0 18 14" width="18" height="14" aria-hidden="true">
      {[0, 6.5, 13].map((x) => [0, 7.5].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="5" height="6.5" rx="1" fill="currentColor" />))}
    </svg>
  );
}

export function Progress({ g }) {
  const pct = g.progressTotal ? (g.progressDone / g.progressTotal) * 100 : 0;
  return (
    <div className="meter slim" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter-fill ${g.status === 'queued' || !g.progressTotal ? 'indeterminate' : ''}`} style={{ width: g.status === 'queued' || !g.progressTotal ? '35%' : `${Math.max(6, pct)}%` }} />
    </div>
  );
}

function Card({ g, selected, onOpen, onFavorite, onDelete, onCancel, onRetry }) {
  const titleParts = parseSnippet(g.titleSnippet);
  const snippetParts = parseSnippet(g.snippet);
  // A lesson keeps playing its last built version while a newer one is written or built.
  const playable = Boolean(g.audioUrl || g.videoUrl);
  const [noPoster, setNoPoster] = useState(false); // videos built before posters existed have none
  const poster = g.posterUrl && !noPoster;
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  return (
    <article
      className={`card ${selected ? 'selected' : ''} ${g.status}`}
      onClick={() => onOpen(g.id, false)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(g.id, false);
        }
      }}
      tabIndex={0}
    >
      <button
        className={`play ${poster ? 'poster' : ''}`}
        disabled={!playable && !needsYou(g)}
        aria-label={playable ? `Play ${g.title}` : needsYou(g) ? `Look over ${g.title}` : 'Not ready yet'}
        title={playable ? 'Play' : needsYou(g) ? 'Look over the storyboard' : 'Not ready yet'}
        onClick={stop(() => onOpen(g.id, playable))}
      >
        {poster && <img src={g.posterUrl} alt="" loading="lazy" onError={() => setNoPoster(true)} />}
        {playable ? <span className="play-icon">▶</span> : isActive(g) ? <span className="spinner" /> : needsYou(g) ? <StoryboardIcon /> : '!'}
      </button>

      <div className="card-body">
        <div className="card-title">
          <h3>{titleParts.length ? <Marked parts={titleParts} /> : g.title}</h3>
          <StatusBadge g={g} />
        </div>

        <p className="card-snippet">{snippetParts.length ? <Marked parts={snippetParts} /> : g.preview}</p>

        {isActive(g) && <Progress g={g} />}
        {g.error && g.status !== 'done' && <p className="card-error">{g.error}</p>}

        <div className="card-meta">
          {g.kind === 'video' && <span className="kind">{g.settings?.lesson ? 'Lesson' : 'Video'}</span>}
          {g.version > 1 && <span>v{g.version}</span>}
          <span>{g.voiceName || g.voiceId}</span>
          <span>{fmtNumber(g.wordCount)} words</span>
          {playable && <span>{fmtDuration(g.durationSec)}</span>}
          {g.settings?.lesson?.costUsd != null && <span title="What Claude cost to write it">{fmtUsd(g.settings.lesson.costUsd)}</span>}
          <span title={new Date(g.createdAt).toLocaleString()}>{timeAgo(g.createdAt)}</span>
        </div>

        {g.tags.length > 0 && (
          <div className="tag-row">
            {g.tags.map((t) => (
              <span key={t} className="tag">#{t}</span>
            ))}
          </div>
        )}
      </div>

      <div className="card-actions">
        <button
          className={`icon-btn star ${g.favorite ? 'on' : ''}`}
          aria-label={g.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={g.favorite}
          title="Favorite"
          onClick={stop(() => onFavorite(g))}
        >
          {g.favorite ? '★' : '☆'}
        </button>
        {playable && (
          <a
            className="icon-btn"
            href={`${g.audioUrl || g.videoUrl}?download=1`}
            download
            title={g.kind === 'video' ? 'Download MP4' : 'Download MP3'}
            aria-label={g.kind === 'video' ? 'Download MP4' : 'Download MP3'}
            onClick={(e) => e.stopPropagation()}
          >
            ⬇
          </a>
        )}
        {isActive(g) && (
          <button className="icon-btn" title="Cancel" aria-label="Cancel" onClick={stop(() => onCancel(g))}>
            ■
          </button>
        )}
        {(g.status === 'error' || g.status === 'cancelled') && (
          <button className="icon-btn" title="Retry" aria-label="Retry" onClick={stop(() => onRetry(g))}>
            ↻
          </button>
        )}
        <button className="icon-btn danger" title="Delete" aria-label="Delete" onClick={stop(() => onDelete(g))}>
          🗑
        </button>
      </div>
    </article>
  );
}

export default function Library({
  mode, list, filters, setFilters, stats, tags, selectedId,
  onOpen, onFavorite, onDelete, onCancel, onRetry, onMore,
}) {
  const set = (patch) => setFilters({ ...filters, ...patch });
  const hasFilters = Boolean(filters.q || filters.status || filters.voiceId || filters.tag || filters.favorite);
  const searching = Boolean(filters.q.trim());
  const voiceOptions = stats?.voices || [];
  const noun = (n) => (mode === 'audio' ? (n === 1 ? 'script' : 'scripts') : n === 1 ? 'video' : 'videos');

  return (
    <main className="library">
      <section className="panel toolbar">
        <div className="search">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            className="input"
            type="search"
            placeholder={mode === 'audio' ? 'Search titles, script text and tags' : 'Search lessons: titles, narration and tags'}
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="Search the library"
          />
        </div>

        <div className="filters">
          <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">All statuses</option>
            {mode !== 'audio' && <option value="awaiting">Needs you</option>}
            <option value="done">Ready</option>
            <option value="processing">Generating</option>
            <option value="queued">Queued</option>
            <option value="error">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select className="input" value={filters.voiceId} onChange={(e) => set({ voiceId: e.target.value })} aria-label="Voice">
            <option value="">All voices</option>
            {voiceOptions.map((v) => (
              <option key={v.voiceId} value={v.voiceId}>{v.name} ({v.n})</option>
            ))}
          </select>

          <select className="input" value={filters.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sort">
            <option value="">{searching ? 'Best match' : 'Newest first'}</option>
            {searching && <option value="new">Newest first</option>}
            <option value="old">Oldest first</option>
            <option value="longest">Longest first</option>
            <option value="title">Title A–Z</option>
          </select>

          <button
            className={`btn ${filters.favorite ? 'primary' : ''}`}
            aria-pressed={filters.favorite}
            onClick={() => set({ favorite: !filters.favorite })}
          >
            ★ Favorites
          </button>
        </div>

        {tags.length > 0 && (
          <div className="tag-row filter-tags">
            {tags.slice(0, 14).map((t) => (
              <button
                key={t.tag}
                className={`tag clickable ${filters.tag === t.tag ? 'on' : ''}`}
                aria-pressed={filters.tag === t.tag}
                onClick={() => set({ tag: filters.tag === t.tag ? '' : t.tag })}
              >
                #{t.tag} <small>{t.n}</small>
              </button>
            ))}
          </div>
        )}

        <div className="result-line">
          <span>
            {list.loaded ? `${fmtNumber(list.total)} ${hasFilters ? 'match' + (list.total === 1 ? '' : 'es') : noun(list.total)}` : 'Loading…'}
          </span>
          {hasFilters && (
            <button className="link" onClick={() => setFilters({ q: '', status: '', voiceId: '', tag: '', favorite: false, sort: '' })}>
              Clear filters
            </button>
          )}
        </div>
      </section>

      {list.error && <div className="banner error">Couldn’t load the library: {list.error}</div>}

      {list.loaded && list.items.length === 0 && !list.error && (
        <section className="panel empty">
          {hasFilters ? (
            <>
              <h2>No matches</h2>
              <p>Nothing in your library fits those filters.</p>
            </>
          ) : (
            <>
              {mode === 'audio' ? (
                <>
                  <h2>No audio yet</h2>
                  <p>Drop a .txt script on the left. It’s saved here with its audio, and you can search every script later.</p>
                </>
              ) : (
                <>
                  <h2>No lessons yet</h2>
                  <p>Name a topic on the left and drop in your notes, photos of handwritten pages or PDFs. The finished video lands here.</p>
                </>
              )}
            </>
          )}
        </section>
      )}

      <div className="cards">
        {list.items.map((g) => (
          <Card
            key={g.id}
            g={g}
            selected={g.id === selectedId}
            onOpen={onOpen}
            onFavorite={onFavorite}
            onDelete={onDelete}
            onCancel={onCancel}
            onRetry={onRetry}
          />
        ))}
      </div>

      {list.items.length < list.total && (
        <button className="btn more" onClick={onMore}>
          Show more ({fmtNumber(list.total - list.items.length)} left)
        </button>
      )}
    </main>
  );
}
