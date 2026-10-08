import path from 'node:path';
import express from 'express';
import { keyFor, SecretError } from './secrets.js';
import { SettingsError } from './settings.js';
import { estimateLesson } from './estimate.js';
import { listModels, probe as probeProvider } from '../author/writers/probe.js';
import { LESSON_MINUTES } from '../shared/limits.js';
import { ROOT } from './config.js';

/** Changes sent with this header come from Claude, through the MCP connector, and get Claude's limits. */
export const ACTOR_HEADER = 'x-narrated-proofs-actor';
export const actorOf = (req) => (String(req.get(ACTOR_HEADER) || '').toLowerCase() === 'claude' ? 'claude' : 'you');

const asHttp = (e) => {
  if (e instanceof SettingsError || e instanceof SecretError) return Object.assign(new Error(e.message), { status: e.status || 400 });
  return e;
};
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(asHttp(e));
  }
};

/**
 * The Settings page's routes:
 *
 *   GET    /settings                    everything the page shows (never a key)
 *   PATCH  /settings                    { key: partial value, ... }
 *   POST   /settings/undo               { seq } or the last change
 *   GET    /settings/history
 *   PUT    /providers/:id               { label, baseUrl } ("new" adds one)
 *   DELETE /providers/:id
 *   PUT    /providers/:id/key           { key }   write-only
 *   DELETE /providers/:id/key
 *   POST   /providers/:id/test          { model }
 *   GET    /providers/:id/models
 *   POST   /estimate                    { minutes, notesChars, images, pdfPages, profile, writer }
 *   GET    /connect                     how to connect Claude, with this machine's paths
 */
