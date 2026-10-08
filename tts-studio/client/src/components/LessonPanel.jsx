import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtBytes, fmtNumber, fmtUsd, useDebounced } from '../utils.js';
// The server enforces these; they are one file so the two cannot disagree.
import { DOC_EXT, IMAGE_EXT, MAX_BYTES, MAX_FILES, MAX_NOTES, TEXT_EXT } from '../../../shared/limits.js';

const PREVIEWABLE = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']; // HEIC and TIFF do not show in a browser
const ACCEPT = [...TEXT_EXT, ...IMAGE_EXT, 'pdf', ...DOC_EXT].map((e) => `.${e}`).join(',');

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

const extOf = (name) => (name.match(/\.([^./\\]+)$/)?.[1] || '').toLowerCase();

function kindOf(file) {
  const e = extOf(file.name);
  if (TEXT_EXT.includes(e) || (!e && file.type.startsWith('text/'))) return 'text';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  if (DOC_EXT.includes(e)) return 'document';
  return null;
}

/** The file's bytes in base64. A data URL avoids building a huge string by hand. */
const base64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`));
    r.readAsDataURL(file);
  });

const ICON = { image: '🖼', pdf: '📄', document: '📝' };

function Attachment({ a, onRemove, onChange }) {
  return (
    <li className={`attachment ${a.kind === 'pdf' ? 'with-options' : ''}`} title={`${a.name} · ${fmtBytes(a.file.size)}`}>
      {a.url ? <img src={a.url} alt="" /> : <span className="attachment-icon" aria-hidden="true">{ICON[a.kind]}</span>}
      <span className="attachment-name">{a.name}</span>
      <button type="button" className="attachment-remove" aria-label={`Remove ${a.name}`} onClick={onRemove}>×</button>
      {a.kind === 'pdf' && (
        <span className="attachment-options">
          <input
            className="input"
            aria-label={`Pages of ${a.name}`}
            placeholder="all pages"
            value={a.pages || ''}
            onChange={(e) => onChange({ pages: e.target.value.replace(/[^\d,\s–-]/g, '') })}
          />
          <label className="check" title="Send only its text: cheaper, and readable by any model, but figures and handwriting are lost">
            <input type="checkbox" checked={!!a.asText} onChange={(e) => onChange({ asText: e.target.checked })} />
            <span>text only</span>
          </label>
        </span>
      )}
    </li>
  );
}

/** "Claude Code" or "Groq · llama-4" for a step of the writer the estimate reports. */
const writerName = (w) => (w ? (w.model && w.provider !== 'claude-code' ? `${w.label} · ${w.model}` : w.label) : '');

/** Who will write this lesson, about what it will cost, and where the notes go; and a choice for this lesson only. */
function WriterLine({ estimate, providers, choice, setChoice }) {
  if (!estimate) return null;
  const w = estimate.writer;
  const names = [...new Set(['read', 'write', 'fix'].map((k) => writerName(w[k])))];
  const cost = estimate.free ? 'free' : estimate.unknown?.length ? `cost unknown for ${estimate.unknown.join(', ')}` : `about ${fmtUsd(estimate.lowUsd)}–${fmtUsd(estimate.highUsd)}`;
  const choices = providers.filter((p) => p.configured).flatMap((p) => {
    const tested = Object.keys(p.test?.caps || {}).filter(Boolean);
    const models = tested.length ? tested : p.kind === 'claude-code' ? [''] : (p.models || []).slice(0, 1);
    return models.map((m) => ({ value: JSON.stringify({ provider: p.id, model: m }), label: m && p.kind !== 'claude-code' ? `${p.label} · ${m}` : p.label }));
  });
  return (
    <div className="writer-line">
      <label className="field">
        <span>Written by</span>
        <select className="input" aria-label="Written by" value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">As in Settings{names.length && !choice ? ` (${names.join(', then ')})` : ''}</option>
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <span className="hint">
        {cost}{estimate.note ? '. ' : ''}{estimate.note}
        {estimate.notesGo?.length ? ` Notes go to ${estimate.notesGo.filter((g) => !g.local).map((g) => g.where).join(' and ') || 'nobody: everything runs on this Mac'}.` : ''}
      </span>
      {estimate.problem && <span className="hint over-limit">{estimate.problem}</span>}
    </div>
  );
}

/**
 * Make a video from a topic: Claude writes the narration and the animations from what
 * is typed, dropped or pasted here, then it is spoken, rendered and added to the library.
 *
 * Text files go into the notes box. Photos, PDFs and documents are sent with the lesson:
 * Claude sees the pictures and PDFs, and the server turns documents into text.
 * `addRef.current` is set to the function that takes dropped files, so files dropped
 * anywhere on the page can come here.
 */
export default function LessonPanel({ voices, defaultVoiceId, engineReady, onQueued, toast, addRef, studio = null }) {
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [notes, setNotes] = useState('');
  const [textFiles, setTextFiles] = useState([]);
  const [attached, setAttached] = useState([]); // [{ key, name, kind, file, url }]
  // The form starts from the defaults in Settings; what is changed here is for this lesson only.
  const defaults = studio?.values?.['lesson.defaults'];
  const [prefs, setPrefs] = useState(() => ({ minutes: 2, quality: 'default', voiceId: '', review: 'render', visualReview: false, ...(defaults || {}) }));
  const touched = useRef(false);
  const change = (fn) => {
    touched.current = true;
    setPrefs(fn);
  };
  useEffect(() => {
    if (defaults && !touched.current) setPrefs((p) => ({ ...p, ...defaults }));
  }, [defaults]);
  const [choice, setChoice] = useState(''); // a writer for this lesson only, as JSON { provider, model }
  const [estimate, setEstimate] = useState(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef(null);
  const pasted = useRef(0);

  // Thumbnails hold object URLs; let them go when the panel does.
  const live = useRef(attached);
  live.current = attached;
  useEffect(() => () => live.current.forEach((a) => a.url && URL.revokeObjectURL(a.url)), []);

  // Animations follow individual words, and only the English voices report word timings.
  const english = useMemo(() => voices.filter((v) => v.lang === 'a' || v.lang === 'b'), [voices]);
  const voiceId = english.find((v) => v.voiceId === prefs.voiceId)?.voiceId
    || english.find((v) => v.voiceId === defaultVoiceId)?.voiceId
    || english[0]?.voiceId
    || '';

  const addFiles = async (list) => {
    const skipped = [];
    const added = [];
    const named = [];
    let text = '';
    let room = MAX_FILES - attached.length;
    for (const f of list) {
      const kind = kindOf(f);
      if (!kind) {
        skipped.push(f.name);
        continue;
      }
      if (kind === 'text') {
        const body = (await f.text()).trim();
        if (!body) continue;
        text += `\n\n# From ${f.name}\n\n${body}`;
        named.push(f.name);
        continue;
      }
      if (room <= 0) {
        skipped.push(`${f.name} (at most ${MAX_FILES} files)`);
        continue;
      }
      room -= 1;
      const url = kind === 'image' && PREVIEWABLE.includes(extOf(f.name)) ? URL.createObjectURL(f) : null;
      added.push({ key: `${Date.now()}-${Math.random()}`, name: f.name, kind, file: f, url });
    }
    if (skipped.length) {
      toast({ kind: 'error', text: `Skipped ${skipped.join(', ')}. Notes can be text, images, PDFs, or Word, RTF and OpenDocument files.`, ms: 9000 });
    }
    if (text) {
      setNotes((n) => `${n.trim()}${text}`.trim());
      setTextFiles((fs) => [...fs, ...named]);
    }
    if (added.length) setAttached((as) => [...as, ...added]);
  };
  if (addRef) addRef.current = addFiles;

  // Screenshots pasted from the clipboard all arrive as "image.png"; Claude sees the name, so number them.
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(
      files.map((f) => {
        if (!f.type.startsWith('image/')) return f;
        pasted.current += 1;
        const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        return new File([f], `screenshot-${pasted.current}.${ext}`, { type: f.type });
      }),
    );
  };

  const remove = (key) =>
    setAttached((as) => {
      const gone = as.find((a) => a.key === key);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return as.filter((a) => a.key !== key);
    });

  const clear = () => {
    attached.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    setTopic('');
    setGoal('');
    setNotes('');
    setTextFiles([]);
    setAttached([]);
    pasted.current = 0;
  };

  const bytes = attached.reduce((n, a) => n + a.file.size, 0);
  const tooLong = notes.length > MAX_NOTES;
  const tooBig = bytes > MAX_BYTES;
  const ready = topic.trim() && voiceId && !tooLong && !tooBig && !busy && !estimate?.problem;

  // What it will cost, worked out again as the notes, files, length or writer change.
  const sizes = useDebounced(`${prefs.minutes}|${notes.length}|${attached.filter((a) => a.kind === 'image').length}|${attached.filter((a) => a.kind === 'pdf' && !a.asText).length}|${choice}`, 400);
  useEffect(() => {
    if (!studio) return undefined;
    let live = true;
    const [minutes, notesChars, images, pdfs, writer] = sizes.split('|');
    api
      .estimate({ minutes: Number(minutes), notesChars: Number(notesChars), images: Number(images), pdfPages: Number(pdfs) * 4, writer: writer ? JSON.parse(writer) : undefined })
      .then((e) => live && setEstimate(e))
      .catch(() => live && setEstimate(null));
    return () => {
      live = false;
    };
  }, [sizes, studio]);

  const submit = async () => {
    setBusy(true);
    try {
      const attachments = await Promise.all(
        attached.map(async (a) => ({ name: a.name, data: await base64(a.file), ...(a.pages?.trim() ? { pages: a.pages.trim() } : {}), ...(a.asText ? { asText: true } : {}) })),
      );
      await api.createLesson({
        topic, goal, notes, minutes: prefs.minutes, quality: prefs.quality, voiceId, attachments,
        review: prefs.review, visualReview: prefs.visualReview,
        ...(choice ? { writer: JSON.parse(choice) } : {}),
      });
      const after = { storyboard: 'It waits for you at its storyboard.', script: 'It waits for you once the narration is written.' }[prefs.review] || 'Follow it in the library; it takes a few minutes.';
      const by = choice ? JSON.parse(choice) : null;
      const who = by ? studio?.providers?.find((p) => p.id === by.provider)?.label || 'The writer' : writerName(estimate?.writer?.write) || 'Claude';
      toast({ kind: 'success', text: `${who} is writing “${topic.trim()}”. ${after}`, ms: 8000 });
      clear();
      await onQueued();
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 10000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel lesson" onPaste={onPaste}>
      <div>
        <h2 className="panel-title">Explain it to me</h2>
        <p className="hint">Name a topic and bring your notes: typed, photographed or as PDFs. The writer (Claude, unless you choose another in <a href="#settings/writer">Settings</a>) writes the script and the animations, and you get a narrated video.</p>
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

      <div className="field">
        <span className="field-row">
          <span>Your notes</span>
          <output className={tooLong ? 'over-limit' : ''}>{notes ? `${fmtNumber(notes.length)} / ${fmtNumber(MAX_NOTES)}` : 'optional'}</output>
        </span>
        <textarea
          className="input"
          value={notes}
          aria-label="Your notes"
          placeholder="Type or paste notes here. Paste a screenshot and it is attached."
          onChange={(e) => setNotes(e.target.value)}
        />
        {textFiles.length > 0 && <span className="hint">Added the text of {textFiles.join(', ')}.</span>}

        <div
          className="note-drop"
          role="button"
          tabIndex={0}
          onClick={() => picker.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              picker.current?.click();
            }
          }}
        >
          <strong>Drop notes anywhere on the page</strong>
          <span>or click to choose: photos of handwritten pages, screenshots, PDFs, Word or text files</span>
          <input
            ref={picker}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              addFiles([...e.target.files]);
              e.target.value = '';
            }}
          />
        </div>

        {attached.length > 0 && (
          <>
            <ul className="attachments">
              {attached.map((a) => (
                <Attachment key={a.key} a={a} onRemove={() => remove(a.key)} onChange={(patch) => setAttached((as) => as.map((x) => (x.key === a.key ? { ...x, ...patch } : x)))} />
              ))}
            </ul>
            <span className={`hint ${tooBig ? 'over-limit' : ''}`}>
              {attached.length} of {MAX_FILES} files · {fmtBytes(bytes)} of {MAX_BYTES / 1048576} MB.
              {' '}The pictures and PDFs are read closely, handwriting and equations included.
            </span>
          </>
        )}
      </div>

      <div className="row wrap">
        <label className="field grow">
          <span>Length</span>
          <select className="input" value={prefs.minutes} onChange={(e) => change((p) => ({ ...p, minutes: Number(e.target.value) }))}>
            {LENGTHS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
        <label className="field grow">
          <span>Quality</span>
          <select className="input" value={prefs.quality} onChange={(e) => change((p) => ({ ...p, quality: e.target.value }))}>
            {QUALITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Voice</span>
        <select className="input" value={voiceId} disabled={!english.length} onChange={(e) => change((p) => ({ ...p, voiceId: e.target.value }))}>
          {english.length === 0 && <option value="">{engineReady ? 'No English voices found' : 'Loading voices…'}</option>}
          {english.map((v) => (
            <option key={v.voiceId} value={v.voiceId}>{v.name}{v.gender ? ` (${v.gender})` : ''} · {v.lang === 'b' ? 'British' : 'American'}</option>
          ))}
        </select>
      </label>
      <fieldset className="field seg-field">
        <legend>Before it renders</legend>
        <div className="seg" role="radiogroup" aria-label="Before it renders">
          {[
            ['render', 'Render right away'],
            ['storyboard', 'Show me the storyboard'],
            ['script', 'Show me the narration first'],
          ].map(([v, label]) => (
            <label key={v} className={prefs.review === v ? 'on' : ''}>
              <input type="radio" name="lesson-review" value={v} checked={prefs.review === v} onChange={() => change((p) => ({ ...p, review: v }))} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={!!prefs.visualReview} onChange={(e) => change((p) => ({ ...p, visualReview: e.target.checked }))} />
        <span>Let the writer look over its own frames <span className="hint">(one more request, a few cents)</span></span>
      </label>
      {studio && <WriterLine estimate={estimate} providers={studio.providers || []} choice={choice} setChoice={setChoice} />}
      <button className="btn primary big" disabled={!ready} onClick={submit}>
        {busy ? (attached.length ? 'Sending your notes…' : 'Starting…') : 'Make the video'}
      </button>
      {tooLong && <p className="hint over-limit">The notes are too long. Trim them to {fmtNumber(MAX_NOTES)} characters, or attach a long document as a PDF.</p>}
      {tooBig && <p className="hint over-limit">The attached files come to more than {MAX_BYTES / 1048576} MB. Remove some, or use smaller photos.</p>}
    </section>
  );
}
