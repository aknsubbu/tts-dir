import path from 'node:path';
import express from 'express';
import { SecretError } from './secrets.js';
import { SettingsError } from './settings.js';
import { estimateLesson } from './estimate.js';
import { listModels, probe as probeProvider } from '../author/writers/probe.js';
import { LESSON_MINUTES } from '../shared/limits.js';
import { ROOT } from './config.js';

/** Changes sent with this header come from Claude, through the MCP connector, and get Claude's limits. */
export const ACTOR_HEADER = 'x-narrated-proofs-actor';
// Anything that came with a connector token is Claude's, whatever it says about itself.
export const actorOf = (req) => (req.viaConnector || String(req.get(ACTOR_HEADER) || '').toLowerCase() === 'claude' ? 'claude' : 'you');

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
 *   POST   /estimate                    { minutes, notesChars, images, pdfPages, origin, writer }
 *   GET    /connect                     how to connect Claude, with this machine's paths
 */
export function settingsRoutes({ settings, secrets, getConfig, store, profiles = null, probe = probeProvider }) {
  const r = express.Router();
  const config = () => getConfig();
  /** The signed-in profile's own settings, keys and history. */
  const mine = (req) => settings.for(req.profile.id);

  const page = async (req) => {
    const c = config();
    return {
      ...(await mine(req).view()),
      ...(req.profile.isOwner ? { house: { maxProfiles: c.maxProfiles ?? null, lan: !!c.lan, profileCount: profiles?.list().length ?? null } } : {}),
      writerProblem: await mine(req).writerProblem(),
      ...(profiles && !req.profile.isOwner && profiles.get(req.profile.id)?.hostCapUsd != null ? { hostAllowance: { capUsd: profiles.get(req.profile.id).hostCapUsd, spentUsd: store.stats(req.profile.id).hostSpentThisMonthUsd } } : {}),
      costThisMonthUsd: store.stats(req.profile.id).costThisMonthUsd,
      storage: { dataDir: c.dataDir, projects: c.videoDir ? path.join(c.videoDir, 'projects') : null, envFile: c.envFile || null, keysKeptIn: secrets?.where || null },
    };
  };

  r.get('/settings', wrap(async (req, res) => res.json(await page(req))));

  r.patch(
    '/settings',
    wrap(async (req, res) => {
      const changed = await mine(req).patch(req.body || {}, { by: actorOf(req) });
      res.json({ changed, ...(await page(req)) });
    }),
  );

  r.post(
    '/settings/undo',
    wrap(async (req, res) => {
      if (actorOf(req) === 'claude') throw new SettingsError('Undo is done in the dashboard.', 403);
      const seq = req.body?.seq ? Number(req.body.seq) : null;
      mine(req).undo(seq);
      res.json(await page(req));
    }),
  );

  r.get('/settings/history', (req, res) => res.json({ history: mine(req).history(Number(req.query.limit) || 50) }));

  // Providers, addresses and keys decide where notes are sent: never Claude's to change.
  const youOnly = (req) => {
    if (actorOf(req) === 'claude') throw new SettingsError('Providers, addresses and keys are changed only in the dashboard.', 403);
  };

  r.put(
    '/providers/:id',
    wrap(async (req, res) => {
      youOnly(req);
      const id = await mine(req).saveProvider(String(req.params.id), req.body || {});
      res.json({ id, ...(await page(req)) });
    }),
  );

  r.delete(
    '/providers/:id',
    wrap(async (req, res) => {
      youOnly(req);
      await mine(req).removeProvider(String(req.params.id));
      res.json(await page(req));
    }),
  );

  r.put(
    '/providers/:id/key',
    wrap(async (req, res) => {
      youOnly(req);
      const id = String(req.params.id);
      await mine(req).setKey(id, req.body?.key);
      res.json(await page(req));
    }),
  );

  r.delete(
    '/providers/:id/key',
    wrap(async (req, res) => {
      youOnly(req);
      await mine(req).removeKey(String(req.params.id));
      res.json(await page(req));
    }),
  );

  const providerOr404 = (req, id) => {
    const p = mine(req).provider(String(id));
    if (!p) throw new SettingsError('There is no such provider.', 404);
    return p;
  };

  r.post(
    '/providers/:id/test',
    wrap(async (req, res) => {
      const p = providerOr404(req, req.params.id);
      if (p.kind === 'claude-code' && !mine(req).perms().claude) throw new SettingsError('The Owner has not allowed your profile to use the Claude Code sign-in on this computer.', 403);
      const model = req.body?.model ? String(req.body.model).slice(0, 200) : '';
      const { key } = p.needsKey ? await mine(req).keyFor(p.id) : { key: null };
      const ac = new AbortController();
      res.on('close', () => !res.writableFinished && ac.abort());
      const result = await probe({ provider: p, model, key, config: config(), signal: ac.signal });
      // Each model's findings are kept, so testing one does not forget another.
      const before = p.test || {};
      mine(req).recordTest(
        p.id,
        result.ok
          ? { ...result, caps: { ...(before.caps || {}), ...result.caps } }
          : { ...before, ok: false, at: result.at, error: result.error, notes: result.notes },
      );
      res.json({ result, provider: (await mine(req).providerViews()).find((v) => v.id === p.id) });
    }),
  );

  r.get(
    '/providers/:id/models',
    wrap(async (req, res) => {
      const p = providerOr404(req, req.params.id);
      const { key } = p.needsKey ? await mine(req).keyFor(p.id) : { key: null };
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
      const origin = (b.origin || b.profile) === 'claude' ? 'claude' : 'page';
      const writer = mine(req).resolveWriter(origin, b.writer?.provider ? { provider: String(b.writer.provider), model: String(b.writer.model || '') } : null);
      const minutes = LESSON_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : mine(req).lessonDefaults(origin).minutes;
      let ready = null;
      try {
        await mine(req).checkWriter(writer);
      } catch (e) {
        ready = e.message;
      }
      res.json({
        ...estimateLesson(writer, { minutes, notesChars: Number(b.notesChars) || 0, images: Number(b.images) || 0, pdfPages: Number(b.pdfPages) || 0 }),
        writer: Object.fromEntries(Object.entries(writer.steps).map(([k, w]) => [k, { provider: w.provider, label: w.label, model: w.model, effort: w.effort, caps: w.caps }])),
        notesGo: mine(req).whereNotesGo(writer),
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
      // With a token (Settings → Connect Claude makes one) the connector acts as this profile alone.
      http: { url, claudeCode: `claude mcp add --transport http narrated-proofs ${url}`, claudeCodeToken: `claude mcp add --transport http narrated-proofs ${url} --header "Authorization: Bearer <token>"` },
      stdio: {
        claudeCodeToken: `claude mcp add narrated-proofs${Object.entries({ ...env, NARRATED_PROOFS_TOKEN: '<token>' }).map(([k, v]) => ` -e ${k}=${v}`).join('')} -- "${node}" "${stdio}"`,
        command: node,
        args: [stdio],
        claudeCode: `claude mcp add narrated-proofs${Object.entries(env).map(([k, v]) => ` -e ${k}=${v}`).join('')} -- "${node}" "${stdio}"`,
      },
      desktop: {
        configFile: '~/Library/Application Support/Claude/claude_desktop_config.json',
        entry: { mcpServers: { 'narrated-proofs': { command: node, args: [stdio], ...(Object.keys(env).length ? { env } : {}) } } },
        entryToken: { mcpServers: { 'narrated-proofs': { command: node, args: [stdio], env: { ...env, NARRATED_PROOFS_TOKEN: '<token>' } } } },
        pack: 'npm run mcp:pack',
      },
    });
  });

  return r;
}
