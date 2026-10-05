import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { isActive, stripExt, useDebounced, useLocalStorage } from './utils.js';
import Header from './components/Header.jsx';
import Composer from './components/Composer.jsx';
import Library from './components/Library.jsx';
import Drawer from './components/Drawer.jsx';
import Toasts from './components/Toasts.jsx';

export const DEFAULT_SETTINGS = {
  voiceId: '',
  speed: 1,
  stripMarkdown: true,
};

const uid = () => Math.random().toString(36).slice(2, 10);
const TEXT_FILE = /\.(txt|md|markdown|text)$/i;

export default function App() {
  const [health, setHealth] = useState(null);
  const [voices, setVoices] = useState([]);
  const [languages, setLanguages] = useState([]);
  const [voicesError, setVoicesError] = useState('');
  const [stats, setStats] = useState(null);
  const [tags, setTags] = useState([]);

  const [settings, setSettings] = useLocalStorage('tts-studio.kokoro-settings', DEFAULT_SETTINGS);
  const [autoGenerate, setAutoGenerate] = useLocalStorage('tts-studio.auto', true);
  const [drafts, setDrafts] = useState([]);
  const [dragging, setDragging] = useState(false);

  const [filters, setFilters] = useState({ q: '', status: '', voiceId: '', tag: '', favorite: false, sort: '' });
  const [limit, setLimit] = useState(30);
  const [list, setList] = useState({ items: [], total: 0, loaded: false, error: '' });
  const [selected, setSelected] = useState(null); // { id, autoplay }
  const [toasts, setToasts] = useState([]);

  const debouncedQ = useDebounced(filters.q, 250);
  const params = useMemo(
    () => ({
      q: debouncedQ.trim(),
      status: filters.status,
      voiceId: filters.voiceId,
      tag: filters.tag,
      favorite: filters.favorite,
      sort: filters.sort,
      limit,
    }),
    [debouncedQ, filters.status, filters.voiceId, filters.tag, filters.favorite, filters.sort, limit],
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = JSON.stringify(params);

  /* ---------- toasts ---------- */
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t) => {
      const id = uid();
      setToasts((ts) => [...ts, { id, ...t }]);
      setTimeout(() => dismissToast(id), t.ms || 5000);
    },
    [dismissToast],
  );

  /* ---------- data loading ---------- */
  const reqId = useRef(0);
  const refreshList = useCallback(async () => {
    const mine = ++reqId.current;
    try {
      const r = await api.list(paramsRef.current);
      if (mine === reqId.current) setList({ items: r.items, total: r.total, loaded: true, error: '' });
    } catch (e) {
      if (mine === reqId.current) setList((l) => ({ ...l, loaded: true, error: e.message }));
    }
  }, []);

  const refreshStats = useCallback(() => api.stats().then(setStats).catch(() => {}), []);
  const refreshMeta = useCallback(async () => {
    const [s, t] = await Promise.allSettled([api.stats(), api.tags()]);
    if (s.status === 'fulfilled') setStats(s.value);
    if (t.status === 'fulfilled') setTags(t.value.tags);
  }, []);

  const loadVoices = useCallback(async () => {
    try {
      const r = await api.voices();
      setVoices(r.voices);
      setLanguages(r.languages);
      setVoicesError('');
    } catch (e) {
      setVoicesError(e.message);
    }
  }, []);

  const loadHealth = useCallback(
    () => api.health().then(setHealth).catch(() => setHealth({ unreachable: true, engine: { status: 'error' } })),
    [],
  );

  useEffect(() => {
    loadHealth();
    refreshMeta();
  }, [loadHealth, refreshMeta]);

  // The model takes a few seconds to load; keep checking until it is up, then fetch the voices.
  const engineStatus = health?.engine?.status;
  useEffect(() => {
    if (engineStatus === 'ready') {
      loadVoices();
      return undefined;
    }
    const t = setInterval(loadHealth, engineStatus === 'starting' ? 1000 : 4000);
    return () => clearInterval(t);
  }, [engineStatus, loadHealth, loadVoices]);

  useEffect(() => {
    refreshList();
  }, [paramsKey, refreshList]);

  // Pick a sensible default voice the first time, or when the saved one no longer exists.
  useEffect(() => {
    if (!health || !voices.length || voices.some((v) => v.voiceId === settings.voiceId)) return;
    const wanted = health.defaultVoiceId;
    const fallback = voices.find((v) => v.voiceId === wanted) ? wanted : voices[0].voiceId;
    setSettings((s) => ({ ...s, voiceId: fallback }));
  }, [health, voices, settings.voiceId, setSettings]);

  // Poll while anything is generating.
  const activeCount = stats?.active ?? 0;
  const anyActive = list.items.some(isActive) || activeCount > 0;
  useEffect(() => {
    if (!anyActive) return undefined;
    const t = setInterval(() => {
      refreshList();
      refreshStats();
    }, 1200);
    return () => clearInterval(t);
  }, [anyActive, refreshList, refreshStats]);

  const prevActive = useRef(0);
  useEffect(() => {
    if (prevActive.current > 0 && activeCount === 0) refreshMeta(); // totals and tags changed
    prevActive.current = activeCount;
  }, [activeCount, refreshMeta]);

  /* ---------- helpers ---------- */
  const voiceName = useCallback(
    (id) => voices.find((v) => v.voiceId === id)?.name || stats?.voices?.find((v) => v.voiceId === id)?.name || id,
    [voices, stats],
  );

  const apiSettings = () => ({ speed: settings.speed, stripMarkdown: settings.stripMarkdown });

  /* ---------- generating ---------- */
  async function generate(items, { force = false } = {}) {
    const handled = new Set();
    let created = 0;
    for (const d of items) {
      try {
        const r = await api.create({
          title: d.title,
          sourceName: d.name,
          text: d.text,
          tags: d.tags,
          voiceId: settings.voiceId,
          voiceName: voiceName(settings.voiceId),
          settings: apiSettings(),
          force,
        });
        handled.add(d.key);
        if (r.duplicate) {
          toast({
            kind: 'info',
            text: `“${d.title}” was already generated with these exact settings.`,
            ms: 8000,
            actions: [
              { label: 'Open it', run: () => setSelected({ id: r.generation.id, autoplay: false }) },
              { label: 'Generate again', run: () => generate([d], { force: true }) },
            ],
          });
        } else {
          created += 1;
        }
      } catch (e) {
        toast({ kind: 'error', text: `${d.title}: ${e.message}`, ms: 10000 });
      }
    }
    if (created) toast({ kind: 'success', text: created === 1 ? 'Queued 1 script.' : `Queued ${created} scripts.` });
    await Promise.all([refreshList(), refreshStats()]);
    return handled;
  }

  async function addFiles(files) {
    const accepted = [];
    const skipped = [];
    for (const f of files) {
      if (!TEXT_FILE.test(f.name) && !f.type.startsWith('text/')) {
        skipped.push(f.name);
        continue;
      }
      const text = await f.text();
      if (!text.trim()) {
        skipped.push(`${f.name} (empty)`);
        continue;
      }
      accepted.push({ key: uid(), name: f.name, title: stripExt(f.name), text });
    }
    if (skipped.length) {
      toast({ kind: 'error', text: `Skipped ${skipped.join(', ')}. Only .txt and .md files are supported.` });
    }
    if (!accepted.length) return;
    if (autoGenerate) await generate(accepted);
    else setDrafts((d) => [...d, ...accepted]);
  }
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  async function generateDrafts() {
    const batch = drafts;
    const handled = await generate(batch);
    setDrafts((ds) => ds.filter((d) => !handled.has(d.key)));
  }

  async function addPasted({ title, text, now }) {
    const draft = { key: uid(), name: null, title: title.trim() || 'Pasted script', text };
    if (now) await generate([draft]);
    else setDrafts((d) => [...d, draft]);
  }

  // Dropping files anywhere on the page works.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFilesRef.current([...e.dataTransfer.files]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  /* ---------- library actions ---------- */
  async function toggleFavorite(g) {
    setList((l) => ({ ...l, items: l.items.map((i) => (i.id === g.id ? { ...i, favorite: !g.favorite } : i)) }));
    try {
      await api.patch(g.id, { favorite: !g.favorite });
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
    refreshList();
  }

  async function removeItem(g) {
    if (!window.confirm(`Delete “${g.title}” and its audio file? This cannot be undone.`)) return;
    try {
      await api.remove(g.id);
      if (selected?.id === g.id) setSelected(null);
      await Promise.all([refreshList(), refreshMeta()]);
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
  }

  const act = (fn) => async (g) => {
    try {
      await fn(g.id);
    } catch (e) {
      toast({ kind: 'error', text: e.message });
    }
    await Promise.all([refreshList(), refreshStats()]);
  };
  const cancelItem = act(api.cancel);
  const retryItem = act(api.retry);

  // Re-run a stored script with the voice and settings currently selected on the left.
  function regenerate(g, fullText) {
    return generate([{ key: uid(), title: g.title, name: g.sourceName, text: fullText, tags: g.tags }], { force: true });
  }

  const patchItem = async (id, body) => {
    const updated = await api.patch(id, body);
    refreshList();
    if (body.tags !== undefined) api.tags().then((t) => setTags(t.tags)).catch(() => {});
    return updated;
  };

  return (
    <div className="app">
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <strong>Drop to {autoGenerate ? 'generate audio' : 'add to the batch'}</strong>
            <span>.txt and .md files, as many as you like</span>
          </div>
        </div>
      )}

      <Header health={health} stats={stats} />

      {engineStatus === 'error' && (
        <div className="banner error" role="alert">
          <strong>{health.unreachable ? 'Cannot reach the TTS Studio server.' : 'The Kokoro voice engine is not running.'}</strong>{' '}
          {health.unreachable ? (
            <>Start it with <code>npm run dev</code> (or <code>npm start</code>). This page reconnects on its own.</>
          ) : (
            <>{health.engine.error} This page picks it up on its own once it is fixed.</>
          )}
        </div>
      )}

      <div className="layout">
        <Composer
          health={health}
          voices={voices}
          languages={languages}
          voicesError={voicesError}
          settings={settings}
          setSettings={setSettings}
          defaults={DEFAULT_SETTINGS}
          autoGenerate={autoGenerate}
          setAutoGenerate={setAutoGenerate}
          drafts={drafts}
          setDrafts={setDrafts}
          dragging={dragging}
          onFiles={(files) => addFiles(files)}
          onPaste={addPasted}
          onGenerate={generateDrafts}
        />
        <Library
          list={list}
          filters={filters}
          setFilters={(f) => {
            setLimit(30);
            setFilters(f);
          }}
          stats={stats}
          tags={tags}
          selectedId={selected?.id}
          onOpen={(id, autoplay = false) => setSelected({ id, autoplay })}
          onFavorite={toggleFavorite}
          onDelete={removeItem}
          onCancel={cancelItem}
          onRetry={retryItem}
          onMore={() => setLimit((n) => n + 30)}
        />
      </div>

      {selected && (
        <Drawer
          id={selected.id}
          autoplay={selected.autoplay}
          summary={list.items.find((i) => i.id === selected.id)}
          query={params.q}
          allTags={tags}
          onClose={() => setSelected(null)}
          onPatch={patchItem}
          onFavorite={toggleFavorite}
          onDelete={removeItem}
          onCancel={cancelItem}
          onRetry={retryItem}
          onRegenerate={regenerate}
          toast={toast}
        />
      )}

      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
