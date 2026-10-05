import { fmtDuration, fmtNumber } from '../utils.js';

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

export default function Header({ health, stats }) {
  const engine = health?.engine;
  const pill = ENGINE[engine?.status] || ENGINE.error;

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <div>
          <h1>TTS Studio</h1>
          <p>Scripts in, audio out</p>
        </div>
      </div>

      <div className="topbar-right">
        {stats && (
          <div className="chips" aria-label="Library totals">
            <span className="chip"><b>{fmtNumber(stats.files)}</b> files</span>
            <span className="chip"><b>{fmtDuration(stats.seconds)}</b> of audio</span>
            <span className="chip"><b>{fmtNumber(stats.chars)}</b> characters</span>
          </div>
        )}

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
