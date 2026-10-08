#!/usr/bin/env node
// A writer bake-off: the same topics through each writer, to see which is worth using.
//
//   npm run bakeoff                          every set-up provider, three short built-in topics
//   npm run bakeoff -- --writers claude-code,ollama:qwen3-coder:30b --topics topics.json
//   npm run bakeoff -- --yes                 do not ask before spending on paid providers
//
// Each lesson is made through the running dashboard, stops at its storyboard (nothing is
// rendered), and is tagged "bakeoff". The report says how often each writer's lessons passed
// the check, the fix rounds, time and cost, and puts their storyboards side by side.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const BASE = (opt('url') || process.env.NARRATED_PROOFS_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOPICS = [
  { topic: 'Why the derivative of x squared is 2x', goal: 'See it from the limit definition', minutes: 1 },
  { topic: 'The gradient of the squared error', goal: 'Where (y_hat - y) x comes from', minutes: 1 },
  { topic: 'Bayes’ rule with a medical test', goal: 'Why a positive result can still be unlikely to mean illness', minutes: 2 },
];

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`The dashboard is not running at ${BASE}. Start it with npm start.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${route} answered ${res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);

async function main() {
  const settings = await api('GET', '/api/settings');
  const topics = opt('topics') ? JSON.parse(fs.readFileSync(opt('topics'), 'utf8')) : TOPICS;
  const wanted = opt('writers');
  const writers = wanted
    ? wanted.split(',').map((w) => {
        const [provider, ...model] = w.split(':');
        return { provider, model: model.join(':') };
      })
    : settings.providers.filter((p) => p.configured).map((p) => ({ provider: p.id, model: p.test?.model || '' }));
  const label = (w) => {
    const p = settings.providers.find((x) => x.id === w.provider);
    return `${p?.label || w.provider}${w.model ? ` · ${w.model}` : ''}`;
  };
  if (!writers.length) throw new Error('No providers are set up. Set one up in Settings → Lesson writer.');

  console.log(`\n  ${topics.length} topic${topics.length === 1 ? '' : 's'} × ${writers.length} writer${writers.length === 1 ? '' : 's'}\n`);
  let paid = 0;
  for (const w of writers) {
    const e = await api('POST', '/api/estimate', { writer: w, minutes: 2 });
    if (e.problem) throw new Error(`${label(w)}: ${e.problem}`);
    const each = e.free ? 'free' : e.unknown?.length ? 'cost unknown (no rate)' : `about ${money(e.lowUsd)}–${money(e.highUsd)} a lesson`;
    if (!e.free) paid += 1;
    console.log(`  ${label(w).padEnd(44)} ${each}`);
  }
  if (paid && !args.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question('\n  This spends money on the paid providers above. Go ahead? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ok !== 'y' && ok !== 'yes') return console.log('  Stopped. Nothing was spent.');
  }

  const runs = [];
  for (const t of topics) {
    for (const w of writers) {
      const started = Date.now();
      const { generation } = await api('POST', '/api/lessons', { ...t, writer: w, review: 'storyboard', quality: 'low', tags: ['bakeoff'] });
      runs.push({ topic: t.topic, writer: w, label: label(w), id: generation.id, started });
    }
  }
  console.log(`\n  Started ${runs.length} lessons. Waiting for them to be written and checked…\n`);
  const open = new Set(runs);
  while (open.size) {
    await sleep(3000);
    for (const run of [...open]) {
      const g = await api('GET', `/api/generations/${run.id}`);
      if (!['awaiting', 'done', 'error', 'cancelled'].includes(g.status)) continue;
      open.delete(run);
      const lesson = g.settings?.lesson || {};
      Object.assign(run, { status: g.status, error: g.error, fixes: lesson.fixes ?? null, autofixed: lesson.autofixed ?? 0, warnings: lesson.warnings ?? null, costUsd: lesson.costUsd ?? null, minutes: (Date.now() - run.started) / 60000 });
      console.log(`  ${g.status === 'error' ? '✗' : '✓'} ${run.label}: ${run.topic}${g.error ? ` (${g.error.slice(0, 80)})` : ''}`);
    }
  }

  // Per writer: how often the check passed, and the averages.
  const rows = writers.map((w) => {
    const mine = runs.filter((r) => r.writer === w);
    const passed = mine.filter((r) => r.status !== 'error');
    const avg = (key) => (passed.length ? passed.reduce((n, r) => n + (Number(r[key]) || 0), 0) / passed.length : null);
    return { label: label(w), passed: passed.length, of: mine.length, fixes: avg('fixes'), minutes: avg('minutes'), costUsd: avg('costUsd') };
  });
  console.log(`\n  ${'Writer'.padEnd(44)} Passed  Fixes  Minutes  Cost`);
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(44)} ${`${r.passed}/${r.of}`.padEnd(7)} ${r.fixes == null ? '—    ' : r.fixes.toFixed(1).padEnd(6)} ${r.minutes == null ? '—      ' : r.minutes.toFixed(1).padEnd(8)} ${money(r.costUsd)}`);
  }

  const dir = path.join(here, '..', 'data', 'bakeoff');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify({ base: BASE, rows, runs }, null, 2));
  fs.writeFileSync(path.join(dir, `${stamp}.html`), await report(topics, writers, runs, rows, label));
  console.log(`\n  Report: ${path.join(dir, `${stamp}.html`)} (open it while the dashboard is running to see the stills)\n`);
}

/** Storyboards side by side: one row per topic, one column per writer. */
async function report(topics, writers, runs, rows, label) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cell = async (run) => {
    if (!run) return '<td></td>';
    let stills = [];
    try {
      const board = await api('GET', `/api/generations/${run.id}/storyboard`);
      stills = (board.scenes || []).flatMap((s) => (s.blocks || []).map((b) => (b.stills || []).find((x) => x.mark == null))).filter(Boolean).slice(0, 6);
    } catch {
      /* failed before a storyboard */
    }
    return `<td><a href="${BASE.replace('127.0.0.1', 'localhost')}/#lesson/${run.id}/storyboard">${esc(run.status)}</a> · ${run.fixes ?? '—'} fixes · ${money(run.costUsd)}${run.error ? `<p class="err">${esc(run.error)}</p>` : ''}<div class="stills">${stills.map((s) => `<img src="${BASE}${s.url}" alt="">`).join('')}</div></td>`;
  };
  const body = [];
  for (const t of topics) {
    const cells = [];
    for (const w of writers) cells.push(await cell(runs.find((r) => r.topic === t.topic && r.writer === w)));
    body.push(`<tr><th>${esc(t.topic)}</th>${cells.join('')}</tr>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>Writer bake-off</title>
<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}.stills{display:grid;grid-template-columns:repeat(3,160px);gap:4px;margin-top:6px}.stills img{width:160px;border-radius:4px}.err{color:#c00;max-width:480px}</style>
<h1>Writer bake-off</h1>
<table><tr><th>Writer</th><th>Passed</th><th>Fixes</th><th>Minutes</th><th>Cost</th></tr>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.passed}/${r.of}</td><td>${r.fixes?.toFixed(1) ?? '—'}</td><td>${r.minutes?.toFixed(1) ?? '—'}</td><td>${money(r.costUsd)}</td></tr>`).join('')}</table>
<h2>Storyboards</h2>
<table><tr><th></th>${writers.map((w) => `<th>${esc(label(w))}</th>`).join('')}</tr>${body.join('')}</table>`;
}

main().catch((e) => {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
});
