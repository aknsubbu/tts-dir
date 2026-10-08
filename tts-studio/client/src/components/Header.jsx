import { fmtDuration, fmtNumber, fmtUsd } from '../utils.js';

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M7 13v6M11.5 9v14M16 5v22M20.5 10v12M25 14v4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

const ENGINE = {
  ready: { tone: 'ok', label: 'Kokoro ready' },
  starting: { tone: 'wait', label: 'Loading voice model…' },
  stopped: { tone: 'wait', label: 'Loading voice model…' },
  error: { tone: 'bad', label: 'Voice engine offline' },
};

const MODES = [
  ['lessons', 'Lessons', 'Narrated videos from your notes'],
  ['audio', 'Audio', 'Scripts read aloud as MP3s'],
];

export default function Header({ health, stats, mode, setMode, onShowWaiting }) {
  const engine = health?.engine;
  const pill = ENGINE[engine?.status] || ENGINE.error;

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <div>
          <h1>Narrated Proofs</h1>
          <p>{mode === 'audio' ? 'Scripts in, audio out' : 'Notes in, lessons out'}</p>
        </div>
      </div>

      <nav className="modes" role="tablist" aria-label="What to make">
        {MODES.map(([id, label, title]) => (
          <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? 'on' : ''} title={title} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="topbar-right">
        {stats?.awaiting > 0 && mode !== 'audio' && (
          <button className="chip attention" onClick={onShowWaiting} title="Lessons waiting for you to look over their storyboard">
            <b>{stats.awaiting}</b> need{stats.awaiting === 1 ? 's' : ''} you
          </button>
        )}
        {stats && (
          <div className="chips" aria-label="Library totals">
            {mode !== 'audio' && stats.costThisMonthUsd != null && (
              <a className="chip" href="#settings/costs" title="What writing lessons cost this calendar month. Caps and rates are in Settings."><b>{fmtUsd(stats.costThisMonthUsd)}</b> on lessons this month</a>
            )}
            <span className="chip"><b>{fmtNumber(stats.files)}</b> files</span>
            <span className="chip"><b>{fmtDuration(stats.seconds)}</b> of audio</span>
            <span className="chip"><b>{fmtNumber(stats.chars)}</b> characters</span>
          </div>
        )}

        <a className="icon-btn gear" href="#settings" aria-label="Settings" title="Settings: who writes lessons, defaults, costs, connecting Claude">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.4h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)" />
          </svg>
        </a>
        {health && (
          <span
            className={`pill ${pill.tone}`}
            title={engine?.error || (engine?.device ? `Running on this Mac (${engine.device}). Nothing leaves your computer.` : '')}
          >
            <span className="dot" />
            {pill.label}
          </span>
        )}
      </div>
    </header>
  );
}
