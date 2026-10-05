import { fmtDuration, fmtNumber, isActive, parseSnippet, timeAgo } from '../utils.js';

export function Marked({ parts }) {
  return parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>));
}

export function StatusBadge({ g }) {
  if (g.status === 'done') return null;
  const label =
    g.status === 'queued'
      ? 'Queued'
      : g.status === 'processing'
        ? g.progressTotal > 1
          ? `Generating ${g.progressDone}/${g.progressTotal}`
          : 'Generating'
        : g.status === 'error'
          ? 'Failed'
          : 'Cancelled';
  return <span className={`badge ${g.status}`}>{label}</span>;
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
  const done = g.status === 'done';
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
        className="play"
        disabled={!done}
        aria-label={done ? `Play ${g.title}` : 'Not ready yet'}
        title={done ? 'Play' : 'Not ready yet'}
        onClick={stop(() => onOpen(g.id, true))}
      >
        {done ? '▶' : isActive(g) ? <span className="spinner" /> : '!'}
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
          <span>{g.voiceName || g.voiceId}</span>
          <span>{fmtNumber(g.wordCount)} words</span>
          {done && <span>{fmtDuration(g.durationSec)}</span>}
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
        {done && (
          <a
            className="icon-btn"
            href={`${g.audioUrl}?download=1`}
            download
            title="Download MP3"
            aria-label="Download MP3"
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
  list, filters, setFilters, stats, tags, selectedId,
  onOpen, onFavorite, onDelete, onCancel, onRetry, onMore,
}) {
  const set = (patch) => setFilters({ ...filters, ...patch });
  const hasFilters = Boolean(filters.q || filters.status || filters.voiceId || filters.tag || filters.favorite);
  const searching = Boolean(filters.q.trim());
  const voiceOptions = stats?.voices || [];

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
            placeholder="Search titles, script text and tags"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="Search the library"
          />
        </div>

        <div className="filters">
          <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">All statuses</option>
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
            {list.loaded ? `${fmtNumber(list.total)} ${hasFilters ? 'match' + (list.total === 1 ? '' : 'es') : list.total === 1 ? 'script' : 'scripts'}` : 'Loading…'}
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
              <h2>Your library is empty</h2>
              <p>Drop a .txt script on the left. It’s saved here with its audio, and you can search every script later.</p>
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