export function settingsRoutes({ settings, secrets, getConfig, store, probe = probeProvider }) {
  const r = express.Router();
  const config = () => getConfig();

  const page = async () => {
    const c = config();
    return {
      ...(await settings.view()),
      costThisMonthUsd: store.stats().costThisMonthUsd,
      storage: { dataDir: c.dataDir, projects: c.videoDir ? path.join(c.videoDir, 'projects') : null, envFile: c.envFile || null, keysKeptIn: secrets?.where || null },
    };
  };

  r.get('/settings', wrap(async (req, res) => res.json(await page())));

  r.patch(
    '/settings',
    wrap(async (req, res) => {
      const changed = await settings.patch(req.body || {}, { by: actorOf(req) });
      res.json({ changed, ...(await page()) });
    }),
  );

  r.post(
    '/settings/undo',
    wrap(async (req, res) => {
      if (actorOf(req) === 'claude') throw new SettingsError('Undo is done in the dashboard.', 403);
      const seq = req.body?.seq ? Number(req.body.seq) : null;
      settings.undo(seq);
      res.json(await page());
    }),
  );

  r.get('/settings/history', (req, res) => res.json({ history: settings.history(Number(req.query.limit) || 50) }));

  // Providers, addresses and keys decide where notes are sent: never Claude's to change.
  const youOnly = (req) => {
    if (actorOf(req) === 'claude') throw new SettingsError('Providers, addresses and keys are changed only in the dashboard.', 403);
  };

  r.put(
    '/providers/:id',
    wrap(async (req, res) => {
      youOnly(req);
      const id = await settings.saveProvider(String(req.params.id), req.body || {});
      res.json({ id, ...(await page()) });
    }),
  );

  r.delete(
    '/providers/:id',
    wrap(async (req, res) => {
      youOnly(req);
      await settings.removeProvider(String(req.params.id));
      res.json(await page());
    }),
  );

  r.put(
    '/providers/:id/key',
    wrap(async (req, res) => {
      youOnly(req);
      const id = String(req.params.id);
      if (config().given?.[`${id.toUpperCase()}_API_KEY`]) throw new SettingsError(`${id.toUpperCase()}_API_KEY is set in the environment or .env, and that key is used. Remove it there to keep one here instead.`, 409);
      await settings.setKey(id, req.body?.key);
      res.json(await page());
    }),
  );

  r.delete(
    '/providers/:id/key',
    wrap(async (req, res) => {
      youOnly(req);
      await settings.removeKey(String(req.params.id));
      res.json(await page());
    }),
  );

  const providerOr404 = (id) => {
    const p = settings.provider(String(id));
    if (!p) throw new SettingsError('There is no such provider.', 404);
    return p;
  };

  r.post(
    '/providers/:id/test',
    wrap(async (req, res) => {
      const p = providerOr404(req.params.id);
      const model = req.body?.model ? String(req.body.model).slice(0, 200) : '';
      const { key } = p.needsKey ? await keyFor(p.id, { config: config(), secrets }) : { key: null };
      const ac = new AbortController();
      res.on('close', () => !res.writableFinished && ac.abort());
      const result = await probe({ provider: p, model, key, config: config(), signal: ac.signal });
      // Each model's findings are kept, so testing one does not forget another.
      const before = p.test || {};
      settings.recordTest(
        p.id,
        result.ok
          ? { ...result, caps: { ...(before.caps || {}), ...result.caps } }
          : { ...before, ok: false, at: result.at, error: result.error, notes: result.notes },
      );
      res.json({ result, provider: (await settings.providerViews()).find((v) => v.id === p.id) });
    }),
  );

  r.get(
    '/providers/:id/models',
    wrap(async (req, res) => {
      const p = providerOr404(req.params.id);
      const { key } = p.needsKey ? await keyFor(p.id, { config: config(), secrets }) : { key: null };
      const writer = { provider: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: '' };
      try {
        res.json({ models: (await listModels({ writer, key, config: config() })).map((m) => m.id).sort() });
      } catch (e) {
        throw new SettingsError(`Could not list ${p.label}'s models: ${e.message}`, 502);
      }
    }),
  );

  r.post(
    '/estimate',
    wrap(async (req, res) => {
      const b = req.body || {};
      const profile = b.profile === 'claude' ? 'claude' : 'page';
      const writer = settings.resolveWriter(profile, b.writer?.provider ? { provider: String(b.writer.provider), model: String(b.writer.model || '') } : null);
      const minutes = LESSON_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : settings.lessonDefaults(profile).minutes;
      let ready = null;
      try {
        await settings.checkWriter(writer);
      } catch (e) {
        ready = e.message;
      }
      res.json({
        ...estimateLesson(writer, { minutes, notesChars: Number(b.notesChars) || 0, images: Number(b.images) || 0, pdfPages: Number(b.pdfPages) || 0 }),
        writer: Object.fromEntries(Object.entries(writer.steps).map(([k, w]) => [k, { provider: w.provider, label: w.label, model: w.model, effort: w.effort, caps: w.caps }])),
        notesGo: settings.whereNotesGo(writer),
        problem: ready,
      });
    }),
  );

  r.get('/connect', (req, res) => {
    const port = req.socket.localPort || config().port;
    const url = `http://localhost:${port}/mcp`;
    const stdio = path.join(ROOT, 'mcp', 'stdio.js');
    const node = process.execPath;
    const env = port === 8787 ? {} : { NARRATED_PROOFS_URL: `http://127.0.0.1:${port}` };
    res.json({
      http: { url, claudeCode: `claude mcp add --transport http narrated-proofs ${url}` },
      stdio: {
        command: node,
        args: [stdio],
        claudeCode: `claude mcp add narrated-proofs${Object.entries(env).map(([k, v]) => ` -e ${k}=${v}`).join('')} -- "${node}" "${stdio}"`,
      },
      desktop: {
        configFile: '~/Library/Application Support/Claude/claude_desktop_config.json',
        entry: { mcpServers: { 'narrated-proofs': { command: node, args: [stdio], ...(Object.keys(env).length ? { env } : {}) } } },
        pack: 'npm run mcp:pack',
      },
    });
  });

  return r;
}
