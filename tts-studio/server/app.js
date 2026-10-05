import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { toApi } from './db.js';
import { cleanText, countWords, slugify } from './text.js';
import { EngineError, MODEL_ID } from './kokoro.js';

export const MAX_CHARS = 200_000;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function normalizeSettings(s = {}) {
  return {
    speed: clamp(s.speed, 0.5, 2, 1),
    stripMarkdown: s.stripMarkdown !== false,
  };
}

export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  for (const t of raw) {
    const tag = String(t).toLowerCase().replace(/[,\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (tag) seen.add(tag);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function deriveTitle(text) {
  const first = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first || 'Untitled script';
}

export function createApp({ getConfig, store, runner, engine, distDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  const api = express.Router();

  /** Reject voices Kokoro cannot speak. Returns the catalog entry once the engine has loaded. */
  function checkVoice(voiceId) {
    const { status, error } = engine.info();
    if (status === 'error') throw httpError(503, error);
    if (!/^[a-z]{2}_[a-z0-9_]{1,40}$/.test(voiceId)) throw httpError(400, 'That voice id looks invalid.');
    if (status !== 'ready') return null; // still loading; the worker checks again when the job runs
    const { voices, languages } = engine.catalog();
    const voice = voices.find((v) => v.voiceId === voiceId);
    if (!voice) throw httpError(400, `Kokoro has no voice called “${voiceId}”.`);
    const language = languages.find((l) => l.code === voice.lang);
    if (language && !language.available) throw httpError(400, `${language.name} voices are not set up. ${language.hint}`);
    return voice;
  }

  const previews = new Map(); // voice id -> in-flight preview render
  let lastStart = 0;

  api.get('/health', (req, res) => {
    // Bring the engine up if it is down, so a finished `npm run setup` or a crash
    // recovers without restarting the server. Spaced out so a broken install is not hammered.
    if (engine.info().status !== 'ready' && Date.now() - lastStart > 10_000) {
      lastStart = Date.now();
      engine.start().catch(() => {});
    }
    res.json({
      ok: true,
      engine: engine.info(),
      defaultVoiceId: getConfig().defaultVoiceId,
      maxChars: MAX_CHARS,
    });
  });

  api.get('/voices', async (req, res) => {
    await engine.start();
    const { voices, languages } = engine.catalog();
    res.json({ voices, languages });
  });

  // A short sample of each voice, rendered on first request and kept on disk.
  api.get('/voices/:id/preview', async (req, res) => {
    await engine.start();
    const { voices, languages, samples } = engine.catalog();
    const voice = voices.find((v) => v.voiceId === req.params.id);
    if (!voice) throw httpError(404, 'Unknown voice');
    const language = languages.find((l) => l.code === voice.lang);
    if (language && !language.available) throw httpError(400, `${language.name} voices are not set up. ${language.hint}`);
    const file = store.previewPath(voice.voiceId);
    if (!fs.existsSync(file)) {
      if (!previews.has(voice.voiceId)) {
        const tmp = `${file}.tmp`;
        const job = engine
          .synthesize({ text: samples[voice.lang], voice: voice.voiceId, out: tmp })
          .then(() => fs.renameSync(tmp, file))
          .finally(() => previews.delete(voice.voiceId));
        previews.set(voice.voiceId, job);
      }
      await previews.get(voice.voiceId);
    }
    res.type('audio/mpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  api.get('/stats', (req, res) => res.json(store.stats()));
  api.get('/tags', (req, res) => res.json({ tags: store.tags() }));

  api.get('/generations', (req, res) => {
    const { q, status, voiceId, favorite, tag, sort } = req.query;
    res.json(
      store.list({
        q: q ? String(q) : '',
        status: status ? String(status) : '',
        voiceId: voiceId ? String(voiceId) : '',
        favorite: favorite === '1' || favorite === 'true',
        tag: tag ? String(tag) : '',
        sort: sort ? String(sort) : '',
        limit: Number(req.query.limit) || 30,
        offset: Number(req.query.offset) || 0,
      }),
    );
  });

  api.get('/generations/:id', (req, res) => {
    const g = store.get(req.params.id, { withText: true });
    if (!g) throw httpError(404, 'Not found');
    res.json(g);
  });

  api.post('/generations', (req, res) => {
    const b = req.body || {};
    const rawText = typeof b.text === 'string' ? b.text : '';
    if (!rawText.trim()) throw httpError(400, 'The script is empty.');

    const settings = normalizeSettings(b.settings);
    const cleaned = cleanText(rawText, { stripMarkdown: settings.stripMarkdown });
    if (!cleaned) throw httpError(400, 'Nothing speakable is left after cleanup.');
    if (cleaned.length > MAX_CHARS) {
      throw httpError(413, `Script is ${cleaned.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
    }

    const voiceId = String(b.voiceId || getConfig().defaultVoiceId).trim();
    const voice = checkVoice(voiceId);

    const configHash = sha(JSON.stringify([cleaned, voiceId, MODEL_ID, settings]));
    if (!b.force) {
      const existing = store.findByConfig(configHash);
      if (existing) return res.json({ duplicate: true, generation: toApi(existing) });
    }

    const id = crypto.randomUUID();
    const title = String(b.title || '').trim().slice(0, 120) || deriveTitle(cleaned);
    store.insert({
      id,
      title,
      source_name: b.sourceName ? String(b.sourceName).slice(0, 200) : null,
      text: rawText,
      text_hash: sha(cleaned),
      config_hash: configHash,
      char_count: cleaned.length,
      word_count: countWords(cleaned),
      voice_id: voiceId,
      voice_name: voice?.name || (b.voiceName ? String(b.voiceName).slice(0, 100) : null),
      model_id: MODEL_ID,
      settings_json: JSON.stringify(settings),
      status: 'queued',
      tags: normalizeTags(b.tags).join(','),
      created_at: Date.now(),
    });
    runner.enqueue(id);
    res.status(201).json({ duplicate: false, generation: store.get(id) });
  });

  api.patch('/generations/:id', (req, res) => {
    if (!store.getRaw(req.params.id)) throw httpError(404, 'Not found');
    const b = req.body || {};
    const patch = {};
    if (b.title !== undefined) {
      const title = String(b.title).trim().slice(0, 120);
      if (!title) throw httpError(400, 'Title cannot be empty.');
      patch.title = title;
    }
    if (b.tags !== undefined) patch.tags = normalizeTags(b.tags).join(',');
    if (b.favorite !== undefined) patch.favorite = b.favorite ? 1 : 0;
    store.update(req.params.id, patch);
    res.json(store.get(req.params.id));
  });

  api.post('/generations/:id/retry', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (!['error', 'cancelled'].includes(row.status)) throw httpError(409, 'Only failed or cancelled items can be retried.');
    checkVoice(row.voice_id);
    store.update(row.id, { status: 'queued', error: null, progress_done: 0, finished_at: null });
    runner.enqueue(row.id);
    res.json(store.get(row.id));
  });

  api.post('/generations/:id/cancel', (req, res) => {
    if (!store.getRaw(req.params.id)) throw httpError(404, 'Not found');
    runner.cancel(req.params.id);
    res.json(store.get(req.params.id));
  });

  api.delete('/generations/:id', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    runner.cancel(row.id);
    store.remove(row.id);
    for (const f of [store.audioPath(row.id), `${store.audioPath(row.id)}.tmp`]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* no file to remove */
      }
    }
    res.json({ ok: true });
  });

  api.get('/generations/:id/audio', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row || row.status !== 'done') throw httpError(404, 'Audio not available');
    const file = store.audioPath(row.id);
    if (!fs.existsSync(file)) throw httpError(404, 'Audio file is missing on disk');
    if (req.query.download) {
      res.attachment(`${slugify(row.title)}.mp3`);
    }
    res.type('audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' }); // sendFile handles Range requests, so seeking works
  });

  api.get('/generations/:id/script', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (req.query.download) res.attachment(`${slugify(row.title, 'script')}.txt`);
    res.type('text/plain; charset=utf-8').send(row.text);
  });

  api.use((req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use('/api', api);

  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else {
    app.get('/', (req, res) =>
      res
        .type('html')
        .send(
          '<h3>TTS Studio API is running.</h3><p>The web UI is not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> and open http://localhost:5173.</p>',
        ),
    );
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err instanceof EngineError ? 503 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Server error' });
  });

  return app;
}
