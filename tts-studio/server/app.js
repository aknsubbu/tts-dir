import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { toApi } from './db.js';
import { cleanText, countWords, slugify } from './text.js';
import { EngineError, MODEL_ID } from './kokoro.js';
import { listProjects, makePoster, PROJECT_NAME, readProject } from './video.js';
import { NotesError, saveAttachments } from './notes.js';
import { localOnly } from './local.js';
import { LESSON_MINUTES, MAX_NOTES, VIDEO_QUALITIES } from '../shared/limits.js';

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

export function createApp({ getConfig, store, runner, engine, lessons, distDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly());
  // A lesson may carry photos and PDFs of notes, so that one route takes a larger body.
  const smallJson = express.json({ limit: '8mb' });
  const lessonJson = express.json({ limit: '48mb' });
  app.use((req, res, next) => (req.path === '/api/lessons' ? lessonJson : smallJson)(req, res, next));

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
  const posters = new Map(); // generation id -> in-flight poster
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
    const { q, status, voiceId, favorite, tag, sort, kind } = req.query;
    res.json(
      store.list({
        q: q ? String(q) : '',
        status: status ? String(status) : '',
        voiceId: voiceId ? String(voiceId) : '',
        favorite: favorite === '1' || favorite === 'true',
        tag: tag ? String(tag) : '',
        kind: ['audio', 'video'].includes(kind) ? kind : '',
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

  // Narrated videos: video/projects/<name>, built by video/build.py through the same queue.
  api.get('/video/projects', (req, res) => {
    const { videoDir } = getConfig();
    const projects = videoDir ? listProjects(videoDir) : [];
    res.json({ projects: projects.map(({ name, voice, speed, scenes }) => ({ name, voice, speed, scenes })) });
  });

  api.post('/videos', (req, res) => {
    const b = req.body || {};
    const { videoDir } = getConfig();
    const project = videoDir ? readProject(videoDir, String(b.project || '')) : null;
    if (!project) throw httpError(404, `No video project called “${b.project}”.`);
    if (!project.scenes.length) throw httpError(400, `Project “${project.name}” lists no scenes in project.json.`);
    const quality = VIDEO_QUALITIES.includes(b.quality) ? b.quality : 'default';
    const id = crypto.randomUUID();
    store.insert({
      id,
      kind: 'video',
      title: String(b.title || '').trim().slice(0, 120) || `${project.name} (video)`,
      source_name: `video/projects/${project.name}`,
      text: project.script,
      text_hash: sha(project.script),
      config_hash: sha(`video:${id}`), // every build is new: the scenes may have changed
      char_count: project.script.length,
      word_count: countWords(project.script),
      voice_id: project.voice,
      voice_name: engine.catalog().voices.find((v) => v.voiceId === project.voice)?.name || null,
      model_id: MODEL_ID,
      settings_json: JSON.stringify({ project: project.name, quality, speed: project.speed, scenes: project.scenes }),
      status: 'queued',
      tags: normalizeTags(b.tags ?? ['video']).join(','),
      created_at: Date.now(),
    });
    runner.enqueue(id);
    res.status(201).json({ generation: store.get(id) });
  });

  // A lesson: Claude writes the script and the scenes from a topic and notes, then it is built
  // like any other video. The row exists from the start so the library shows each stage.
  api.post('/lessons', async (req, res) => {
    if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
    const b = req.body || {};
    const topic = String(b.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const goal = String(b.goal || '').trim().slice(0, 2000);
    const notes = String(b.notes || '').trim();
    if (!topic) throw httpError(400, 'Say what the video should be about.');
    if (notes.length > MAX_NOTES) throw httpError(400, `Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters; these have ${notes.length.toLocaleString('en-US')}.`);
    const voiceId = String(b.voiceId || getConfig().defaultVoiceId);
    checkVoice(voiceId);
    // Marks need word timings, which only the English voices have.
    if (!/^[ab]/.test(voiceId)) throw httpError(400, 'Lessons need an English voice, so animations can follow individual words.');
    const minutes = LESSON_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : 2;
    const quality = VIDEO_QUALITIES.includes(b.quality) ? b.quality : 'default';
    const id = crypto.randomUUID();
    const project = `${slugify(topic, 'lesson').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'lesson'}-${id.slice(0, 6)}`;
    const ownTitle = String(b.title || '').trim().slice(0, 120);
    // Photos, PDFs and documents are saved into the project now, so only their names travel on
    // to the lesson writer. Documents become text and join the typed notes.
    let attached;
    try {
      attached = await saveAttachments(path.join(getConfig().videoDir, 'projects', project), b.attachments);
    } catch (e) {
      if (e instanceof NotesError) throw httpError(400, e.message);
      throw e;
    }
    const allNotes = [notes, attached.text].filter(Boolean).join('\n\n');
    if (allNotes.length > MAX_NOTES) {
      fs.rmSync(path.join(getConfig().videoDir, 'projects', project), { recursive: true, force: true });
      throw httpError(400, `With the attached documents the notes come to ${allNotes.length.toLocaleString('en-US')} characters; the limit is ${MAX_NOTES.toLocaleString('en-US')}. Attach a long document as a PDF instead.`);
    }
    const brief = [topic, goal, allNotes].filter(Boolean).join('\n\n');
    store.insert({
      id,
      kind: 'video',
      title: ownTitle || topic.slice(0, 120),
      source_name: `video/projects/${project}`,
      text: brief,
      text_hash: sha(brief),
      config_hash: sha(`lesson:${id}`),
      char_count: brief.length,
      word_count: countWords(brief),
      voice_id: voiceId,
      voice_name: engine.catalog().voices.find((v) => v.voiceId === voiceId)?.name || null,
      model_id: MODEL_ID,
      settings_json: JSON.stringify({
        project, quality, speed: 1, scenes: [],
        lesson: { topic, goal, minutes, ownTitle: !!ownTitle, attachments: attached.files.map(({ name, file, kind }) => ({ name, file, kind })) },
      }),
      status: 'queued',
      tags: normalizeTags(b.tags ?? ['lesson']).join(','),
      created_at: Date.now(),
    });
    await lessons.start(id, { topic, goal, notes: allNotes, minutes, voice: voiceId, attachments: attached.files });
    res.status(201).json({ generation: store.get(id) });
  });

  api.get('/generations/:id/video', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row || row.kind !== 'video' || row.status !== 'done') throw httpError(404, 'Video not available');
    const file = store.videoPath(row.id);
    if (!fs.existsSync(file)) throw httpError(404, 'Video file is missing on disk');
    if (req.query.download) res.attachment(`${slugify(row.title)}.mp4`);
    res.type('video/mp4');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  // A still from the video, for its card. A video built before posters existed gets one
  // made the first time its card is shown.
  api.get('/generations/:id/poster', async (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row || row.kind !== 'video' || row.status !== 'done') throw httpError(404, 'No poster');
    const file = store.videoPath(row.id, 'jpg');
    if (!fs.existsSync(file)) {
      const video = store.videoPath(row.id);
      if (!fs.existsSync(video)) throw httpError(404, 'No poster');
      if (!posters.has(row.id)) {
        posters.set(row.id, makePoster(video, file, row.duration_sec).finally(() => posters.delete(row.id)));
      }
      if (!(await posters.get(row.id))) throw httpError(404, 'No poster');
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  // One of the images or PDFs attached to a lesson's notes.
  api.get('/generations/:id/notes/:file', (req, res) => {
    const row = store.getRaw(req.params.id);
    const settings = row ? JSON.parse(row.settings_json) : null;
    const wanted = settings?.lesson?.attachments?.find((a) => path.basename(a.file) === req.params.file);
    if (!wanted) throw httpError(404, 'No such file');
    const file = path.join(getConfig().videoDir, 'projects', settings.project, 'notes', path.basename(wanted.file));
    if (!fs.existsSync(file)) throw httpError(404, 'That file is no longer on disk');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  api.get('/generations/:id/captions.:ext', (req, res) => {
    const row = store.getRaw(req.params.id);
    const ext = req.params.ext;
    if (!row || row.kind !== 'video' || row.status !== 'done' || !['srt', 'vtt'].includes(ext)) throw httpError(404, 'Captions not available');
    const file = store.videoPath(row.id, ext);
    if (!fs.existsSync(file)) throw httpError(404, 'Captions file is missing on disk');
    if (req.query.download) res.attachment(`${slugify(row.title)}.${ext}`);
    res.type(ext === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.sendFile(file, { dotfiles: 'allow' });
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

  api.post('/generations/:id/retry', async (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (!['error', 'cancelled'].includes(row.status)) throw httpError(409, 'Only failed or cancelled items can be retried.');
    if (row.kind !== 'video') checkVoice(row.voice_id); // a video's voice is checked by its build
    const settings = JSON.parse(row.settings_json);
    if (settings.lesson && lessons && !lessons.isWritten(settings.project)) {
      // Claude never finished this one: go back to the writer, which picks up where it stopped.
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    store.update(row.id, { status: 'queued', error: null, progress_done: 0, finished_at: null });
    runner.enqueue(row.id);
    res.json(store.get(row.id));
  });

  api.post('/generations/:id/cancel', (req, res) => {
    if (!store.getRaw(req.params.id)) throw httpError(404, 'Not found');
    if (!runner.cancel(req.params.id)) lessons?.cancel(req.params.id);
    res.json(store.get(req.params.id));
  });

  api.delete('/generations/:id', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (!runner.cancel(row.id)) lessons?.cancel(row.id);
    store.remove(row.id);
    // ?project=1 also removes the folder a lesson was written into: its script, scenes, notes
    // and attached files. Only for lessons, whose folder this server made; a project you wrote
    // by hand is never touched. Skipped while another library item was built from the same folder.
    const settings = JSON.parse(row.settings_json);
    let projectRemoved = false;
    if (['1', 'true'].includes(String(req.query.project)) && settings.lesson && PROJECT_NAME.test(String(settings.project))) {
      if (!store.countBySource(row.source_name)) {
        fs.rmSync(path.join(getConfig().videoDir, 'projects', settings.project), { recursive: true, force: true });
        projectRemoved = true;
      }
    }
    const files = [store.audioPath(row.id), `${store.audioPath(row.id)}.tmp`, ...['mp4', 'srt', 'vtt', 'jpg'].map((e) => store.videoPath(row.id, e))];
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* no file to remove */
      }
    }
    res.json({ ok: true, projectRemoved });
  });

  api.get('/generations/:id/audio', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row || row.status !== 'done' || row.kind === 'video') throw httpError(404, 'Audio not available');
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
