import { BUILT_IN_PROVIDERS, DEFAULT_MODEL, DEFAULT_PLAN, destination, EFFORTS, KIND_CAPS, PROVIDER_KINDS, STEP_EFFORT_ENV, WRITER_STEPS } from '../shared/providers.js';
import { LESSON_MINUTES, VIDEO_QUALITIES } from '../shared/limits.js';
import { RATES, RATES_DATE, rateKey } from '../shared/rates.js';
import { describe, ENV_KEYS, keyFor } from './secrets.js';

/**
 * Settings made in the page: who writes lessons, lesson defaults, what Claude may change from a
 * conversation, and costs. Kept in SQLite, every change with when and who made it, so it can be
 * undone. Keys are not here: they are in the Keychain (see secrets.js).
 *
 * Which value wins: the environment, then the .env, then Settings, then the built-in default.
 * A value fixed by the environment shows as locked and cannot be changed here.
 *
 * Changes come from 'you' (the page) or 'claude' (the MCP connector). Claude may change only
 * what claude.allow lets it, may only choose among providers already set up, and may lower a
 * spending cap but never raise one. Providers, addresses, keys and rates are never Claude's.
 */
export class SettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings_history (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL,
  old_json  TEXT,
  new_json  TEXT,
  by        TEXT NOT NULL,
  at        INTEGER NOT NULL,
  undone    INTEGER NOT NULL DEFAULT 0,
  undo_of   INTEGER
);
`;

export const DEFAULTS = {
  'writer.page': DEFAULT_PLAN,
  'writer.claude': { same: true, plan: DEFAULT_PLAN },
  'lesson.defaults': { minutes: 2, quality: 'default', review: 'render', visualReview: false, voiceId: '' },
  'claude.defaults': { minutes: 2, quality: 'default', review: 'render' },
  'claude.allow': { writer: true, effort: true, defaults: true, lowerCap: true, pageWriter: false },
  costs: { lessonCapUsd: 15, monthCapUsd: null },
  rates: {},
  providers: {},
};

// Kept in the same table but not settings anyone changes: what each provider's Test found.
const TESTS = 'provider.tests';

export const LABELS = {
  'writer.page': 'Lesson writer',
  'writer.claude': "Claude's lesson writer",
  'lesson.defaults': 'Lesson defaults',
  'claude.defaults': "Defaults for Claude's lessons",
  'claude.allow': 'What Claude may change',
  costs: 'Spending caps',
  rates: 'Rates',
  providers: 'Providers',
};

const STEP_CONFIG = { read: 'claudeReadEffort', write: 'claudeEffort', fix: 'claudeFixEffort', polish: 'claudePolishEffort', outline: 'claudeOutlineEffort' };
const STEP_LABEL = Object.fromEntries([...WRITER_STEPS, ['polish', 'Polishing']]);
const MODEL_SHAPE = /^[\w.:/@+-]{0,200}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const money = (v, label) => {
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new SettingsError(`${label} must be a number of dollars from 0 to 10,000, or empty for no cap.`);
  return Math.round(n * 100) / 100;
};

/** An address a provider is reached at. "This Mac" providers must be on this Mac. */
export function checkBaseUrl(kind, value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SettingsError('That address is not a URL. It starts with http:// or https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SettingsError('A provider address starts with http:// or https://.');
  if (url.username || url.password) throw new SettingsError('Put the key in the key field, not in the address.');
  if (PROVIDER_KINDS[kind] && !PROVIDER_KINDS[kind].company && !LOCAL_HOSTS.has(url.hostname)) {
    throw new SettingsError(`“${PROVIDER_KINDS[kind].label}” runs on this Mac, so its address is localhost or 127.0.0.1. For another machine, add it under Other.`);
  }
  return raw;
}

export function createSettings({ db, getConfig, secrets }) {
  db.exec(SCHEMA);
  const stmts = {
    get: db.prepare('SELECT value_json FROM settings WHERE key = ?'),
    put: db.prepare(`INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    del: db.prepare('DELETE FROM settings WHERE key = ?'),
    log: db.prepare('INSERT INTO settings_history (key, old_json, new_json, by, at, undo_of) VALUES (?, ?, ?, ?, ?, ?)'),
    history: db.prepare('SELECT * FROM settings_history ORDER BY seq DESC LIMIT ?'),
    entry: db.prepare('SELECT * FROM settings_history WHERE seq = ?'),
    lastUndoable: db.prepare("SELECT * FROM settings_history WHERE undone = 0 AND undo_of IS NULL AND key NOT LIKE 'key.%' ORDER BY seq DESC LIMIT 1"),
    markUndone: db.prepare('UPDATE settings_history SET undone = 1 WHERE seq = ?'),
  };

  const rawOf = (key) => stmts.get.get(key)?.value_json ?? null;
  /** A setting as stored, over its default. */
  function get(key) {
    const raw = rawOf(key);
    if (raw == null) return clone(DEFAULTS[key] ?? {});
    const value = JSON.parse(raw);
    return isObject(DEFAULTS[key]) && isObject(value) && !['rates', 'providers'].includes(key) ? { ...clone(DEFAULTS[key]), ...value } : value;
  }

  function write(key, json, by, undoOf = null) {
    const old = rawOf(key);
    db.transaction(() => {
      if (json == null) stmts.del.run(key);
      else stmts.put.run(key, json, Date.now(), by);
      stmts.log.run(key, old, json, by, Date.now(), undoOf);
    })();
  }

  // ---- providers ------------------------------------------------------------------------

  function providerRecord(id) {
    const stored = get('providers');
    if (BUILT_IN_PROVIDERS.includes(id)) return { kind: id, ...(stored[id] || {}) };
    return stored[id] || null;
  }

  /** A provider with everything known about it except its key. */
  function provider(id) {
    const rec = providerRecord(id);
    if (!rec || !PROVIDER_KINDS[rec.kind]) return null;
    const kind = PROVIDER_KINDS[rec.kind];
    const baseUrl = rec.baseUrl || kind.baseUrl;
    return {
      id,
      kind: rec.kind,
      label: rec.label || kind.label,
      company: kind.company,
      baseUrl,
      needsKey: rec.kind === 'custom' ? 'optional' : kind.key,
      builtIn: BUILT_IN_PROVIDERS.includes(id),
      destination: destination(rec.kind, baseUrl),
      test: get(TESTS)[id] || null,
    };
  }

  const providerIds = () => [...BUILT_IN_PROVIDERS, ...Object.keys(get('providers')).filter((id) => !BUILT_IN_PROVIDERS.includes(id))];

  /** What a model can do: what its last Test found, else what its kind is assumed to do. */
  function capsOf(p, model) {
    return { ...KIND_CAPS[p.kind], ...(p.test?.caps?.[model] || {}) };
  }

  const keyInfo = async (id) => {
    const { key, from } = await keyFor(id, { config: getConfig(), secrets }).catch(() => ({ key: null, from: null }));
    return { ...describe(key), from, env: ENV_KEYS[id] || null };
  };

  /** Ready to write with: Claude Code always; others once they have a key or passed a Test. */
  function isConfigured(p, key) {
    if (p.kind === 'claude-code') return true;
    if (p.needsKey === true) return key.set;
    if (p.kind === 'custom') return key.set || !!p.test?.ok;
    return !!p.test?.ok;
  }

  async function providerViews() {
    const out = [];
    for (const id of providerIds()) {
      const p = provider(id);
      if (!p) continue;
      const key = p.needsKey ? await keyInfo(id) : null;
      out.push({ ...p, key, configured: isConfigured(p, key || { set: false }), models: p.test?.models || PROVIDER_KINDS[p.kind].models });
    }
    return out;
  }

  async function configured(id) {
    const p = provider(id);
    if (!p) return false;
    return isConfigured(p, p.needsKey ? await keyInfo(id) : { set: false });
  }

  async function saveProvider(id, body, { by = 'you' } = {}) {
    const stored = get('providers');
    let rec;
    if (id === 'new') {
      let n = 1;
      while (stored[`custom-${n}`]) n += 1;
      id = `custom-${n}`;
      rec = { kind: 'custom' };
    } else {
      rec = providerRecord(id);
      if (!rec) throw new SettingsError('There is no such provider.', 404);
    }
    const next = { ...rec };
    if (body.label !== undefined) {
      if (rec.kind !== 'custom') throw new SettingsError('Only providers you added can be renamed.');
      const label = String(body.label).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!label) throw new SettingsError('Give the provider a name.');
      next.label = label;
    }
    if (body.baseUrl !== undefined) {
      if (!['ollama', 'local', 'custom'].includes(rec.kind)) throw new SettingsError(`${PROVIDER_KINDS[rec.kind].label} is always reached at its own address.`);
      next.baseUrl = checkBaseUrl(rec.kind, body.baseUrl);
    }
    if (rec.kind === 'custom' && !next.baseUrl) throw new SettingsError('A provider you add needs its address.');
    if (rec.kind === 'custom' && !next.label) next.label = new URL(next.baseUrl).hostname;
    const providers = { ...stored, [id]: next };
    if (BUILT_IN_PROVIDERS.includes(id)) delete providers[id].kind;
    write('providers', JSON.stringify(providers), by);
    // A new address may not offer what the old one did: test again.
    if (body.baseUrl !== undefined) recordTest(id, null);
    return id;
  }

  function usedBy(id) {
    const where = [];
    const plans = [['the lesson writer', get('writer.page')], ["Claude's lesson writer", get('writer.claude').plan]];
    for (const [name, plan] of plans) {
      if (plan.all.provider === id || Object.values(plan.steps || {}).some((s) => s.provider === id)) where.push(name);
    }
    return where;
  }

  async function removeProvider(id) {
    const stored = get('providers');
    if (BUILT_IN_PROVIDERS.includes(id)) throw new SettingsError('Built-in providers cannot be removed. Remove the key instead.');
    if (!stored[id]) throw new SettingsError('There is no such provider.', 404);
    const using = usedBy(id);
    if (using.length) throw new SettingsError(`${using.join(' and ')} still use${using.length === 1 ? 's' : ''} it. Choose another provider there first.`, 409);
    const providers = { ...stored };
    delete providers[id];
    write('providers', JSON.stringify(providers), 'you');
    recordTest(id, null);
    await secrets.remove(id).catch(() => {});
  }

  async function setKey(id, key) {
    const p = provider(id);
    if (!p) throw new SettingsError('There is no such provider.', 404);
    if (!p.needsKey) throw new SettingsError(`${p.label} needs no key.`);
    const shown = await secrets.set(id, key);
    stmts.log.run(`key.${id}`, null, JSON.stringify(shown), 'you', Date.now(), null);
    recordTest(id, null);
    return shown;
  }

  async function removeKey(id) {
    const p = provider(id);
    if (!p) throw new SettingsError('There is no such provider.', 404);
    await secrets.remove(id);
    stmts.log.run(`key.${id}`, null, JSON.stringify({ set: false }), 'you', Date.now(), null);
  }

  function recordTest(id, result) {
    const tests = get(TESTS);
    if (result) tests[id] = result;
    else delete tests[id];
    stmts.put.run(TESTS, JSON.stringify(tests), Date.now(), 'test');
  }

  // ---- values -----------------------------------------------------------------------------

  function normalizeStep(s, fallback, ids) {
    const provider = String(s?.provider ?? fallback.provider);
    if (!ids.has(provider)) throw new SettingsError(`There is no provider called “${provider}”.`);
    const model = String(s?.model ?? fallback.model ?? '').trim();
    if (!MODEL_SHAPE.test(model)) throw new SettingsError(`“${model.slice(0, 40)}” is not a model name.`);
    const effort = String(s?.effort ?? fallback.effort ?? '');
    if (effort && !EFFORTS.includes(effort)) throw new SettingsError(`Effort is one of ${EFFORTS.join(', ')}, or empty for each step's default.`);
    return { provider, model, effort };
  }

  function normalizePlan(v, old) {
    if (!isObject(v)) throw new SettingsError('A writer plan is an object.');
    const ids = new Set(providerIds());
    const all = normalizeStep(v.all, old.all, ids);
    return {
      mode: (v.mode ?? old.mode) === 'steps' ? 'steps' : 'one',
      all,
      steps: Object.fromEntries(WRITER_STEPS.map(([k]) => [k, normalizeStep(v.steps?.[k], old.steps?.[k] || all, ids)])),
      handBack: { after: intIn(v.handBack?.after ?? old.handBack?.after, 0, 5, 2) },
    };
  }

  const mergePlan = (old, v) => ({ ...old, ...v, all: { ...old.all, ...(v?.all || {}) }, steps: { ...old.steps, ...(v?.steps || {}) }, handBack: { ...old.handBack, ...(v?.handBack || {}) } });

  function normalize(key, value, old) {
    if (key === 'writer.page') return normalizePlan(mergePlan(old, value), old);
    if (key === 'writer.claude') {
      if (!isObject(value)) throw new SettingsError("Claude's writer is { same, plan }.");
      return { same: value.same === undefined ? old.same : !!value.same, plan: normalizePlan(mergePlan(old.plan, value.plan || {}), old.plan) };
    }
    if (!isObject(value) && key !== 'rates') throw new SettingsError(`${LABELS[key]} is an object.`);
    const v = { ...old, ...value };
    if (key === 'lesson.defaults' || key === 'claude.defaults') {
      if (!LESSON_MINUTES.includes(Number(v.minutes))) throw new SettingsError(`A lesson is ${LESSON_MINUTES.join(', ')} minutes long.`);
      if (!VIDEO_QUALITIES.includes(v.quality)) throw new SettingsError(`Quality is one of ${VIDEO_QUALITIES.join(', ')}.`);
      if (!['render', 'storyboard'].includes(v.review)) throw new SettingsError('Review is "render" (right away) or "storyboard" (wait for you).');
      const out = { minutes: Number(v.minutes), quality: v.quality, review: v.review };
      if (key === 'claude.defaults') return out;
      const voiceId = String(v.voiceId || '');
      if (voiceId && !/^[ab][a-z]_[a-z0-9_]{1,40}$/.test(voiceId)) throw new SettingsError('Lessons need an English voice id, such as af_heart.');
      return { ...out, visualReview: !!v.visualReview, voiceId };
    }
    if (key === 'claude.allow') return Object.fromEntries(Object.keys(DEFAULTS['claude.allow']).map((k) => [k, !!v[k]]));
    if (key === 'costs') return { lessonCapUsd: money(v.lessonCapUsd, 'The cap per lesson'), monthCapUsd: money(v.monthCapUsd, 'The monthly cap') };
    if (key === 'rates') {
      if (!isObject(value)) throw new SettingsError('Rates are { "provider:model": { input, output } }.');
      const out = {};
      for (const [k, r] of Object.entries(value)) {
        if (!/^[a-z0-9-]{1,40}:[\w.:/@+-]{1,200}$/.test(k)) throw new SettingsError(`“${k.slice(0, 60)}” is not provider:model.`);
        if (r === null) continue; // removes it
        const n = (x, name) => {
          const num = Number(x);
          if (!Number.isFinite(num) || num < 0 || num > 1000) throw new SettingsError(`The ${name} rate for ${k} must be dollars per million tokens, from 0 to 1000.`);
          return num;
        };
        out[k] = { input: n(r.input, 'input'), output: n(r.output, 'output') };
        if (r.cacheRead != null && r.cacheRead !== '') out[k].cacheRead = n(r.cacheRead, 'cache read');
        if (r.cacheWrite != null && r.cacheWrite !== '') out[k].cacheWrite = n(r.cacheWrite, 'cache write');
      }
      return out;
    }
    throw new SettingsError(`${LABELS[key] || key} is not changed this way.`);
  }

  /** Values fixed by the environment, by what they fix. */
  function locks() {
    const given = getConfig().given || {};
    const out = {};
    const lock = (path, env) => given[env] && (out[path] = env);
    lock('lesson.defaults.review', 'TTS_LESSON_REVIEW');
    lock('lesson.defaults.visualReview', 'TTS_AUTHOR_VISUAL_REVIEW');
    lock('lesson.defaults.voiceId', 'TTS_VOICE');
    lock('costs.lessonCapUsd', 'TTS_AUTHOR_MAX_COST_USD');
    lock('model.claude-code', 'TTS_CLAUDE_MODEL');
    for (const [step, env] of Object.entries(STEP_EFFORT_ENV)) lock(`effort.${step}`, env);
    for (const [id, env] of Object.entries(ENV_KEYS)) lock(`key.${id}`, env);
    return out;
  }

  /** A value the environment fixes may not be set to anything else, by anyone. */
  function checkLocks(key, value) {
    const effective = { 'lesson.defaults': () => lessonDefaults('page'), costs: () => costs() }[key];
    if (!effective || !isObject(value)) return;
    const now = effective();
    for (const [path, env] of Object.entries(locks())) {
      const [k, field] = [path.slice(0, path.lastIndexOf('.')), path.slice(path.lastIndexOf('.') + 1)];
      if (k === key && field in value && JSON.stringify(value[field]) !== JSON.stringify(now[field])) {
        throw new SettingsError(`That is set by ${env} in the environment or .env, so it can only be changed there.`, 409);
      }
    }
  }

  const stepsOf = (plan) => [plan.all, ...Object.values(plan.steps || {})];

  /** Why Claude may not make this change, or null when it may. */
  async function claudeRefusal(key, old, next) {
    const allow = get('claude.allow');
    const plans = { 'writer.claude': [old.plan, next.plan], 'writer.page': [old, next] }[key];
    if (plans) {
      if (key === 'writer.page' && !allow.pageWriter) return 'Claude may not change the writer for lessons started from the page. That is set in Settings → Claude (MCP).';
      const [a, b] = plans;
      const writerChanged = (key === 'writer.claude' && old.same !== next.same) || a.mode !== b.mode || a.handBack.after !== b.handBack.after
        || stepsOf(a).some((s, i) => s.provider !== stepsOf(b)[i].provider || s.model !== stepsOf(b)[i].model);
      const effortChanged = stepsOf(a).some((s, i) => s.effort !== stepsOf(b)[i].effort);
      if (writerChanged && !allow.writer) return 'Claude may not choose which writer is used. That is allowed in Settings → Claude (MCP).';
      if (effortChanged && !allow.effort) return 'Claude may not change effort. That is allowed in Settings → Claude (MCP).';
      for (const id of new Set(stepsOf(b).map((s) => s.provider))) {
        if (!(await configured(id))) return `${provider(id)?.label || id} is not set up. Only providers set up in Settings can be chosen, and only there can one be added.`;
      }
      return null;
    }
    if (key === 'claude.defaults') return allow.defaults ? null : 'Claude may not change its lesson defaults. That is allowed in Settings → Claude (MCP).';
    if (key === 'costs') {
      if (!allow.lowerCap) return 'Claude may not change the spending caps. That is allowed in Settings → Claude (MCP).';
      for (const field of ['lessonCapUsd', 'monthCapUsd']) {
        const [a, b] = [old[field], next[field]];
        if (a === b) continue;
        if (b === null || (a !== null && b > a)) return 'Claude can lower a spending cap but never raise or remove one. Raise it in Settings → Costs.';
      }
      return null;
    }
    return `Only you can change ${LABELS[key]?.toLowerCase() || key}, in the dashboard's Settings.`;
  }

  /**
   * Change one or more settings: { key: value } with partial objects merged into the current
   * value. All or nothing; each key is a history entry. Returns the keys that changed.
   */
  async function patch(changes, { by = 'you' } = {}) {
    if (!isObject(changes) || !Object.keys(changes).length) throw new SettingsError('Nothing to change.');
    const pending = [];
    for (const [key, value] of Object.entries(changes)) {
      if (!(key in DEFAULTS) || key === 'providers') throw new SettingsError(`There is no setting called “${key}”.`);
      checkLocks(key, value);
      const old = get(key);
      const next = normalize(key, value, old);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      if (by === 'claude') {
        const why = await claudeRefusal(key, old, next);
        if (why) throw new SettingsError(why, 403);
      }
      pending.push([key, next]);
    }
    for (const [key, next] of pending) write(key, JSON.stringify(next), by);
    return pending.map(([key]) => key);
  }

  function undo(seq) {
    const entry = seq ? stmts.entry.get(seq) : stmts.lastUndoable.get();
    if (!entry) throw new SettingsError('There is nothing to undo.', 404);
    if (entry.key.startsWith('key.')) throw new SettingsError('A key cannot be put back by Undo. Add it again.', 409);
    if (entry.undone || entry.undo_of) throw new SettingsError('That change has already been undone.', 409);
    if (rawOf(entry.key) !== entry.new_json) throw new SettingsError('That setting has changed since, so this change cannot be undone on its own.', 409);
    db.transaction(() => {
      write(entry.key, entry.old_json, 'you', entry.seq);
      stmts.markUndone.run(entry.seq);
    })();
    return entry.key;
  }

  // ---- what a lesson uses -------------------------------------------------------------------

  function rateFor(p, model) {
    if (p.kind === 'claude-code') return null; // it reports its own figure
    if (!p.company) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // this Mac
    const own = get('rates');
    return own[`${p.id}:${model}`] || own[rateKey(p.kind, model)] || RATES[rateKey(p.kind, model)] || null;
  }

  /** The plan a profile ('page' or 'claude') uses, with a lesson's own choice applied. */
  function planOf(profile = 'page', override = null) {
    if (override?.provider) {
      return { mode: 'one', all: { provider: override.provider, model: override.model || '', effort: '' }, steps: {}, handBack: { after: 0 } };
    }
    const claude = get('writer.claude');
    return profile === 'claude' && !claude.same ? claude.plan : get('writer.page');
  }

  /**
   * Everything the lesson writer needs for each step: provider, address, model, effort, what
   * the model can do and its rate. Never a key: the writer looks keys up itself.
   */
  function resolveWriter(profile = 'page', override = null) {
    const config = getConfig();
    const plan = planOf(profile, override);
    const steps = {};
    for (const step of ['read', 'write', 'fix', 'polish', 'outline']) {
      const s = plan.mode === 'one' ? plan.all : plan.steps[step === 'polish' ? 'fix' : step] || plan.all;
      const p = provider(s.provider);
      if (!p) throw new SettingsError(`The writer for “${STEP_LABEL[step]}” names a provider that no longer exists. Choose another in Settings.`);
      const fixedEffort = config.given?.[STEP_EFFORT_ENV[step]] ? config[STEP_CONFIG[step]] : '';
      const effort = fixedEffort || s.effort || config[STEP_CONFIG[step]] || '';
      let model = s.model;
      if (p.kind === 'claude-code') model = config.given?.TTS_CLAUDE_MODEL ? config.claudeModel : model || config.claudeModel || '';
      else model = model || DEFAULT_MODEL[p.kind] || p.test?.model || p.test?.models?.[0] || '';
      steps[step] = { provider: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model, effort, caps: capsOf(p, model), rate: rateFor(p, model) };
    }
    return { steps, handBack: { after: plan.handBack?.after ?? 0 } };
  }

  /** Throws, naming the step and what to do, when a writer cannot be used yet. */
  async function checkWriter(writer, steps = ['read', 'write', 'fix']) {
    for (const step of steps) {
      const w = writer.steps[step];
      if (!(await configured(w.provider))) {
        const p = provider(w.provider);
        const what = p.needsKey === true ? 'has no key' : 'has not passed its Test';
        throw new SettingsError(`${p.label}, chosen for “${STEP_LABEL[step]}”, ${what}. Set it up in Settings → Lesson writer, or choose another.`);
      }
      if (w.kind !== 'claude-code' && !w.model) throw new SettingsError(`Choose a model for ${w.label} (“${STEP_LABEL[step]}”) in Settings → Lesson writer.`);
    }
  }

  /** Who each step sends your topic, notes and files to, in plain words. */
  function whereNotesGo(writer) {
    const by = new Map();
    for (const step of ['read', 'write', 'fix']) {
      const w = writer.steps[step];
      const where = destination(w.kind, w.baseUrl);
      if (!by.has(where)) by.set(where, []);
      by.get(where).push(STEP_LABEL[step].toLowerCase());
    }
    return [...by.entries()].map(([where, steps]) => ({ where, steps, local: where.startsWith('nobody') }));
  }

  function lessonDefaults(profile = 'page') {
    const config = getConfig();
    const given = config.given || {};
    const page = get('lesson.defaults');
    const out = {
      ...page,
      review: given.TTS_LESSON_REVIEW ? config.lessonReview : page.review,
      visualReview: given.TTS_AUTHOR_VISUAL_REVIEW ? config.authorVisualReview : page.visualReview,
      voiceId: given.TTS_VOICE || !page.voiceId ? config.defaultVoiceId : page.voiceId,
    };
    return profile === 'claude' ? { ...out, ...get('claude.defaults') } : out;
  }

  function costs() {
    const config = getConfig();
    const own = get('costs');
    return { ...own, lessonCapUsd: config.lessonCapUsd ?? own.lessonCapUsd };
  }

  // ---- the record ---------------------------------------------------------------------------

  const fmt = (v) => (v === '' || v == null ? '—' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
  const flatten = (v, prefix = '', out = {}) => {
    if (isObject(v)) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
    else out[prefix] = v;
    return out;
  };
  const PATH_LABEL = { minutes: 'length', quality: 'quality', review: 'review', voiceId: 'voice', visualReview: 'frames review', lessonCapUsd: 'cap per lesson', monthCapUsd: 'monthly cap', same: 'same as the page', mode: 'steps', 'handBack.after': 'hand back after' };

  /** One line saying what a change did: "Fixing and polishing: Claude Code → This Mac · qwen3". */
  function describeChange(key, oldJson, newJson) {
    if (key.startsWith('key.')) {
      const p = provider(key.slice(4));
      const v = newJson ? JSON.parse(newJson) : null;
      return `${p?.label || key.slice(4)}: key ${v?.set ? `added (${v.hint})` : 'removed'}`;
    }
    const a = flatten(oldJson ? JSON.parse(oldJson) : DEFAULTS[key] ?? {});
    const b = flatten(newJson ? JSON.parse(newJson) : DEFAULTS[key] ?? {});
    const parts = [];
    for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[path]) === JSON.stringify(b[path])) continue;
      const m = path.match(/(?:^|\.)(all|steps\.(\w+))\.(provider|model|effort)$/);
      let label = PATH_LABEL[path.replace(/^plan\./, '')] || path;
      let [from, to] = [a[path], b[path]];
      if (m) {
        label = `${m[2] ? STEP_LABEL[m[2]] : 'All steps'} ${m[3]}`;
        if (m[3] === 'provider') [from, to] = [provider(from)?.label || from, provider(to)?.label || to];
      }
      parts.push(`${label}: ${fmt(from)} → ${fmt(to)}`);
    }
    return `${LABELS[key] || key}${parts.length ? `: ${parts.slice(0, 4).join('; ')}${parts.length > 4 ? '; …' : ''}` : ''}`;
  }

  function history(limit = 30) {
    return stmts.history.all(Math.min(200, Math.max(1, limit))).map((h) => ({
      seq: h.seq,
      key: h.key,
      by: h.by,
      at: h.at,
      undone: !!h.undone,
      undoOf: h.undo_of,
      summary: h.undo_of ? `Undid: ${describeChange(h.key, h.new_json, h.old_json)}` : describeChange(h.key, h.old_json, h.new_json),
      undoable: !h.undone && !h.undo_of && !h.key.startsWith('key.') && rawOf(h.key) === h.new_json,
    }));
  }

  /** Everything the Settings page shows. Keys appear only as "set, ends in …7c1e". */
  async function view() {
    const providers = await providerViews();
    const summary = (profile) => {
      try {
        const w = resolveWriter(profile);
        return { steps: w.steps, handBack: w.handBack, notesGo: whereNotesGo(w) };
      } catch (e) {
        return { error: e.message };
      }
    };
    return {
      values: {
        'writer.page': get('writer.page'),
        'writer.claude': get('writer.claude'),
        'lesson.defaults': lessonDefaults('page'),
        'claude.defaults': get('claude.defaults'),
        'claude.allow': get('claude.allow'),
        costs: costs(),
        rates: get('rates'),
      },
      locks: locks(),
      providers,
      resolved: { page: summary('page'), claude: summary('claude') },
      rates: { date: RATES_DATE, builtIn: RATES },
      keysKeptIn: secrets.where,
      history: history(),
    };
  }

  return {
    get,
    patch,
    undo,
    history,
    view,
    locks,
    provider,
    providerViews,
    configured,
    capsOf,
    saveProvider,
    removeProvider,
    setKey,
    removeKey,
    recordTest,
    resolveWriter,
    checkWriter,
    whereNotesGo,
    lessonDefaults,
    costs,
    rateFor,
  };
}
