import { useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtNumber, useLocalStorage } from '../utils.js';

const TEXT_FILE = /\.(txt|md|markdown|text)$/i;
const MAX_NOTES = 60000;
const LENGTHS = [
  [1, 'About 1 minute'],
  [2, 'About 2 minutes'],
  [3, 'About 3 minutes'],
  [5, 'About 5 minutes'],
];
const QUALITIES = [
  ['default', '1080p'],
  ['medium', '720p'],
  ['low', '480p, quickest'],
  ['4k', '4K'],
];

/**
 * Make a video from a topic: Claude writes the narration and the animations from what
 * is typed or dropped here, then it is spoken, rendered and added to the library.
 */
export default function LessonPanel({ voices, defaultVoiceId, engineReady, onQueued, toast }) {
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState([]);
  const [prefs, setPrefs] = useLocalStorage('tts-studio:lesson', { minutes: 2, quality: 'default', voiceId: '' });
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef(null);

  // Animations follow individual words, and only the English voices report word timings.
  const english = useMemo(() => voices.filter((v) => v.lang === 'a' || v.lang === 'b'), [voices]);
  const voiceId = english.find((v) => v.voiceId === prefs.voiceId)?.voiceId
    || english.find((v) => v.voiceId === defaultVoiceId)?.voiceId
    || english[0]?.voiceId
    || '';

  const addFiles = async (list) => {
    const skipped = [];
    const added = [];
    let text = '';
    for (const f of list) {
      if (!TEXT_FILE.test(f.name) && !f.type.startsWith('text/')) {
        skipped.push(f.name);
        continue;
      }
      const body = (await f.text()).trim();
      if (!body) continue;
      text += `\n\n# From ${f.name}\n\n${body}`;
      added.push(f.name);
    }
    if (skipped.length) toast({ kind: 'error', text: `Skipped ${skipped.join(', ')}. Notes can be .txt or .md files.` });
    if (!added.length) return;
    setNotes((n) => `${n.trim()}${text}`.trim());
    setFiles((fs) => [...fs, ...added]);
  };

  // Files dropped here are notes for the lesson. The page-wide drop handler in App sees the
  // same event, clears its overlay, and leaves these files alone.
  const drop = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    setOver(false);
    addFiles([...e.dataTransfer.files]);
  };

  const tooLong = notes.length > MAX_NOTES;
  const ready = topic.trim() && voiceId && !tooLong && !busy;

  const submit = async () => {
    setBusy(true);
    try {
      await api.createLesson({ topic, goal, notes, minutes: prefs.minutes, quality: prefs.quality, voiceId });
      toast({ kind: 'success', text: `Claude is writing “${topic.trim()}”. Follow it in the library; it takes a few minutes.`, ms: 8000 });
      setTopic('');
      setGoal('');
      setNotes('');
      setFiles([]);
      await onQueued();
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 10000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`panel lesson ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <div>
        <h3 className="panel-title">Explain it to me</h3>
        <p className="hint">Name a topic and drop in your notes. Claude writes the script and the animations, and you get a narrated video.</p>
      </div>
      <label className="field">
        <span>Topic</span>
        <input className="input" value={topic} maxLength={200} placeholder="Binary search" onChange={(e) => setTopic(e.target.value)} />
      </label>
      <label className="field">
        <span>What do you want to understand?</span>
        <textarea
          className="input short"
          value={goal}
          maxLength={2000}
          placeholder="Why it is so much faster than checking every item"
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-row">
          Your notes
          <output className={tooLong ? 'over-limit' : ''}>{notes ? `${fmtNumber(notes.length)} / ${fmtNumber(MAX_NOTES)}` : 'optional'}</output>
        </span>
        <textarea
          className="input"
          value={notes}
          placeholder="Paste notes here, or drop .txt and .md files on this panel"
          onChange={(e) => setNotes(e.target.value)}
        />
        <span className="hint">
          {files.length ? `Added ${files.join(', ')}. ` : ''}
          <button type="button" className="link" onClick={() => picker.current?.click()}>Choose files</button>
          <input
            ref={picker}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
        </span>
      </label>
      <div className="row wrap">
        <label className="field grow">
          <span>Length</span>
          <select className="input" value={prefs.minutes} onChange={(e) => setPrefs((p) => ({ ...p, minutes: Number(e.target.value) }))}>
            {LENGTHS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span>Quality</span>
          <select className="input" value={prefs.quality} onChange={(e) => setPrefs((p) => ({ ...p, quality: e.target.value }))}>
            {QUALITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Voice</span>
        <select className="input" value={voiceId} disabled={!english.length} onChange={(e) => setPrefs((p) => ({ ...p, voiceId: e.target.value }))}>
          {english.length === 0 && <option value="">{engineReady ? 'No English voices found' : 'Loading voices…'}</option>}
          {english.map((v) => (
            <option key={v.voiceId} value={v.voiceId}>{v.name}{v.gender ? ` (${v.gender})` : ''} · {v.lang === 'b' ? 'British' : 'American'}</option>
          ))}
        </select>
      </label>
      <button className="btn primary" disabled={!ready} onClick={submit}>
        {busy ? 'Starting…' : 'Make the video'}
      </button>
      {tooLong && <p className="hint over-limit">The notes are too long. Trim them to {fmtNumber(MAX_NOTES)} characters.</p>}
    </section>
  );
}
