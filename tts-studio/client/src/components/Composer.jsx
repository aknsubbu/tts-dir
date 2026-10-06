import { useMemo, useRef, useState } from 'react';
import { countWords, estimateSeconds, fmtDuration, fmtNumber } from '../utils.js';

function Slider({ label, hint, value, min, max, step, onChange, format = (v) => v.toFixed(2) }) {
  return (
    <label className="field slider">
      <span className="field-row">
        <span>{label}</span>
        <output>{format(value)}</output>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function DropZone({ dragging, onFiles, autoGenerate }) {
  const input = useRef(null);
  return (
    <div
      className={`dropzone ${dragging ? 'over' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.current?.click();
        }
      }}
    >
      <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
        <path d="M24 32V10M16 18l8-8 8 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 30v6a4 4 0 004 4h24a4 4 0 004-4v-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <strong>Drop a script here</strong>
      <span>or click to choose .txt / .md files</span>
      <span className="hint">{autoGenerate ? 'Audio starts generating as soon as you drop.' : 'Files are added to the batch below.'}</span>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".txt,.md,.markdown,.text,text/plain,text/markdown"
        onChange={(e) => {
          onFiles([...e.target.files]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function PasteBox({ onPaste, autoGenerate }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const submit = (now) => {
    if (!text.trim()) return;
    onPaste({ title, text, now });
    setTitle('');
    setText('');
  };
  return (
    <div className="paste">
      <input className="input" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        className="input"
        rows={6}
        placeholder="…or paste your script here"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <span className="hint grow">
          {text.trim() ? `${fmtNumber(text.length)} characters · about ${fmtDuration(estimateSeconds(countWords(text)))}` : ''}
        </span>
        <button className="btn" disabled={!text.trim()} onClick={() => submit(false)}>
          Add to batch
        </button>
        <button className="btn primary" disabled={!text.trim()} onClick={() => submit(true)}>
          Generate now
        </button>
      </div>
      {!autoGenerate && <span className="hint">Tip: “Generate now” skips the batch.</span>}
    </div>
  );
}

function Drafts({ drafts, setDrafts }) {
  if (!drafts.length) return null;
  const update = (key, patch) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  return (
    <ul className="drafts">
      {drafts.map((d) => {
        const words = countWords(d.text);
        return (
          <li key={d.key} className="draft">
            <div className="row">
              <input
                className="input title-input grow"
                value={d.title}
                aria-label="Title"
                onChange={(e) => update(d.key, { title: e.target.value })}
              />
              <button className="icon-btn" aria-label={`Remove ${d.title}`} onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}>
                ×
              </button>
            </div>
            <div className="hint">
              {d.name ? `${d.name} · ` : ''}
              {fmtNumber(d.text.length)} chars · {fmtNumber(words)} words · about {fmtDuration(estimateSeconds(words))}
            </div>
            <div className="draft-preview">{d.text.slice(0, 140).replace(/\s+/g, ' ')}{d.text.length > 140 ? '…' : ''}</div>
          </li>
        );
      })}
    </ul>
  );
}

export default function Composer({
  health, voices, languages, voicesError, settings, setSettings, defaults,
  autoGenerate, setAutoGenerate, drafts, setDrafts, dragging, onFiles, onPaste, onGenerate, lead, children,
}) {
  const [tab, setTab] = useState('files');
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const preview = useRef(null);
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const engineReady = health?.engine?.status === 'ready';
  const totalChars = drafts.reduce((n, d) => n + d.text.length, 0);
  const totalWords = drafts.reduce((n, d) => n + countWords(d.text), 0);

  // One <optgroup> per language, in the engine's order.
  const grouped = useMemo(
    () =>
      languages
        .map((l) => ({ ...l, voices: voices.filter((v) => v.lang === l.code) }))
        .filter((l) => l.voices.length),
    [voices, languages],
  );

  const selectedVoice = voices.find((v) => v.voiceId === settings.voiceId);
  const selectedLanguage = languages.find((l) => l.code === selectedVoice?.lang);

  // Samples are rendered locally the first time a voice is previewed, then cached.
  const playPreview = () => {
    if (!selectedVoice) return;
    if (!preview.current) {
      preview.current = new Audio();
      const done = () => setPreviewing(false);
      for (const ev of ['playing', 'error', 'pause', 'ended']) preview.current.addEventListener(ev, done);
    }
    preview.current.pause();
    preview.current.src = `/api/voices/${selectedVoice.voiceId}/preview`;
    setPreviewing(true);
    preview.current.play().catch(() => setPreviewing(false));
  };

  const voiceLabel = (v) => (v.gender ? `${v.name} (${v.gender})` : v.name);

  return (
    <aside className="composer">
      {lead}
      <section className="panel">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            Drop files
          </button>
          <button role="tab" aria-selected={tab === 'paste'} className={tab === 'paste' ? 'on' : ''} onClick={() => setTab('paste')}>
            Paste text
          </button>
        </div>

        {tab === 'files' ? (
          <DropZone dragging={dragging} onFiles={onFiles} autoGenerate={autoGenerate} />
        ) : (
          <PasteBox onPaste={onPaste} autoGenerate={autoGenerate} />
        )}

        <label className="check">
          <input type="checkbox" checked={autoGenerate} onChange={(e) => setAutoGenerate(e.target.checked)} />
          <span>
            Generate immediately on drop
            <span className="hint"> Turn off to review titles and lengths first.</span>
          </span>
        </label>

        <Drafts drafts={drafts} setDrafts={setDrafts} />

        {drafts.length > 0 && (
          <div className="generate-bar">
            <div className="hint">
              {drafts.length} script{drafts.length > 1 ? 's' : ''} · {fmtNumber(totalChars)} chars · about{' '}
              {fmtDuration(estimateSeconds(totalWords))} of audio
            </div>
            <div className="row">
              <button className="btn" onClick={() => setDrafts([])}>Clear</button>
              <button
                className="btn primary grow"
                disabled={busy || health?.engine?.status === 'error'}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onGenerate();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Queuing…' : `Generate ${drafts.length} audio file${drafts.length > 1 ? 's' : ''}`}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <details open>
          <summary>Voice</summary>

          <div className="field">
            <span className="field-row">
              <span>Voice</span>
              {selectedVoice && selectedLanguage?.available && (
                <button className="link" onClick={playPreview} disabled={previewing}>
                  {previewing ? 'Loading…' : '▶ Preview'}
                </button>
              )}
            </span>
            {voices.length > 0 ? (
              <select className="input" value={settings.voiceId} onChange={(e) => set({ voiceId: e.target.value })}>
                {grouped.map((l) => (
                  <optgroup key={l.code} label={l.available ? l.name : `${l.name} (not installed)`}>
                    {l.voices.map((v) => (
                      <option key={v.voiceId} value={v.voiceId} disabled={!l.available}>{voiceLabel(v)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <span className="hint">
                {engineReady && voicesError ? `Couldn’t load the voices (${voicesError}).` : 'Voices appear once the model has loaded.'}
              </span>
            )}
            <span className="hint">
              Pick a voice in the language your script is written in. Everything runs on this Mac, with no key and no quota.
            </span>
          </div>

          <Slider label="Speed" value={settings.speed} min={0.5} max={2} step={0.05} onChange={(v) => set({ speed: v })} format={(v) => `${v.toFixed(2)}×`} />

          <label className="check">
            <input type="checkbox" checked={settings.stripMarkdown} onChange={(e) => set({ stripMarkdown: e.target.checked })} />
            <span>Strip markdown before speaking <span className="hint">Removes #, **, links and code blocks.</span></span>
          </label>

          <button className="link" onClick={() => setSettings((s) => ({ ...defaults, voiceId: s.voiceId }))}>
            Reset speed
          </button>
        </details>
      </section>

      {children}
    </aside>
  );
}
