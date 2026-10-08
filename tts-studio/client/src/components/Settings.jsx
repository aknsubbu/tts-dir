import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtUsd, SETTINGS_SECTIONS, timeAgo } from '../utils.js';
import { EFFORTS, PROVIDER_KINDS, WRITER_STEPS } from '../../../shared/providers.js';
import { LESSON_MINUTES } from '../../../shared/limits.js';
import { QUALITIES } from './Workspace.jsx';

const fmtTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString()}k` : String(n));
const providerName = (p) => (p ? p.label : 'unknown');
const stepModel = (s) => (s?.model && s.kind !== 'claude-code' ? `${s.label} · ${s.model}` : s?.model ? `${s.label} (${s.model})` : s?.label);

/** What a model was found to do, as a row of short facts. */
export function CapsLine({ caps, need }) {
  if (!caps) return null;
  const structured = { schema: 'JSON schema', json: 'JSON mode', none: 'no structured answers' }[caps.structured] || caps.structured;
  return (
    <ul className="caps" aria-label="What this model can do">
      <li className={caps.structured === 'none' ? 'no' : 'yes'}>{structured}</li>
      <li className={caps.images ? 'yes' : 'no'}>{caps.images ? 'pictures' : 'no pictures'}</li>
      <li className={caps.pdf ? 'yes' : 'no'}>{caps.pdf ? 'PDFs' : 'no PDFs'}</li>
      {caps.context ? <li className={need && caps.context < need ? 'no' : ''}>context {caps.context.toLocaleString()}{need ? ` (needs ~${fmtTokens(need)})` : ''}</li> : null}
      {caps.tokensPerSec ? <li>{caps.tokensPerSec} tokens/s</li> : null}
    </ul>
  );
}

function Lock({ env }) {
  return env ? <span className="lock" title={`Set by ${env} in the environment or .env. Change it there.`}>Set in .env</span> : null;
}

/** A provider: its key or address, its Test, and what the Test found. */
function ProviderCard({ p, act, busy }) {
  const kind = PROVIDER_KINDS[p.kind];
  const [key, setKey] = useState('');
  const [address, setAddress] = useState(p.baseUrl || '');
  const [model, setModel] = useState(p.test?.model || '');
  const tested = p.test;
  const caps = tested?.caps?.[tested?.model || ''] || (tested?.caps ? Object.values(tested.caps)[0] : null);
  const editable = ['ollama', 'local', 'custom'].includes(p.kind);
  const working = busy === p.id;
  return (
    <li className={`provider ${p.configured ? 'ready' : ''}`}>
      <div className="provider-head">
        <strong>{p.label}</strong>
        <span className={`badge ${p.company ? '' : 'local'}`}>{p.company ? `Sends notes to ${p.destination}` : 'This Mac only'}</span>
        <span className="grow" />
        <span className={`status ${p.configured ? 'ok' : ''}`}>{p.configured ? 'Set up' : 'Not set up'}</span>
      </div>
      <p className="hint">{kind?.note}</p>

      {p.needsKey && (
        <div className="row wrap">
          {p.key?.from === 'env' ? (
            <span className="hint">Key from {p.key.env}, ending {p.key.hint}.</span>
          ) : p.key?.set ? (
            <>
              <span className="hint">Key {p.key.hint}, kept in {p.key.from === 'keychain' ? 'the Keychain' : 'a private file'}.</span>
              <button className="link" onClick={() => act('removeKey', p.id)}>Remove key</button>
            </>
          ) : (
            <form
              className="row grow"
              onSubmit={(e) => {
                e.preventDefault();
                act('setKey', p.id, key).then((ok) => ok && setKey(''));
              }}
            >
              <input className="input" type="password" autoComplete="off" aria-label={`${p.label} key`} placeholder={p.needsKey === 'optional' ? 'Key, if it needs one' : 'Paste the key'} value={key} onChange={(e) => setKey(e.target.value)} />
              <button className="btn" disabled={!key.trim()}>Save key</button>
            </form>
          )}
        </div>
      )}

      {editable && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            act('saveProvider', p.id, { baseUrl: address });
          }}
        >
          <input className="input" aria-label={`${p.label} address`} value={address} onChange={(e) => setAddress(e.target.value)} />
          {address !== p.baseUrl && <button className="btn">Save address</button>}
        </form>
      )}

      <div className="row wrap">
        {p.kind !== 'claude-code' && (
          <>
            <input className="input model-input" list={`models-${p.id}`} aria-label={`${p.label} model to test`} placeholder="Model (default: the first)" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id={`models-${p.id}`}>{(p.models || []).map((m) => <option key={m} value={m} />)}</datalist>
          </>
        )}
        <button className="btn" disabled={working} onClick={() => act('test', p.id, model)}>{working ? 'Testing…' : tested ? 'Test again' : 'Test'}</button>
        {p.kind === 'custom' && <button className="link danger" onClick={() => act('removeProvider', p.id)}>Remove</button>}
      </div>
      {tested && (
        <div className={`test-result ${tested.ok ? 'ok' : 'bad'}`}>
          {tested.ok ? (
            <>
              <span>{tested.model ? `${tested.model}: ` : ''}works · tested {timeAgo(tested.at)}</span>
              <CapsLine caps={caps} />
            </>
          ) : (
            <span>Did not pass: {tested.error}</span>
          )}
          {(tested.notes || []).map((n) => <span key={n} className="hint">{n}</span>)}
        </div>
      )}
    </li>
  );
}

/** Who does each step: one writer for everything, or one per step, with effort and hand-back. */
export function PlanEditor({ plan, providers, resolved, locks, onChange, idPrefix = 'plan' }) {
  const steps = plan.mode === 'one' ? [['all', 'Every step']] : WRITER_STEPS;
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  const row = (key) => (key === 'all' ? plan.all : plan.steps[key]);
  const set = (key, patch) => onChange(key === 'all' ? { all: { ...plan.all, ...patch } } : { steps: { [key]: { ...plan.steps[key], ...patch } } });
  const effective = (key) => resolved?.steps?.[key === 'all' ? 'write' : key];
  const fix = plan.mode === 'one' ? plan.all : plan.steps.fix;
  const write = plan.mode === 'one' ? plan.all : plan.steps.write;
  const differentFixer = fix.provider !== write.provider || fix.model !== write.model;
  return (
    <div className="plan">
      <div className="seg" role="radiogroup" aria-label="Writers">
        {[['one', 'One for all'], ['steps', 'Per step']].map(([v, label]) => (
          <label key={v} className={plan.mode === v ? 'on' : ''}>
            <input type="radio" name={`${idPrefix}-mode`} checked={plan.mode === v} onChange={() => onChange({ mode: v })} />
            {label}
          </label>
        ))}
      </div>
      <table className="plan-table">
        <thead>
          <tr><th>Step</th><th>Provider</th><th>Model</th><th>Effort</th></tr>
        </thead>
        <tbody>
          {steps.map(([key, label]) => {
            const s = row(key);
            const p = byId[s.provider];
            const eff = effective(key);
            const effortLock = locks[`effort.${key === 'all' ? 'write' : key}`];
            const modelLock = p?.kind === 'claude-code' ? locks['model.claude-code'] : null;
            return (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>
                  <select className="input" aria-label={`${label}: provider`} value={s.provider} onChange={(e) => set(key, { provider: e.target.value, model: '' })}>
                    {providers.map((o) => <option key={o.id} value={o.id}>{o.label}{o.configured ? '' : ' (not set up)'}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    className="input"
                    aria-label={`${label}: model`}
                    list={`${idPrefix}-models-${key}`}
                    disabled={!!modelLock}
                    placeholder={eff?.model || (p?.kind === 'claude-code' ? "Claude Code's default" : 'Choose a model')}
                    defaultValue={s.model}
                    key={`${s.provider}-${s.model}`}
                    onBlur={(e) => e.target.value.trim() !== s.model && set(key, { model: e.target.value.trim() })}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                  <datalist id={`${idPrefix}-models-${key}`}>{(p?.models || []).map((m) => <option key={m} value={m} />)}</datalist>
                  <Lock env={modelLock} />
                </td>
                <td>
                  <select className="input" aria-label={`${label}: effort`} disabled={!!effortLock} value={s.effort} onChange={(e) => set(key, { effort: e.target.value })}>
                    <option value="">{key === 'all' ? 'Each step’s default' : `Default${eff?.effort ? ` (${eff.effort})` : ''}`}</option>
                    {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                  <Lock env={effortLock} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {plan.mode === 'steps' && differentFixer && (
        <label className="field inline">
          <span>If fixing keeps failing</span>
          <select className="input" value={plan.handBack.after} onChange={(e) => onChange({ handBack: { after: Number(e.target.value) } })}>
            <option value={0}>keep the same fixer</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>back to {providerName(byId[write.provider])} after {n} failed fix{n === 1 ? '' : 'es'}</option>)}
          </select>
        </label>
      )}
      <PlanWarnings resolved={resolved} />
    </div>
  );
}

/** What the chosen models will do with notes: pictures refused, PDFs as text, short context. */
function PlanWarnings({ resolved }) {
  if (!resolved?.steps) return resolved?.error ? <p className="hint over-limit">{resolved.error}</p> : null;
  const r = resolved.steps.read;
  const w = resolved.steps.write;
  const notes = [];
  if (!r.caps?.images) notes.push(`${stepModel(r)} cannot see pictures, so photos in notes will be refused. Choose a model that can for “Reading your notes”.`);
  if (!r.caps?.pdf) notes.push(`${stepModel(r)} cannot read PDFs: their text is sent instead, and a scanned PDF is refused.`);
  if (w.caps?.context && w.caps.context < 28_000) notes.push(`${stepModel(w)} has ${w.caps.context.toLocaleString()} tokens of context; writing a lesson needs about 28,000.`);
  if (w.caps?.structured === 'none') notes.push(`${stepModel(w)} gives no structured answers; its answers are read out of plain text and fail more often.`);
  return (
    <>
      {notes.map((n) => <p key={n} className="hint warn">{n}</p>)}
      {resolved.notesGo && (
        <p className="notes-go">
          <strong>Where your notes go: </strong>
          {resolved.notesGo.map((g, i) => (
            <span key={g.where}>
              {i ? ' ' : ''}
              {g.local ? `${g.steps.join(', ')} run${g.steps.length === 1 ? 's' : ''} on this Mac.` : `${g.where}, for ${g.steps.join(', ')}.`}
            </span>
          ))}{' '}
          Scenes always run only on this Mac.
        </p>
      )}
    </>
  );
}

function History({ items, onUndo, only }) {
  const list = only ? items.filter((h) => h.by === only) : items;
  if (!list.length) return <p className="hint">{only === 'claude' ? 'Claude has not changed anything yet.' : 'No changes yet.'}</p>;
  return (
    <ul className="history">
      {list.slice(0, 20).map((h) => (
        <li key={h.seq} className={h.undone ? 'undone' : ''}>
          <span className={`who ${h.by}`}>{h.by === 'claude' ? 'Claude' : 'You'}</span>
          <span className="what">{h.summary}</span>
          <span className="hint">{timeAgo(h.at)}</span>
          {h.undoable && <button className="link" onClick={() => onUndo(h.seq)}>Undo</button>}
        </li>
      ))}
    </ul>
  );
}

function Copyable({ label, text }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <span className="hint">{label}</span>
      <pre><code>{text}</code></pre>
      <button
        className="btn"
        onClick={() => navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Defaults({ value, locks, voices, onChange, lockPrefix, withVoice }) {
  const english = voices.filter((v) => v.lang === 'a' || v.lang === 'b');
  return (
    <div className="defaults">
      <label className="field">
        <span>Length</span>
        <select className="input" value={value.minutes} onChange={(e) => onChange({ minutes: Number(e.target.value) })}>
          {LESSON_MINUTES.map((m) => <option key={m} value={m}>About {m} minute{m === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Quality</span>
        <select className="input" value={value.quality} onChange={(e) => onChange({ quality: e.target.value })}>
          {QUALITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Before it renders <Lock env={locks[`${lockPrefix}.review`]} /></span>
        <select className="input" disabled={!!locks[`${lockPrefix}.review`]} value={value.review} onChange={(e) => onChange({ review: e.target.value })}>
          <option value="render">Render right away</option>
          <option value="storyboard">Wait for me on the storyboard</option>
          <option value="script">Show me the narration first</option>
        </select>
      </label>
      {withVoice && (
        <label className="field">
          <span>Voice <Lock env={locks[`${lockPrefix}.voiceId`]} /></span>
          <select className="input" disabled={!!locks[`${lockPrefix}.voiceId`]} value={value.voiceId} onChange={(e) => onChange({ voiceId: e.target.value })}>
            {english.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} · {v.lang === 'b' ? 'British' : 'American'}</option>)}
          </select>
        </label>
      )}
      {withVoice && (
        <label className="check">
          <input type="checkbox" disabled={!!locks[`${lockPrefix}.visualReview`]} checked={!!value.visualReview} onChange={(e) => onChange({ visualReview: e.target.checked })} />
          <span>Let the writer look over its own frames <span className="hint">(one more request, a few cents)</span> <Lock env={locks[`${lockPrefix}.visualReview`]} /></span>
        </label>
      )}
    </div>
  );
}

function Rates({ data, onSave }) {
  const own = data.values.rates || {};
  const [draft, setDraft] = useState({ key: '', input: '', output: '', cacheRead: '' });
  const keys = data.providers.filter((p) => p.company && p.kind !== 'claude-code').flatMap((p) => (p.models || []).map((m) => `${p.id}:${m}`));
  const save = (next) => onSave({ rates: next });
  return (
    <>
      <table className="rates">
        <thead><tr><th>Provider and model</th><th>Input</th><th>Output</th><th>Cache read</th><th /></tr></thead>
        <tbody>
          {Object.entries(own).map(([k, r]) => (
            <tr key={k}>
              <td>{k}</td><td>${r.input}</td><td>${r.output}</td><td>{r.cacheRead != null ? `$${r.cacheRead}` : '—'}</td>
              <td><button className="link" onClick={() => { const next = { ...own }; delete next[k]; save(next); }}>Remove</button></td>
            </tr>
          ))}
          {Object.entries(data.rates.builtIn).map(([k, r]) => (
            <tr key={k} className="builtin">
              <td>{k} <span className="hint">built in</span></td><td>${r.input}</td><td>${r.output}</td><td>${r.cacheRead}</td><td />
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          save({ ...own, [draft.key.trim()]: { input: draft.input, output: draft.output, ...(draft.cacheRead !== '' ? { cacheRead: draft.cacheRead } : {}) } });
          setDraft({ key: '', input: '', output: '', cacheRead: '' });
        }}
      >
        <input className="input grow" list="rate-keys" aria-label="Provider and model" placeholder="openai:model-name" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} />
        <datalist id="rate-keys">{keys.map((k) => <option key={k} value={k} />)}</datalist>
        {['input', 'output', 'cacheRead'].map((f) => (
          <input key={f} className="input num" type="number" min="0" step="0.01" aria-label={`${f} dollars per million tokens`} placeholder={{ input: 'in $', output: 'out $', cacheRead: 'cache $' }[f]} value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
        ))}
        <button className="btn" disabled={!draft.key.includes(':') || draft.input === '' || draft.output === ''}>Add rate</button>
      </form>
      <p className="hint">Dollars per million tokens. Built-in rates were checked on {data.rates.date}; a rate you add wins over a built-in one. Without a rate, a provider’s cost shows as unknown and the caps cannot count it.</p>
    </>
  );
}

/**
 * Settings, at #settings/<section>: who writes lessons and with what, defaults for new lessons,
 * what Claude may change from a conversation, costs, how to connect Claude, and where things are.
 * Every change applies to the next request and is kept with who made it, so it can be undone.
 */
export default function Settings({ section, voices, onClose, onChanged, toast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [connect, setConnect] = useState(null);
  const [newProvider, setNewProvider] = useState({ label: '', baseUrl: '' });

  useEffect(() => {
    api.settings().then(setData, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (section === 'connect' && !connect) api.connect().then(setConnect).catch(() => {});
  }, [section, connect]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = (d) => {
    setData(d);
    onChanged?.(d);
    return true;
  };
  const run = async (fn, okText) => {
    try {
      const d = await fn();
      apply(d.provider ? await api.settings() : d);
      if (okText) toast({ kind: 'success', text: okText });
      return true;
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
      return false;
    }
  };
  const save = (body) => run(() => api.patchSettings(body));
  const act = async (what, id, arg) => {
    if (what === 'test') {
      setBusy(id);
      try {
        const { result } = await api.testProvider(id, arg);
        apply(await api.settings());
        toast(result.ok ? { kind: 'success', text: `${result.model || 'It'} works.` } : { kind: 'error', text: result.error, ms: 9000 });
      } catch (e) {
        toast({ kind: 'error', text: e.message, ms: 9000 });
      } finally {
        setBusy(null);
      }
      return true;
    }
    if (what === 'setKey') return run(() => api.setKey(id, arg), 'Key saved. Press Test to check it.');
    if (what === 'removeKey') return run(() => api.removeKey(id), 'Key removed.');
    if (what === 'saveProvider') return run(() => api.saveProvider(id, arg), 'Saved.');
    if (what === 'removeProvider') return run(() => api.removeProvider(id), 'Removed.');
    return false;
  };
  const undo = (seq) => run(() => api.undoSettings(seq), 'Undone.');

  const lastByClaude = useMemo(() => data?.history?.find((h) => h.by === 'claude' && h.undoable && Date.now() - h.at < 86_400_000), [data]);
  const anyUndoable = data?.history?.find((h) => h.undoable);

  if (!data) {
    return (
      <div className="workspace settings" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="ws-loading">
          <button className="link" onClick={onClose}>← Library</button>
          <p className="hint">{error || 'Loading…'}</p>
        </div>
      </div>
    );
  }
  const v = data.values;
  const locks = data.locks || {};
  const pageLocks = Object.fromEntries(Object.entries(locks).map(([k, e]) => [k.replace(/^lesson\.defaults\./, 'page.'), e]));

  return (
    <div className="workspace settings" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="ws-top">
        <header className="ws-head">
          <div className="ws-row">
            <button className="link ws-back" onClick={onClose}>← Library</button>
            <h2 className="settings-title">Settings</h2>
            <span className="grow" />
            {anyUndoable && <button className="btn" onClick={() => undo()}>Undo last change</button>}
          </div>
        </header>
        <nav className="ws-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_SECTIONS.map(([id, label]) => (
            <a key={id} role="tab" aria-selected={section === id} className={section === id ? 'on' : ''} href={`#settings/${id}`}>{label}</a>
          ))}
        </nav>
      </div>

      <div className="ws-body settings-body">
        {lastByClaude && (
          <div className="banner claude-change" role="status">
            <span>Changed by Claude {timeAgo(lastByClaude.at)}: {lastByClaude.summary}</span>
            <button className="link" onClick={() => undo(lastByClaude.seq)}>Undo</button>
          </div>
        )}

        {section === 'writer' && (
          <>
            <section className="block">
              <h3>Providers</h3>
              <p className="hint">Set up any you want to use. Keys are kept in {data.keysKeptIn === 'the macOS Keychain' ? "your Mac's Keychain" : 'a file only you can read'} and never shown again.</p>
              <ul className="providers">
                {data.providers.map((p) => <ProviderCard key={p.id} p={p} act={act} busy={busy} />)}
              </ul>
              <form
                className="row wrap add-provider"
                onSubmit={(e) => {
                  e.preventDefault();
                  act('saveProvider', 'new', newProvider).then((ok) => ok && setNewProvider({ label: '', baseUrl: '' }));
                }}
              >
                <input className="input" aria-label="New provider name" placeholder="Name (OpenRouter)" value={newProvider.label} onChange={(e) => setNewProvider({ ...newProvider, label: e.target.value })} />
                <input className="input grow" aria-label="New provider address" placeholder="https://openrouter.ai/api/v1" value={newProvider.baseUrl} onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })} />
                <button className="btn" disabled={!newProvider.baseUrl.trim()}>Add an OpenAI-compatible provider</button>
              </form>
            </section>
            <section className="block">
              <h3>Who does each step</h3>
              <p className="hint">For lessons started from this page. Changes apply to the next request.</p>
              <PlanEditor plan={v['writer.page']} providers={data.providers} resolved={data.resolved.page} locks={locks} onChange={(patch) => save({ 'writer.page': patch })} idPrefix="page" />
            </section>
          </>
        )}

        {section === 'defaults' && (
          <section className="block">
            <h3>New lessons</h3>
            <p className="hint">What the lesson form starts with. Each lesson can still be changed in the form.</p>
            <Defaults value={v['lesson.defaults']} locks={pageLocks} lockPrefix="page" voices={voices} withVoice onChange={(patch) => save({ 'lesson.defaults': patch })} />
          </section>
        )}

        {section === 'claude' && (
          <>
            <section className="block">
              <h3>Lessons Claude starts</h3>
              <p className="hint">From Claude Code or the desktop app, through the connector.</p>
              <div className="seg" role="radiogroup" aria-label="Claude's writer">
                {[[true, 'Same as the page'], [false, 'Their own writer']].map(([same, label]) => (
                  <label key={label} className={v['writer.claude'].same === same ? 'on' : ''}>
                    <input type="radio" name="claude-same" checked={v['writer.claude'].same === same} onChange={() => save({ 'writer.claude': { same } })} />
                    {label}
                  </label>
                ))}
              </div>
              {!v['writer.claude'].same && (
                <PlanEditor plan={v['writer.claude'].plan} providers={data.providers} resolved={data.resolved.claude} locks={locks} onChange={(patch) => save({ 'writer.claude': { plan: patch } })} idPrefix="claude" />
              )}
              <h4>Defaults</h4>
              <Defaults value={v['claude.defaults']} locks={{}} lockPrefix="claude" voices={voices} onChange={(patch) => save({ 'claude.defaults': patch })} />
            </section>
            <section className="block">
              <h3>What Claude may change from a conversation</h3>
              {[
                ['writer', 'Which of your set-up providers and models each step of its lessons uses'],
                ['effort', 'Effort per step'],
                ['defaults', 'Its lesson defaults: length, quality, review'],
                ['lowerCap', 'Lower the spending caps (raising them is only possible here)'],
                ['pageWriter', "The page's own writer, not only its own"],
              ].map(([k, label]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={!!v['claude.allow'][k]} onChange={(e) => save({ 'claude.allow': { [k]: e.target.checked } })} />
                  <span>{label}</span>
                </label>
              ))}
              <label className="check"><input type="checkbox" checked={false} disabled /><span>Keys and provider addresses <span className="hint">only on this page, always</span></span></label>
            </section>
            <section className="block">
              <h3>Changes made by Claude</h3>
              <History items={data.history} onUndo={undo} only="claude" />
            </section>
          </>
        )}

        {section === 'costs' && (
          <>
            <section className="block">
              <h3>Spending</h3>
              <p><strong>{fmtUsd(data.costThisMonthUsd)}</strong> on lessons this month, from every version written.</p>
              <div className="row wrap">
                <label className="field">
                  <span>Cap per lesson <Lock env={locks['costs.lessonCapUsd']} /></span>
                  <input
                    className="input num"
                    type="number"
                    min="0"
                    step="0.5"
                    disabled={!!locks['costs.lessonCapUsd']}
                    defaultValue={v.costs.lessonCapUsd ?? ''}
                    key={`l-${v.costs.lessonCapUsd}`}
                    placeholder="no cap"
                    onBlur={(e) => save({ costs: { lessonCapUsd: e.target.value === '' ? null : Number(e.target.value) } })}
                  />
                </label>
                <label className="field">
                  <span>Cap per month</span>
                  <input
                    className="input num"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={v.costs.monthCapUsd ?? ''}
                    key={`m-${v.costs.monthCapUsd}`}
                    placeholder="no cap"
                    onBlur={(e) => save({ costs: { monthCapUsd: e.target.value === '' ? null : Number(e.target.value) } })}
                  />
                </label>
              </div>
              <p className="hint">A lesson that reaches its cap stops, keeps what it has, and continues when you raise the cap and press Retry. Claude Code reports what the API would charge; on a Pro or Max plan the caps still count that figure.</p>
            </section>
            <section className="block">
              <h3>Rates</h3>
              <Rates data={data} onSave={save} />
            </section>
          </>
        )}

        {section === 'connect' && (
          <section className="block">
            <h3>Make lessons from Claude</h3>
            <p className="hint">Claude can start a lesson from a conversation, follow its stages, search your library and fetch the video. Lessons it starts use the settings under Claude (MCP).</p>
            {!connect ? <p className="hint">Loading…</p> : (
              <>
                <h4>Claude Code</h4>
                <Copyable label="Over HTTP, while this dashboard is running:" text={connect.http.claudeCode} />
                <Copyable label="Or started by Claude Code itself:" text={connect.stdio.claudeCode} />
                <h4>Claude desktop app</h4>
                <Copyable label={`Add to ${connect.desktop.configFile}, then restart the app:`} text={JSON.stringify(connect.desktop.entry, null, 2)} />
                <p className="hint">Or run <code>{connect.desktop.pack}</code> in tts-studio and open the .mcpb file it makes.</p>
                <p className="hint">Then ask: “make a 3-minute lesson on what we just worked through”. The dashboard must be running; with <code>TTS_MCP_AUTOSTART=1</code> in the connector’s environment it starts on its own.</p>
              </>
            )}
          </section>
        )}

        {section === 'storage' && (
          <section className="block">
            <h3>Where things are</h3>
            <dl className="details">
              <dt>Library</dt><dd><code>{data.storage?.dataDir}</code></dd>
              <dt>Lesson projects</dt><dd><code>{data.storage?.projects}</code></dd>
              <dt>Keys</dt><dd>{data.keysKeptIn === 'the macOS Keychain' ? 'The macOS Keychain, under “Narrated Proofs”' : <code>{data.keysKeptIn}</code>}</dd>
              <dt>Settings file</dt><dd>{data.storage?.envFile ? <code>{data.storage.envFile}</code> : 'No .env file'}; values set there win over this page.</dd>
            </dl>
            <h3>All changes</h3>
            <History items={data.history} onUndo={undo} />
          </section>
        )}
      </div>
    </div>
  );
}
