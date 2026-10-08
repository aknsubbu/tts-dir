import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { EFFORTS, WRITER_STEPS } from '../shared/providers.js';
import { CHAPTERS_FROM, LESSON_MINUTES, MAX_FILES, MAX_NOTES, VIDEO_QUALITIES } from '../shared/limits.js';
import { FileRuleError, readNoteFiles } from './files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;
export const DEFAULT_URL = 'http://127.0.0.1:8787';
const ACTOR = { 'X-Narrated-Proofs-Actor': 'claude' };
const WAIT_MS = 50_000;
const MAX_STILLS = 12;

export class DashboardDown extends Error {}

/**
 * The MCP connector: tools over the dashboard's own API, so Claude can make a lesson from a
 * conversation, follow it, search the library, fetch the video, and change the settings it is
 * allowed to. Every request is marked as Claude's, so the dashboard applies Claude's limits.
 *
 *   baseUrl    where the dashboard answers (http://127.0.0.1:8787)
 *   linkBase   what links in answers point at (http://localhost:8787)
 *   onDown     called once when the dashboard does not answer; may start it (TTS_MCP_AUTOSTART)
 */
export function createMcpServer({ baseUrl = DEFAULT_URL, linkBase = baseUrl.replace('127.0.0.1', 'localhost'), cwd = process.cwd(), onDown = null, waitMs = WAIT_MS, pollMs = 1000 } = {}) {
  const server = new McpServer(
    { name: 'narrated-proofs', title: 'Narrated Proofs', version: VERSION },
    {
      instructions: [
        'Narrated Proofs turns a topic and notes into a narrated, animated maths video (a lesson) on this computer.',
        'make_lesson starts one and returns at once; a lesson takes several minutes. Then call wait_for_lesson with its id',
        'again and again until it is done, telling the person each new stage as it comes. get_video gives the finished',
        'video\'s path. Settings decide who writes lessons; get_settings shows them and update_settings changes the ones',
        'the person allows. Keys, provider addresses and raising a spending cap are only ever done in the dashboard.',
      ].join(' '),
    },
  );

  let triedStart = false;
  async function api(method, route, body, { raw = false } = {}) {
    let res;
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await fetch(baseUrl + route, {
          method,
          headers: { ...ACTOR, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        break;
      } catch (e) {
        if (onDown && !triedStart && attempt === 0) {
          triedStart = true;
          if (await onDown()) continue;
        }
        throw new DashboardDown(
          `The Narrated Proofs dashboard is not running at ${baseUrl}. Start it with \`npm start\` in the tts-studio folder, then try again.${e.cause?.code ? ` (${e.cause.code})` : ''}`,
        );
      }
    }
    if (raw) {
      if (!res.ok) throw new Error(`The dashboard answered ${res.status}.`);
      return Buffer.from(await res.arrayBuffer());
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error || `The dashboard answered ${res.status}.`), { status: res.status });
    return data;
  }

  const text = (t, structured) => ({ content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) });
  const failure = (e) => ({ content: [{ type: 'text', text: e.message }], isError: true });
  const tool = (fn) => async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (e) {
      if (e instanceof DashboardDown || e instanceof FileRuleError || e.status) return failure(e);
      throw e;
    }
  };
  const link = (id) => `${linkBase}/#lesson/${id}`;
  const money = (v) => (v == null ? null : `$${Number(v).toFixed(2)}`);

  const WAITING = {
    script: 'the person: the narration is ready to read and approve',
    outline: 'the person: the outline is ready to look over, change and approve',
    storyboard: 'the person: the storyboard is ready to look over and approve',
  };

  /** What a lesson is doing, in a sentence, with the facts beside it. */
  function describe(g) {
    const lesson = g.settings?.lesson || {};
    const facts = {
      id: g.id,
      title: g.title,
      status: g.status,
      stage: g.stage,
      progress: g.progressTotal ? `${g.progressDone}/${g.progressTotal}` : null,
      version: g.version,
      builtVersion: g.builtVersion,
      costUsd: lesson.costUsd ?? null,
      writtenBy: lesson.writtenBy || null,
      error: g.error,
      waitingOn: g.status === 'awaiting' ? WAITING[lesson.phase] || WAITING.storyboard : null,
      chapters: lesson.chaptered ? (lesson.chapters || []).map(({ id, title, minutes }) => ({ id, title, minutes })) : null,
      lastRevision: g.settings?.lastRevision || null,
      durationSec: g.durationSec,
      link: link(g.id),
    };
    const what = {
      queued: 'Waiting its turn to be built.',
      processing: g.stage ? `${g.stage}${facts.progress ? ` (${facts.progress})` : ''}.` : `Building${facts.progress ? ` ${facts.progress}` : ''}.`,
      awaiting: {
        script: 'The narration is written; waiting for the person to read and approve it before the scenes are written.',
        outline: `The outline is written (${lesson.chapters?.length || 'its'} chapters); waiting for the person to look it over and approve it before the chapters are written.`,
      }[lesson.phase] || 'Written and checked; waiting for the person to look over the storyboard and approve it.',
      done: `Done${g.durationSec ? `: ${Math.floor(g.durationSec / 60)} min ${String(Math.round(g.durationSec % 60)).padStart(2, '0')} s` : ''}${lesson.costUsd != null ? `, ${money(lesson.costUsd)} to write` : ''}.`,
      error: `Failed: ${g.error}`,
      cancelled: 'Cancelled.',
    }[g.status] || g.status;
    return { line: `“${g.title}”: ${what}`, facts };
  }

  // ---- making and following lessons -------------------------------------------------------

  const fileSpec = z.union([
    z.string().describe('A path on this computer'),
    z.object({
      path: z.string(),
      pages: z.string().optional().describe('PDF pages to keep, like "1-3, 7"'),
      asText: z.boolean().optional().describe('Send a PDF as its text only: cheaper, loses figures'),
    }),
  ]);

  server.registerTool(
    'make_lesson',
    {
      title: 'Make a lesson',
      description: [
        'Start a narrated maths video from a topic and notes. Returns at once with the lesson id; writing and building take several minutes.',
        `From ${CHAPTERS_FROM} minutes a lesson is written in chapters: first an outline (the chapters and the notation they share), which waits for the person to approve unless outline is false, then each chapter.`,
        'Put everything useful from the conversation into notes: the derivation, notation, worked numbers, what confused the person.',
        'files are paths of images (photos of handwriting work), PDFs, Word or RTF documents or text files on this computer.',
        'Afterwards call wait_for_lesson with the id, repeatedly, and tell the person each stage.',
      ].join(' '),
      inputSchema: {
        topic: z.string().min(1).max(200).describe('What the video is about'),
        goal: z.string().max(2000).optional().describe('What the person wants to understand'),
        notes: z.string().max(MAX_NOTES).optional().describe('Notes to teach from: equations, steps, notation, examples'),
        files: z.array(fileSpec).max(MAX_FILES).optional(),
        minutes: z.number().int().optional().describe(`Length: ${LESSON_MINUTES.join(', ')} minutes. Leave out for the default`),
        quality: z.enum(VIDEO_QUALITIES).optional().describe('Leave out for the default'),
        voice: z.string().optional().describe('An English voice id from list_voices. Leave out for the default'),
        title: z.string().max(120).optional(),
        tags: z.array(z.string()).max(12).optional(),
        review: z.enum(['none', 'storyboard', 'narration']).optional().describe('"storyboard" waits for the person to approve before rendering; "narration" waits for them to approve the narration before the scenes are written (not for lessons in chapters, whose outline is reviewed instead)'),
        outline: z.boolean().optional().describe(`For ${CHAPTERS_FROM} minutes or more: false writes the chapters without waiting for the person to approve the outline`),
        titleCards: z.boolean().optional().describe(`For ${CHAPTERS_FROM} minutes or more: false leaves out the title card before each chapter`),
        writer: z.object({ provider: z.string(), model: z.string().optional() }).optional().describe('A provider set up in Settings, for this lesson only (see get_settings)'),
      },
    },
    tool(async (a) => {
      if (a.minutes !== undefined && !LESSON_MINUTES.includes(a.minutes)) return failure(new Error(`A lesson is ${LESSON_MINUTES.join(', ')} minutes long.`));
      const files = readNoteFiles(a.files || [], { cwd });
      const notes = [a.notes, files.notes].filter(Boolean).join('\n\n');
      const body = {
        profile: 'claude',
        topic: a.topic,
        goal: a.goal,
        notes,
        attachments: files.attachments,
        ...(a.minutes ? { minutes: a.minutes } : {}),
        ...(a.quality ? { quality: a.quality } : {}),
        ...(a.voice ? { voiceId: a.voice } : {}),
        ...(a.title ? { title: a.title } : {}),
        ...(a.tags ? { tags: a.tags } : {}),
        ...(a.review ? { review: { none: 'render', storyboard: 'storyboard', narration: 'script' }[a.review] } : {}),
        ...(a.outline !== undefined ? { outlineReview: a.outline } : {}),
        ...(a.titleCards !== undefined ? { titleCards: a.titleCards } : {}),
        ...(a.writer ? { writer: a.writer } : {}),
      };
      const estimate = await api('POST', '/api/estimate', {
        profile: 'claude',
        minutes: a.minutes,
        notesChars: notes.length,
        images: files.attachments.filter((f) => !/\.(pdf|docx?|rtf|odt)$/i.test(f.name)).length,
        pdfPages: files.attachments.filter((f) => /\.pdf$/i.test(f.name)).length * 4,
        writer: a.writer,
      }).catch(() => null);
      const { generation: g } = await api('POST', '/api/lessons', body);
      const { line, facts } = describe(g);
      const range = estimate && !estimate.unknown?.length ? (estimate.free ? 'free (this Mac)' : `about ${money(estimate.lowUsd)}–${money(estimate.highUsd)}${estimate.chapters ? `, for an outline and about ${estimate.chapters} chapters` : ''}`) : null;
      return text(
        [
          `Started. ${line}`,
          `Id: ${g.id}. Open it at ${facts.link}`,
          range ? `Estimated cost to write: ${range}.` : '',
          'Call wait_for_lesson with this id to follow it, and tell the person each stage.',
        ].filter(Boolean).join('\n'),
        { ...facts, estimate: estimate ? { lowUsd: estimate.lowUsd, highUsd: estimate.highUsd, free: estimate.free } : null },
      );
    }),
  );

  const idArg = { id: z.string().min(1).describe('The lesson id') };
  const getLesson = (id) => api('GET', `/api/generations/${encodeURIComponent(id)}`);

  server.registerTool(
    'lesson_status',
    { title: 'Lesson status', description: 'Where a lesson is: its status, stage, progress, version, cost so far, and what it is waiting on.', inputSchema: idArg, annotations: { readOnlyHint: true } },
    tool(async ({ id }) => {
      const { line, facts } = describe(await getLesson(id));
      return text(line, facts);
    }),
  );

  const ENDED = new Set(['done', 'error', 'cancelled', 'awaiting']);
  server.registerTool(
    'wait_for_lesson',
    {
      title: 'Wait for a lesson',
      description: 'Waits up to 50 seconds for a lesson to move on: returns as soon as its stage or status changes, or when the time is up. Call it again until the lesson is done, waits for the person, or fails, and tell the person each new stage.',
      inputSchema: { ...idArg, since: z.string().optional().describe('The stage last reported; returns when it differs') },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id, since }, extra) => {
      let g = await getLesson(id);
      const start = since ?? `${g.status}|${g.stage || ''}|${g.progressDone}`;
      const key = (x) => (since !== undefined ? x.stage || x.status : `${x.status}|${x.stage || ''}|${x.progressDone}`);
      const token = extra?._meta?.progressToken;
      const t0 = Date.now();
      let tick = 0;
      while (!ENDED.has(g.status) && key(g) === start && Date.now() - t0 < waitMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, pollMs);
          extra?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('cancelled'));
          }, { once: true });
        });
        g = await getLesson(id);
        tick += 1;
        if (token !== undefined) {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: tick, message: g.stage || g.status } }).catch(() => {});
        }
      }
      const { line, facts } = describe(g);
      const more = ENDED.has(g.status) ? (g.status === 'done' ? ' Call get_video for the file.' : '') : ' Still going: call wait_for_lesson again.';
      return text(`${line}${more}`, facts);
    }),
  );

  server.registerTool(
    'search_lessons',
    {
      title: 'Search lessons',
      description: "Search the library of lessons by words in their title and narration, newest first, with optional filters.",
      inputSchema: {
        query: z.string().optional(),
        status: z.enum(['queued', 'processing', 'awaiting', 'done', 'error', 'cancelled']).optional(),
        tag: z.string().optional(),
        favorite: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (a) => {
      const q = new URLSearchParams({ kind: 'video', limit: String(a.limit || 10) });
      if (a.query) q.set('q', a.query);
      if (a.status) q.set('status', a.status);
      if (a.tag) q.set('tag', a.tag);
      if (a.favorite) q.set('favorite', '1');
      const { total, items } = await api('GET', `/api/generations?${q}`);
      const rows = items.map((g) => describe(g));
      return text(
        items.length ? `${total} lesson${total === 1 ? '' : 's'} found${total > items.length ? `, showing ${items.length}` : ''}:\n${rows.map((r) => `- ${r.facts.id} ${r.line}`).join('\n')}` : 'No lessons found.',
        { total, lessons: rows.map((r) => r.facts) },
      );
    }),
  );

  server.registerTool(
    'get_lesson',
    {
      title: 'Get a lesson',
      description: [
        `A lesson's brief (topic, goal, notes), narration script and scenes code. With stills: true, also up to ${MAX_STILLS} storyboard stills as images.`,
        'A lesson in chapters also gives its outline, and the script and scenes of one chapter: the first, or the one named by chapter.',
      ].join(' '),
      inputSchema: { ...idArg, chapter: z.string().optional().describe('For a lesson in chapters: the chapter id, from its outline'), stills: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id, chapter, stills }) => {
      const g = await getLesson(id);
      const q = chapter ? `?chapter=${encodeURIComponent(chapter)}` : '';
      const src = await api('GET', `/api/generations/${encodeURIComponent(id)}/source${q}`).catch(() => ({}));
      const outline = g.settings?.lesson?.chaptered ? await api('GET', `/api/generations/${encodeURIComponent(id)}/outline`).catch(() => null) : null;
      const { line, facts } = describe(g);
      const content = [
        { type: 'text', text: line },
        { type: 'text', text: `Brief:\n${JSON.stringify(src.brief ? { topic: src.brief.topic, goal: src.brief.goal, notes: src.brief.notes, minutes: src.brief.minutes } : g.settings?.lesson || {}, null, 2)}` },
        ...(outline ? [{ type: 'text', text: `Outline${outline.waiting ? ' (waiting for the person to approve it)' : ''}:\n${JSON.stringify({ title: outline.title, through_line: outline.through_line, notation: outline.notation, chapters: outline.chapters }, null, 2)}` }] : []),
        ...(src.chapter ? [{ type: 'text', text: `Chapter ${src.chapter} (of ${src.chapters.map((c) => c.id).join(', ')}):` }] : []),
        ...(src.script ? [{ type: 'text', text: `script.txt:\n${src.script}` }] : []),
        ...(src.scenes ? [{ type: 'text', text: `scenes.py:\n${src.scenes}` }] : []),
      ];
      if (stills) {
        const board = await api('GET', `/api/generations/${encodeURIComponent(id)}/storyboard${src.chapter ? `?chapter=${encodeURIComponent(src.chapter)}` : ''}`).catch(() => null);
        const all = (board?.scenes || []).flatMap((s) => (s.blocks || []).map((b) => ({ scene: s.name, block: b.id, still: (b.stills || []).find((x) => x.mark == null) }))).filter((x) => x.still);
        const pick = all.length <= MAX_STILLS ? all : Array.from({ length: MAX_STILLS }, (_, i) => all[Math.round((i * (all.length - 1)) / (MAX_STILLS - 1))]);
        for (const x of pick) {
          const png = await api('GET', x.still.url, null, { raw: true }).catch(() => null);
          if (!png) continue;
          content.push({ type: 'text', text: `${x.scene}, block [${x.block}], at its end:` }, { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        }
        if (!board) content.push({ type: 'text', text: 'No storyboard yet: it appears once the scenes have been checked.' });
      }
      return { content, structuredContent: { ...facts, project: src.project || null, chapter: src.chapter || null, outline: outline || null } };
    }),
  );

  server.registerTool(
    'get_video',
    {
      title: 'Get the video',
      description: "A finished lesson's video: the MP4's path on this computer, its captions and poster, its length and its dashboard link, with the poster as an image.",
      inputSchema: idArg,
      annotations: { readOnlyHint: true },
    },
    tool(async ({ id }) => {
      const g = await getLesson(id);
      const files = await api('GET', `/api/generations/${encodeURIComponent(id)}/files`);
      const { line, facts } = describe(g);
      if (!files.video) return text(`${line} There is no video yet.`, { ...facts, files });
      const content = [
        { type: 'text', text: [line, `Video: ${files.video}`, files.captions?.srt ? `Captions: ${files.captions.srt} (and .vtt beside it)` : '', `Open: ${facts.link}`].filter(Boolean).join('\n') },
      ];
      if (g.posterUrl) {
        const jpg = await api('GET', g.posterUrl, null, { raw: true }).catch(() => null);
        if (jpg) content.push({ type: 'image', data: jpg.toString('base64'), mimeType: 'image/jpeg' });
      }
      return { content, structuredContent: { ...facts, files } };
    }),
  );

  server.registerTool(
    'cancel_lesson',
    { title: 'Cancel a lesson', description: 'Stop a lesson being written or built, as the Cancel button does. A lesson waiting on its storyboard is marked not to render.', inputSchema: idArg, annotations: { idempotentHint: true, destructiveHint: false } },
    tool(async ({ id }) => {
      const { line, facts } = describe(await api('POST', `/api/generations/${encodeURIComponent(id)}/cancel`));
      return text(line, facts);
    }),
  );

  server.registerTool(
    'retry_lesson',
    { title: 'Retry a lesson', description: 'Try a failed or cancelled lesson again, as the Retry button does. It continues from where it stopped.', inputSchema: idArg, annotations: { idempotentHint: true } },
    tool(async ({ id }) => {
      const g = await getLesson(id);
      if (!['error', 'cancelled'].includes(g.status)) return text(`${describe(g).line} Only failed or cancelled lessons can be retried.`, describe(g).facts);
      const { line, facts } = describe(await api('POST', `/api/generations/${encodeURIComponent(id)}/retry`));
      return text(`Retrying. ${line} Call wait_for_lesson to follow it.`, facts);
    }),
  );

  server.registerTool(
    'revise_lesson',
    {
      title: 'Ask for a change',
      description: [
        'Change a written lesson: "slow down the second scene", "use my notation for the loss". The writer changes only what the request needs;',
        'the result is checked and becomes the next version, which then renders (the old video plays meanwhile). Narrow it with scope:',
        'a scene class name, a block id, or a time in seconds into the video. Returns at once; follow it with wait_for_lesson.',
        'A lesson in chapters is changed a chapter at a time: name it with chapter (a time finds its own).',
      ].join(' '),
      inputSchema: {
        ...idArg,
        request: z.string().min(1).max(4000).describe('What to change, in the person\'s words'),
        scene: z.string().optional().describe('Only this scene (its class name, from get_lesson)'),
        block: z.string().optional().describe('Only this narration block (its id)'),
        at: z.number().min(0).optional().describe('Only the block on screen this many seconds into the video'),
        files: z.array(fileSpec).max(MAX_FILES).optional().describe('New notes for the change, such as a photo of the notation to use'),
        review: z.enum(['none', 'storyboard']).optional().describe('"storyboard" waits for the person before rendering'),
        chapter: z.string().optional().describe('For a lesson in chapters: the chapter to change, by its id'),
      },
    },
    tool(async (a) => {
      const scope = a.at !== undefined ? { kind: 'time', at: a.at } : a.block ? { kind: 'block', id: a.block } : a.scene ? { kind: 'scene', name: a.scene } : { kind: 'lesson' };
      const files = readNoteFiles(a.files || [], { cwd });
      const request = files.notes ? `${a.request}\n\n${files.notes}` : a.request;
      const g = await api('POST', `/api/generations/${encodeURIComponent(a.id)}/revise`, {
        request, scope, attachments: files.attachments, review: a.review === 'storyboard' ? 'storyboard' : 'render',
        ...(a.chapter && a.at === undefined ? { chapter: a.chapter } : {}),
      });
      const { line, facts } = describe(g);
      return text(`Revising. ${line} Call wait_for_lesson to follow it; the new version renders when it passes its check.`, facts);
    }),
  );

  server.registerTool(
    'approve_lesson',
    {
      title: 'Approve a lesson',
      description: [
        'Continue a lesson that waits for the person: render it after its storyboard, write the scenes for its narration, or write the chapters of its outline.',
        'Only when the person has said to. For an outline, outline may carry their changes: the outline as get_lesson gives it, edited (chapters renamed, reordered, resized, added or removed).',
      ].join(' '),
      inputSchema: {
        ...idArg,
        quality: z.enum(VIDEO_QUALITIES).optional(),
        outline: z.object({ title: z.string(), chapters: z.array(z.object({ title: z.string() }).passthrough()).min(1) }).passthrough().optional().describe('The outline as the person wants it'),
      },
    },
    tool(async ({ id, quality, outline }) => {
      const g = await getLesson(id);
      if (g.status !== 'awaiting') return text(`${describe(g).line} It is not waiting for approval.`, describe(g).facts);
      const phase = g.settings?.lesson?.phase;
      const action = { script: 'scenes', outline: 'chapters' }[phase] || 'render';
      if (outline && phase !== 'outline') return text(`${describe(g).line} Only an outline waiting for approval can be changed.`, describe(g).facts);
      const after = await api('POST', `/api/generations/${encodeURIComponent(id)}/approve`, { action, ...(quality ? { quality } : {}), ...(outline ? { outline } : {}) });
      const { line, facts } = describe(after);
      const done = { scenes: 'Narration approved: the scenes are being written.', chapters: 'Outline approved: the chapters are being written, one after another.', render: 'Approved: rendering.' }[action];
      return text(`${done} ${line} Call wait_for_lesson to follow it.`, facts);
    }),
  );

  server.registerTool(
    'redo_outline',
    {
      title: 'Ask for another outline',
      description: 'Have the outline of a long lesson written again, with a change the person asked for ("fewer chapters", "start from the chain rule"). Only while the outline waits for approval. Follow it with wait_for_lesson.',
      inputSchema: { ...idArg, request: z.string().min(1).max(2000).describe('What to change, in the person\'s words') },
    },
    tool(async ({ id, request }) => {
      const { line, facts } = describe(await api('POST', `/api/generations/${encodeURIComponent(id)}/outline/redo`, { request }));
      return text(`Writing the outline again. ${line} Call wait_for_lesson to follow it.`, facts);
    }),
  );

  server.registerTool(
    'list_voices',
    { title: 'List voices', description: 'The English voices lessons can use (animations follow individual words, which needs English).', annotations: { readOnlyHint: true } },
    tool(async () => {
      const { voices, languages } = await api('GET', '/api/voices');
      const ok = new Set(languages.filter((l) => ['a', 'b'].includes(l.code) && l.available).map((l) => l.code));
      const list = voices.filter((v) => ok.has(v.lang)).map((v) => ({ id: v.voiceId, name: v.name, accent: v.lang === 'a' ? 'American' : 'British', gender: v.gender || null }));
      return text(list.map((v) => `${v.id}: ${v.name}, ${v.accent}${v.gender ? `, ${v.gender}` : ''}`).join('\n'), { voices: list });
    }),
  );

  // ---- settings ------------------------------------------------------------------------------

  const stepShape = z.object({
    provider: z.string().optional().describe('A provider id from get_settings that is set up'),
    model: z.string().optional(),
    effort: z.enum(['', ...EFFORTS]).optional().describe('"" for each step\'s default'),
  });
  const planShape = z.object({
    mode: z.enum(['one', 'steps']).optional().describe('"one": the same writer for every step; "steps": one per step'),
    all: stepShape.optional(),
    steps: z.object(Object.fromEntries(WRITER_STEPS.map(([k]) => [k, stepShape.optional()]))).optional(),
    handBackAfter: z.number().int().min(0).max(5).optional().describe('Failed fixes before a different fixing writer hands back to the main one; 0 never'),
  });
  const toPlan = (p) => {
    if (!p) return undefined;
    const { handBackAfter, ...rest } = p;
    return { ...rest, ...(handBackAfter !== undefined ? { handBack: { after: handBackAfter } } : {}) };
  };

  function summarizeSettings(s) {
    const v = s.values;
    const steps = (r) => (r?.steps ? Object.fromEntries(['read', 'write', 'fix', 'polish'].map((k) => [k, `${r.steps[k].label}${r.steps[k].model ? ` · ${r.steps[k].model}` : ''}${r.steps[k].effort ? ` (${r.steps[k].effort})` : ''}`])) : r?.error);
    return {
      claudeWriter: { sameAsPage: v['writer.claude'].same, plan: v['writer.claude'].plan, inEffect: steps(s.resolved.claude), notesGoTo: s.resolved.claude.notesGo },
      pageWriter: { plan: v['writer.page'], inEffect: steps(s.resolved.page) },
      claudeDefaults: v['claude.defaults'],
      costs: { ...v.costs, thisMonthUsd: s.costThisMonthUsd },
      claudeMayChange: v['claude.allow'],
      lockedByEnvironment: s.locks,
      providers: s.providers.map((p) => ({
        id: p.id,
        label: p.label,
        setUp: p.configured,
        sendsNotesTo: p.destination,
        models: (p.models || []).slice(0, 30),
        tested: p.test?.ok ? Object.fromEntries(Object.entries(p.test.caps || {}).map(([m, c]) => [m || '(default)', c])) : null,
      })),
    };
  }

  server.registerTool(
    'get_settings',
    {
      title: 'Get settings',
      description: "Who writes lessons (the page's writer and Claude's own, per step), the defaults for lessons Claude starts, spending caps, what Claude may change, and each provider with what it can do. Never shows keys.",
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const s = summarizeSettings(await api('GET', '/api/settings'));
      return text(JSON.stringify(s, null, 2), s);
    }),
  );

  server.registerTool(
    'update_settings',
    {
      title: 'Update settings',
      description: [
        'Change what the person allows Claude to change: which provider (already set up) and model writes each step of lessons Claude starts,',
        'effort, the defaults for those lessons, and lowering a spending cap. Refused, with the reason, for anything else.',
        'Adding providers, keys, addresses and raising caps are only done in the dashboard. Every change shows there with an Undo.',
      ].join(' '),
      inputSchema: {
        writer: z.object({ sameAsPage: z.boolean().optional(), plan: planShape.optional() }).optional().describe("The writer for lessons Claude starts"),
        pageWriter: planShape.optional().describe('The writer for lessons started from the page, if the person allows it'),
        defaults: z.object({ minutes: z.number().int().optional(), quality: z.enum(VIDEO_QUALITIES).optional(), review: z.enum(['render', 'storyboard']).optional() }).optional(),
        lessonCapUsd: z.number().min(0).optional().describe('Lower the cap per lesson'),
        monthCapUsd: z.number().min(0).optional().describe('Lower (or set) the monthly cap'),
      },
    },
    tool(async (a) => {
      const body = {};
      if (a.writer) body['writer.claude'] = { ...(a.writer.sameAsPage !== undefined ? { same: a.writer.sameAsPage } : {}), ...(a.writer.plan ? { plan: toPlan(a.writer.plan) } : {}) };
      if (a.pageWriter) body['writer.page'] = toPlan(a.pageWriter);
      if (a.defaults) body['claude.defaults'] = a.defaults;
      if (a.lessonCapUsd !== undefined || a.monthCapUsd !== undefined) {
        body.costs = { ...(a.lessonCapUsd !== undefined ? { lessonCapUsd: a.lessonCapUsd } : {}), ...(a.monthCapUsd !== undefined ? { monthCapUsd: a.monthCapUsd } : {}) };
      }
      if (!Object.keys(body).length) return failure(new Error('Say what to change.'));
      const out = await api('PATCH', '/api/settings', body);
      const s = summarizeSettings(out);
      const done = out.changed.length ? `Changed: ${out.history.filter((h) => h.by === 'claude').slice(0, out.changed.length).map((h) => h.summary).join('; ')}. The person can undo this in Settings.` : 'Nothing changed: those were already the settings.';
      return text(done, s);
    }),
  );

  server.registerTool(
    'test_writer',
    {
      title: 'Test a writer',
      description: "Run a provider's Test, as the dashboard's Test button does: checks it answers, lists its models, and finds whether a model gives structured answers, sees pictures and reads PDFs.",
      inputSchema: { provider: z.string(), model: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ provider, model }) => {
      const { result } = await api('POST', `/api/providers/${encodeURIComponent(provider)}/test`, { model });
      const caps = result.caps?.[result.model || ''] || Object.values(result.caps || {})[0];
      const lines = result.ok
        ? [`${provider} works with ${result.model || 'its default model'}.`, caps ? `Structured answers: ${caps.structured}; pictures: ${caps.images ? 'yes' : 'no'}; PDFs: ${caps.pdf ? 'yes' : 'no'}; context: ${caps.context ? caps.context.toLocaleString('en-US') : 'unknown'}${caps.tokensPerSec ? `; about ${caps.tokensPerSec} tokens/s` : ''}.` : '', ...(result.notes || [])]
        : [`${provider} did not pass: ${result.error}`];
      return text(lines.filter(Boolean).join('\n'), result);
    }),
  );

  // ---- resources and the prompt ------------------------------------------------------------

  const PARTS = { script: ['script.txt', 'text/plain'], scenes: ['scenes.py', 'text/x-python'], captions: ['captions.vtt', 'text/vtt'] };
  server.registerResource(
    'lesson-file',
    new ResourceTemplate('lesson://{id}/{part}', {
      list: async () => {
        const { items } = await api('GET', '/api/generations?kind=video&limit=20').catch(() => ({ items: [] }));
        return {
          resources: items.flatMap((g) =>
            Object.entries(PARTS)
              .filter(([part]) => part !== 'captions' || g.videoUrl)
              .map(([part, [file, mimeType]]) => ({ uri: `lesson://${g.id}/${part}`, name: `${g.title}: ${file}`, mimeType })),
          ),
        };
      },
    }),
    { title: "A lesson's script, scenes or captions", description: 'lesson://<id>/script, /scenes or /captions' },
    async (uri, { id, part }) => {
      if (!PARTS[part]) throw new Error(`A lesson's parts are ${Object.keys(PARTS).join(', ')}.`);
      let body;
      if (part === 'captions') body = (await api('GET', `/api/generations/${encodeURIComponent(id)}/captions.vtt`, null, { raw: true })).toString('utf8');
      else body = (await api('GET', `/api/generations/${encodeURIComponent(id)}/source`))[part] || '';
      return { contents: [{ uri: uri.href, mimeType: PARTS[part][1], text: body }] };
    },
  );

  server.registerPrompt(
    'explain',
    {
      title: 'Explain this as a lesson',
      description: 'Turn what this conversation worked through into a narrated video lesson.',
      argsSchema: { topic: z.string().optional().describe('What the lesson is about, if not obvious'), minutes: z.string().optional().describe(LESSON_MINUTES.join(', ')) },
    },
    ({ topic, minutes }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Make a narrated lesson with Narrated Proofs from what we have worked through in this conversation${topic ? `, about ${topic}` : ''}.`,
              'Gather the topic, what I want to understand, and notes to teach from: the equations, notation, worked steps and examples we used, and anything that confused me.',
              'Include any files I mentioned by their paths.',
              `Call make_lesson${minutes ? ` with minutes: ${minutes}` : ''}, then follow it with wait_for_lesson, telling me each stage, and give me the video with get_video when it is done.`,
            ].join(' '),
          },
        },
      ],
    }),
  );

  return server;
}
