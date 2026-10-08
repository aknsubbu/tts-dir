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
import { RENDER_EXTS, stillsOf } from './versions.js';
import { createEdits, EditError } from './edits.js';
import { actorOf, settingsRoutes } from './settings-routes.js';
import { SettingsError } from './settings.js';
import { CHAPTERS_FROM, LESSON_MINUTES, MAX_NOTES, VIDEO_QUALITIES } from '../shared/limits.js';
import { normalizeOutline } from '../author/pipeline.js';
import { chaptersOf } from './versions.js';

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

export function createApp({ getConfig, store, runner, engine, lessons, versions = null, settings = null, secrets = null, mcp = null, distDir }) {
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

  // Live updates: every change to an item, as Server-Sent Events. Progress can change many times
  // a second, so each item is sent at most every 200 ms, with its latest state.
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const due = new Map(); // id -> timer
    const send = (id) => {
      due.delete(id);
      const g = store.get(id);
      res.write(`event: generation\ndata: ${JSON.stringify(g || { id, deleted: true })}\n\n`);
    };
    const onChange = (id) => {
      if (!due.has(id)) due.set(id, setTimeout(() => send(id), 200));
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    store.events.on('change', onChange);
    req.on('close', () => {
      store.events.off('change', onChange);
      clearInterval(ping);
      for (const t of due.values()) clearTimeout(t);
    });
  });
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
  // A lesson: Claude (or the writer chosen in Settings) writes the script and the scenes from a
  // topic and notes, then it is built like any other video. The row exists from the start so the
  // library shows each stage. Lessons Claude starts through MCP use profile "claude": its own
  // writer and defaults, when Settings gives it some.
  api.post('/lessons', async (req, res) => {
    if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
    const b = req.body || {};
    const profile = b.profile === 'claude' || actorOf(req) === 'claude' ? 'claude' : 'page';
    const defaults = settings ? settings.lessonDefaults(profile) : { minutes: 2, quality: 'default', review: getConfig().lessonReview || 'render', voiceId: getConfig().defaultVoiceId };
    const topic = String(b.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const goal = String(b.goal || '').trim().slice(0, 2000);
    const notes = String(b.notes || '').trim();
    if (!topic) throw httpError(400, 'Say what the video should be about.');
    if (notes.length > MAX_NOTES) throw httpError(400, `Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters; these have ${notes.length.toLocaleString('en-US')}.`);
    const voiceId = String(b.voiceId || defaults.voiceId || getConfig().defaultVoiceId);
    checkVoice(voiceId);
    // Marks need word timings, which only the English voices have.
    if (!/^[ab]/.test(voiceId)) throw httpError(400, 'Lessons need an English voice, so animations can follow individual words.');
    const minutes = LESSON_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : defaults.minutes;
    // From CHAPTERS_FROM minutes a lesson is written in chapters, after an outline you can review.
    const chaptered = minutes >= CHAPTERS_FROM;
    const outlineReview = chaptered && b.outlineReview !== false;
    const titleCards = chaptered ? b.titleCards !== false : undefined;
    const quality = VIDEO_QUALITIES.includes(b.quality) ? b.quality : defaults.quality;
    // "storyboard" stops before rendering so the lesson can be looked at first; "script" stops
    // after the narration, so the scenes are written only for a narration you approve. A lesson
    // in chapters is reviewed at its outline instead of its narration.
    let review = ['render', 'storyboard', 'script'].includes(b.review) ? b.review : defaults.review || 'render';
    if (chaptered && review === 'script') review = 'render';
    const visualReview = b.visualReview === undefined ? (settings ? defaults.visualReview : undefined) : Boolean(b.visualReview);
    // A writer chosen for this lesson alone: one provider set up in Settings, for every step.
    const override = b.writer?.provider ? { provider: String(b.writer.provider).slice(0, 40), model: String(b.writer.model || '').slice(0, 200) } : null;
    if (settings) {
      try {
        if (override && !settings.provider(override.provider)) throw new SettingsError(`There is no provider called “${override.provider}”.`);
        await settings.checkWriter(settings.resolveWriter(profile, override));
        const { monthCapUsd } = settings.costs();
        if (monthCapUsd != null && store.stats().costThisMonthUsd >= monthCapUsd) {
          throw new SettingsError(`This month's lessons have reached the monthly cap of $${monthCapUsd.toFixed(2)}. Raise it in Settings → Costs, or choose a free writer.`);
        }
      } catch (e) {
        if (e instanceof SettingsError) throw httpError(400, e.message);
        throw e;
      }
    }
    const id = crypto.randomUUID();
    const project = `${slugify(topic, 'lesson').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'lesson'}-${id.slice(0, 6)}`;
    const ownTitle = String(b.title || '').trim().slice(0, 120);
    // Photos, PDFs and documents are saved into the project now, so only their names travel on
    // to the lesson writer. Documents, and PDFs sent as text, become text and join the typed notes.
    let attached;
    try {
      attached = await saveAttachments(path.join(getConfig().videoDir, 'projects', project), b.attachments, { maxEdge: getConfig().notesImageEdge });
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
        lesson: {
          topic, goal, minutes, review, ownTitle: !!ownTitle,
          attachments: attached.files.map(({ name, file, kind, pages, asText }) => ({ name, file, kind, ...(pages ? { pages } : {}), ...(asText ? { asText } : {}) })),
          ...(profile === 'claude' ? { profile } : {}),
          ...(override ? { writer: override } : {}),
          ...(chaptered ? { chaptered, outlineReview } : {}),
        },
      }),
      status: 'queued',
      tags: normalizeTags(b.tags ?? ['lesson']).join(','),
      created_at: Date.now(),
    });
    await lessons.start(id, { topic, goal, notes: allNotes, minutes, voice: voiceId, attachments: attached.files.filter((f) => !f.asText), visualReview, ...(chaptered ? { titleCards } : {}) });
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
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (row.status === 'awaiting') {
      // Waiting on the person: cancelling means "don't render it". Retry renders it after all.
      store.update(row.id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    } else if (!runner.cancel(row.id)) {
      lessons?.cancel(row.id);
    }
    res.json(store.get(req.params.id));
  });

  // A lesson waiting on you: { action: "render" } renders it after its storyboard, optionally at
  // another quality; { action: "scenes" } has the scenes written for a narration you approved.
  api.post('/generations/:id/approve', async (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    if (row.status !== 'awaiting') throw httpError(409, 'This lesson is not waiting for approval.');
    const b = req.body || {};
    const settings = JSON.parse(row.settings_json);
    const narration = settings.lesson?.phase === 'script';
    if (settings.lesson?.phase === 'outline') {
      // The outline is approved, as it is or as edited here: the chapters are written.
      if ((b.action ?? 'chapters') !== 'chapters') throw httpError(409, 'This lesson is waiting on its outline: approve it with { action: "chapters" }.');
      if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
      if (b.outline) saveOutline(row, b.outline);
      const fresh = JSON.parse(store.getRaw(row.id).settings_json);
      if (VIDEO_QUALITIES.includes(b.quality)) fresh.quality = b.quality;
      fresh.lesson = { ...fresh.lesson, outlineApproved: true, phase: null };
      store.update(row.id, { settings_json: JSON.stringify(fresh) });
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    const action = b.action ?? (narration ? 'scenes' : 'render');
    if (narration) {
      if (action !== 'scenes') throw httpError(409, 'This lesson is waiting on its narration: approve it with { action: "scenes" }.');
      if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
      if (VIDEO_QUALITIES.includes(b.quality)) settings.quality = b.quality;
      settings.lesson = { ...settings.lesson, scriptApproved: true };
      store.update(row.id, { settings_json: JSON.stringify(settings) });
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    if (action !== 'render') throw httpError(400, 'This lesson is waiting on its storyboard: approve it with { action: "render" }.');
    if (VIDEO_QUALITIES.includes(b.quality)) settings.quality = b.quality;
    store.update(row.id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null, settings_json: JSON.stringify(settings) });
    runner.enqueue(row.id);
    res.json(store.get(row.id));
  });

  // A long lesson's outline: read it, change it while it waits for you, or have it redone.
  const outlineFile = (row) => path.join(getConfig().videoDir, 'projects', JSON.parse(row.settings_json).project, 'outline.json');
  function saveOutline(row, raw) {
    let outline;
    try {
      outline = normalizeOutline(raw, { maxChapters: getConfig().maxChapters });
    } catch (e) {
      throw httpError(400, e.message);
    }
    fs.writeFileSync(outlineFile(row), `${JSON.stringify(outline, null, 2)}\n`);
    const settings = JSON.parse(row.settings_json);
    settings.lesson = { ...settings.lesson, chapters: outline.chapters.map(({ id, title, minutes }) => ({ id, title, minutes })) };
    store.update(row.id, {
      settings_json: JSON.stringify(settings),
      ...(settings.lesson.ownTitle ? {} : { title: outline.title.slice(0, 120) }),
      stage: `Outline ready: ${outline.chapters.length} chapters, about ${outline.chapters.reduce((t, c) => t + c.minutes, 0)} minutes`,
    });
    return outline;
  }
  const waitingOnOutline = (row) => {
    if (!row) throw httpError(404, 'Not found');
    if (row.status !== 'awaiting' || JSON.parse(row.settings_json).lesson?.phase !== 'outline') throw httpError(409, 'The outline can be changed only while it waits for you, before the chapters are written.');
  };

  api.get('/generations/:id/outline', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    let outline;
    try {
      outline = JSON.parse(fs.readFileSync(outlineFile(row), 'utf8'));
    } catch {
      throw httpError(404, 'This lesson has no outline.');
    }
    const root = path.dirname(outlineFile(row));
    res.json({
      ...outline,
      chapters: outline.chapters.map((c) => ({ ...c, written: fs.existsSync(path.join(root, 'chapters', c.id, 'author.json')) })),
      waiting: row.status === 'awaiting' && JSON.parse(row.settings_json).lesson?.phase === 'outline',
    });
  });

  api.put('/generations/:id/outline', (req, res) => {
    const row = store.getRaw(req.params.id);
    waitingOnOutline(row);
    res.json({ outline: saveOutline(row, req.body?.outline || req.body), generation: store.get(row.id) });
  });

  api.post('/generations/:id/outline/redo', async (req, res) => {
    const row = store.getRaw(req.params.id);
    waitingOnOutline(row);
    const request = String(req.body?.request || '').trim();
    if (!request) throw httpError(400, 'Say what to change in the outline.');
    await lessons.start(row.id, undefined, { phase: 'outline', redo: request.slice(0, 2000) });
    res.json(store.get(row.id));
  });

  // Ask for a change to a written lesson. The writer answers with only what changes; the result is
  // checked, becomes the next version, and renders (or waits at its storyboard with review).
  api.post('/generations/:id/revise', async (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    const settings = JSON.parse(row.settings_json);
    if (!settings.lesson || !lessons) throw httpError(403, 'Only lessons can be revised. A project written by hand is edited in its folder.');
    if (['queued', 'processing'].includes(row.status)) throw httpError(409, 'This lesson is being written, checked or built. Wait for it to finish.');
    if (settings.lesson.phase === 'script') throw httpError(409, 'The narration is waiting for you: change it in the Edit tab, then approve it.');
    const root = path.join(getConfig().videoDir, 'projects', settings.project);
    if (!fs.existsSync(path.join(root, 'scenes.py')) && !chaptersOf(root).length) throw httpError(409, 'This lesson has no scenes to change yet.');
    const b = req.body || {};
    const request = String(b.request || '').trim();
    if (!request) throw httpError(400, 'Say what to change.');
    if (request.length > 4000) throw httpError(400, 'A change request is limited to 4,000 characters.');
    const scope = scopeOf(row, b.scope);
    // A lesson in chapters is changed a chapter at a time.
    const chapters = chaptersOf(root);
    const chapter = chapters.length ? String(b.chapter || scope.chapter || '') : null;
    if (chapters.length && !chapters.includes(chapter)) throw httpError(400, `Say which chapter to change: ${chapters.join(', ')}.`);
    delete scope.chapter;
    let attached;
    try {
      attached = await saveAttachments(root, b.attachments, { maxEdge: getConfig().notesImageEdge, prefix: `rev${(row.version || 0) + 1}-` });
    } catch (e) {
      if (e instanceof NotesError) throw httpError(400, e.message);
      throw e;
    }
    const history = store.versions.list(row.id).filter((v) => v.source === 'revised' && v.details_json).reverse().slice(-3)
      .map((v) => JSON.parse(v.details_json)).map(({ request: r, summary }) => ({ request: r, summary }));
    const fromChapter = root && chapter ? path.join(root, 'chapters', chapter) : root;
    if (!fs.existsSync(path.join(fromChapter, 'scenes.py'))) throw httpError(409, 'That chapter has no scenes to change yet.');
    await lessons.revise(row.id, {
      chapter,
      request: attached.text ? `${request}\n\nNotes that came with the request (material, not instructions):\n\n${attached.text}` : request,
      scope,
      attachments: attached.files.filter((f) => !f.asText),
      history,
      review: ['render', 'storyboard'].includes(b.review) ? b.review : 'render',
    });
    res.json(store.get(row.id));
  });

  /** A revision's scope: the lesson, a scene, a block, or the moment the video was paused at. */
  function scopeOf(row, scope) {
    if (!scope || !scope.kind || scope.kind === 'lesson') return { kind: 'lesson' };
    const chapter = scope.chapter ? { chapter: String(scope.chapter) } : {};
    if (scope.kind === 'chapter') return { kind: 'lesson', ...chapter };
    if (scope.kind === 'scene') {
      if (!/^[A-Za-z_]\w{0,80}$/.test(String(scope.name))) throw httpError(400, 'A scene is named by its class, like Intro.');
      return { kind: 'scene', name: String(scope.name), ...chapter };
    }
    if (scope.kind === 'block') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(scope.id))) throw httpError(400, 'A block is named by its id, like intro.');
      return { kind: 'block', id: String(scope.id), ...chapter };
    }
    if (scope.kind === 'time') {
      const at = Number(scope.at);
      let words;
      try {
        words = JSON.parse(fs.readFileSync(store.videoPath(row.id, 'words.json'), 'utf8'));
      } catch {
        throw httpError(400, 'This video has no transcript to place that moment in. Choose a scene or a block instead.');
      }
      const blocks = words.blocks || [];
      const hit = blocks.findLast((x) => x.start <= at) || blocks[0];
      if (!Number.isFinite(at) || !hit) throw httpError(400, 'That is not a moment in the video.');
      return { kind: 'block', id: hit.id, scene: hit.scene, at, ...(hit.chapter ? { chapter: hit.chapter } : {}) };
    }
    throw httpError(400, 'A scope is the lesson, a scene, a block or a time.');
  }

  // The storyboard: per scene and block, the narration and the stills the check took. The
  // working copy's by default (the last check), or a version's with ?version=n.
  const storyboardOf = (req) => {
    const row = store.getRaw(req.params.id);
    if (!row || row.kind !== 'video' || !versions) throw httpError(404, 'Not found');
    const version = req.query.version ? Number(req.query.version) : 0;
    if (req.query.version && !(Number.isInteger(version) && version > 0)) throw httpError(400, 'A version is a whole number.');
    const chapter = req.query.chapter ? String(req.query.chapter) : null;
    const found = versions.storyboard(row, version, chapter);
    if (!found) throw httpError(404, 'No storyboard yet. It appears once the scenes have been checked.');
    return { row, version, chapter, ...found };
  };

  api.get('/generations/:id/storyboard', (req, res) => {
    const { row, version, chapter, board } = storyboardOf(req);
    const params = new URLSearchParams({ ...(version ? { version: String(version) } : {}), ...(chapter ? { chapter } : {}) }).toString();
    const q = params ? `?${params}` : '';
    const still = (s) => ({ ...s, url: `/api/generations/${row.id}/storyboard/${encodeURIComponent(path.basename(String(s.file)))}${q}` });
    res.json({
      ...board,
      version: version || null,
      scenes: (board.scenes || []).map((scene) => ({
        ...scene,
        endUrl: scene.end ? still({ file: scene.end }).url : null,
        blocks: (scene.blocks || []).map((b) => ({
          ...b,
          stills: (b.stills || []).map(still),
          // Narration is only on disk for the working copy: an edit re-speaks and drops old blocks.
          audioUrl: version ? null : `/api/generations/${row.id}/narration/${encodeURIComponent(b.id)}${chapter ? `?chapter=${encodeURIComponent(chapter)}` : ''}`,
        })),
      })),
    });
  });

  api.get('/generations/:id/storyboard/:file', (req, res) => {
    const { frames, board } = storyboardOf(req);
    const file = String(req.params.file);
    if (!/^[A-Za-z0-9_-]+\.png$/.test(file) || !stillsOf(board).has(file)) throw httpError(404, 'No such still');
    const full = path.join(frames, file);
    if (!fs.existsSync(full)) throw httpError(404, 'That still is no longer on disk');
    res.set('Cache-Control', 'private, max-age=60');
    res.sendFile(full, { dotfiles: 'allow' });
  });

  // One block's narration, as the check spoke it.
  api.get('/generations/:id/narration/:block', (req, res) => {
    const row = store.getRaw(req.params.id);
    const chapter = req.query.chapter ? String(req.query.chapter) : null;
    if (chapter && !/^\d{2}-[a-z0-9-]{1,48}$/.test(chapter)) throw httpError(404, 'Not found');
    const lessonRoot = row && versions?.projectRoot(row);
    const root = lessonRoot && (chapter ? path.join(lessonRoot, 'chapters', chapter) : lessonRoot);
    const block = String(req.params.block);
    if (!root || !/^[A-Za-z0-9_-]{1,80}$/.test(block)) throw httpError(404, 'Not found');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'build', 'manifest.json'), 'utf8'));
    } catch {
      throw httpError(404, 'This lesson has not been spoken yet');
    }
    const wav = manifest.blocks?.[block]?.wav;
    const audio = wav && path.resolve(root, 'build', wav);
    if (!audio || !audio.startsWith(path.resolve(root, 'build', 'audio') + path.sep) || !fs.existsSync(audio)) throw httpError(404, 'No narration for that block');
    res.type('audio/wav');
    res.set('Cache-Control', 'private, max-age=60');
    res.sendFile(audio, { dotfiles: 'allow' });
  });

  // Editing a lesson: its working copy, saved with a quick check, checked in full, rendered as the
  // next version, discarded, or an earlier version restored. See edits.js.
  const edits = versions ? createEdits({ store, versions, getConfig, runner, lessons }) : null;
  const editing = (fn) => async (req, res) => {
    if (!edits) throw httpError(404, 'Not found');
    try {
      res.json(await fn(store.getRaw(req.params.id), req.body || {}, req));
    } catch (e) {
      if (e instanceof EditError) {
        res.status(e.status).json({ error: e.message, ...(e.current ? { current: e.current } : {}) });
        return;
      }
      throw e;
    }
  };
  api.get('/generations/:id/source', editing((row, b, req) => edits.source(row, req.query.chapter ? String(req.query.chapter) : null)));
  api.put('/generations/:id/source', editing((row, b) => edits.save(row, b)));
  api.post('/generations/:id/check', editing((row, b) => edits.check(row, { chapter: b.chapter || null })));
  api.post('/generations/:id/build', editing((row, b) => edits.check(row, { build: true, quality: VIDEO_QUALITIES.includes(b.quality) ? b.quality : null, chapter: b.chapter || null })));
  api.post('/generations/:id/discard', editing((row) => edits.discard(row)));
  api.post('/generations/:id/restore', editing((row, b) => {
    const n = Number(b.version);
    if (!Number.isInteger(n) || n < 1) throw new EditError('Say which version to restore: { version: n }.');
    return edits.restore(row, n);
  }));
  api.get('/generations/:id/versions/:n/source', editing((row, b, req) => edits.versionSource(row, Number(req.params.n), req.query.chapter ? String(req.query.chapter) : null)));

  // A long lesson's chapters as WebVTT, for the player's chapter list.
  api.get('/generations/:id/chapters.vtt', (req, res) => {
    const row = store.getRaw(req.params.id);
    const file = row && store.videoPath(row.id, 'chapters.vtt');
    if (!file || !fs.existsSync(file)) throw httpError(404, 'This video has no chapters.');
    res.type('text/vtt; charset=utf-8').sendFile(file, { dotfiles: 'allow' });
  });

  // Every spoken word of the built video with its time, for the transcript beside the player.
  api.get('/generations/:id/transcript', (req, res) => {
    const row = store.getRaw(req.params.id);
    const file = row && store.videoPath(row.id, 'words.json');
    if (!row || row.kind !== 'video' || (!row.built_version && row.status !== 'done') || !fs.existsSync(file)) throw httpError(404, 'No transcript for this video. Lessons built from now on have one.');
    res.set('Cache-Control', 'private, max-age=60');
    res.type('application/json').sendFile(file, { dotfiles: 'allow' });
  });

  // Where a lesson's files are on this machine, for the MCP connector and anything else local.
  api.get('/generations/:id/files', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    const has = (f) => (fs.existsSync(f) ? f : null);
    const settings = JSON.parse(row.settings_json);
    res.json({
      video: row.kind === 'video' ? has(store.videoPath(row.id)) : null,
      captions: row.kind === 'video' ? { srt: has(store.videoPath(row.id, 'srt')), vtt: has(store.videoPath(row.id, 'vtt')) } : null,
      poster: row.kind === 'video' ? has(store.videoPath(row.id, 'jpg')) : null,
      audio: row.kind !== 'video' ? has(store.audioPath(row.id)) : null,
      project: settings.project ? has(path.join(getConfig().videoDir, 'projects', settings.project)) : null,
    });
  });

  // A lesson's versions, newest first.
  api.get('/generations/:id/versions', (req, res) => {
    const row = store.getRaw(req.params.id);
    if (!row) throw httpError(404, 'Not found');
    res.json({
      current: row.version || 0,
      built: row.built_version || 0,
      versions: store.versions.list(row.id).map((v) => ({
        n: v.n,
        source: v.source,
        note: v.note,
        createdAt: v.created_at,
        costUsd: v.cost_usd,
        usage: v.usage_json ? JSON.parse(v.usage_json) : null,
        checkOk: v.check_ok == null ? null : !!v.check_ok,
        warnings: v.warnings,
        builtAt: v.built_at,
        quality: v.quality,
        durationSec: v.duration_sec,
        renderKept: !!v.render_kept,
        details: v.details_json ? JSON.parse(v.details_json) : null,
      })),
    });
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
    versions?.removeRenders(row.id);
    const files = [store.audioPath(row.id), `${store.audioPath(row.id)}.tmp`, ...RENDER_EXTS.map((e) => store.videoPath(row.id, e))];
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

  if (settings) api.use(settingsRoutes({ settings, secrets, getConfig, store }));

  api.use((req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use('/api', api);

  // The MCP connector over HTTP, for Claude Code: claude mcp add --transport http ... /mcp.
  // Behind the same Host and Origin checks as everything else here.
  if (mcp) app.all('/mcp', mcp);

  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else {
    app.get('/', (req, res) =>
      res
        .type('html')
        .send(
          '<h3>Narrated Proofs API is running.</h3><p>The web UI is not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> and open http://localhost:5173.</p>',
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
