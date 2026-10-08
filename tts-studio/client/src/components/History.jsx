import { useEffect, useMemo, useState } from 'react';
import { diffWords, structuredPatch } from 'diff';
import { api } from '../api.js';
import { fmtDuration, fmtUsd, parseScript, timeAgo } from '../utils.js';

const SOURCE = { written: 'Written', edited: 'Edited', revised: 'Revised', restored: 'Restored' };

/** The narration, block by block: changed words marked, new and removed blocks, the rest counted. */
export function NarrationDiff({ a, b }) {
  const rows = useMemo(() => {
    const A = new Map(parseScript(a).map((x) => [x.id, x.text]));
    const B = parseScript(b);
    const out = B.map((x) => ({ id: x.id, before: A.get(x.id), after: x.text }));
    for (const [id, text] of A) if (!B.some((x) => x.id === id)) out.push({ id, before: text, after: undefined });
    return out.map((r) => ({ ...r, kind: r.before === undefined ? 'new' : r.after === undefined ? 'removed' : r.before === r.after ? 'same' : 'changed' }));
  }, [a, b]);
  const same = rows.filter((r) => r.kind === 'same').length;
  const shown = rows.filter((r) => r.kind !== 'same');
  return (
    <div className="narration-diff">
      {shown.map((r) => (
        <div key={r.id} className={`diff-block ${r.kind}`}>
          <div className="diff-head"><code>[{r.id}]</code> {r.kind}</div>
          <p>
            {r.kind === 'changed'
              ? diffWords(r.before, r.after).map((part, i) => (part.added ? <ins key={i}>{part.value}</ins> : part.removed ? <del key={i}>{part.value}</del> : <span key={i}>{part.value}</span>))
              : r.kind === 'new' ? <ins>{r.after}</ins> : <del>{r.before}</del>}
          </p>
        </div>
      ))}
      <p className="hint">{shown.length ? `${same} block${same === 1 ? '' : 's'} unchanged.` : 'The narration is the same.'}</p>
    </div>
  );
}

/** scenes.py as a line diff, three lines of context around each change. */
export function ScenesDiff({ a, b }) {
  const hunks = useMemo(() => structuredPatch('scenes.py', 'scenes.py', a || '', b || '', '', '', { context: 3 }).hunks, [a, b]);
  if (!hunks.length) return <p className="hint">scenes.py is the same.</p>;
  return (
    <div className="line-diff" role="table" aria-label="Changes to scenes.py">
      {hunks.map((h) => (
        <div key={`${h.oldStart}-${h.newStart}`} className="hunk">
          <div className="hunk-head">line {h.newStart}</div>
          {h.lines.map((line, i) => (
            <div key={i} className={line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'}>
              <span className="sign">{line[0] === ' ' ? '' : line[0]}</span>
              <code>{line.slice(1) || ' '}</code>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The History tab: every version of the lesson, what made it, what it cost and whether it was
 * built; any two compared (narration word by word, scenes line by line); and Restore, which makes
 * an earlier version the next one, at once when its render is still kept.
 */
export default function History({ g, toast }) {
  const [list, setList] = useState(null);
  const [pair, setPair] = useState(null); // [older, newer]
  const [files, setFiles] = useState({});
  const busy = g.status === 'queued' || g.status === 'processing';

  useEffect(() => {
    let live = true;
    api.versions(g.id).then((v) => {
      if (!live) return;
      setList(v);
      const ns = v.versions.map((x) => x.n);
      setPair((p) => (p && ns.includes(p[0]) && ns.includes(p[1]) ? p : ns.length > 1 ? [ns[1], ns[0]] : null));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [g.id, g.version, g.builtVersion, g.status]);

  useEffect(() => {
    if (!pair) return;
    for (const n of pair) {
      if (files[n]) continue;
      api.versionSource(g.id, n).then((s) => setFiles((f) => ({ ...f, [n]: s }))).catch(() => {});
    }
  }, [pair, g.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const restore = async (n) => {
    if (!window.confirm(`Make v${n} the lesson again? It becomes v${(list.current || 0) + 1}; nothing is deleted.`)) return;
    try {
      const after = await api.restore(g.id, n);
      toast({ kind: 'success', text: after.status === 'done' ? `v${n} is back, as v${after.version}. Its render was kept, so it plays now.` : `v${n} is back as v${after.version}, and is being built.` });
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 9000 });
    }
  };

  if (!list) return <p className="hint">Loading…</p>;
  if (!list.versions.length) return <p className="status-box">No versions yet. The first appears once the lesson is written.</p>;
  const [a, b] = pair || [];
  const A = files[a];
  const B = files[b];
  const options = list.versions.map((v) => <option key={v.n} value={v.n}>v{v.n} · {SOURCE[v.source] || v.source}</option>);

  return (
    <div className="history-tab">
      <ul className="versions">
        {list.versions.map((v) => (
          <li key={v.n} className={v.n === list.current ? 'current' : ''}>
            <div className="version-head">
              <strong>v{v.n}</strong>
              <span className="chip">{SOURCE[v.source] || v.source}</span>
              {v.n === list.current && <span className="chip on">current</span>}
              {v.n === list.built && <span className="chip on">playing</span>}
              <span className="hint">{timeAgo(v.createdAt)}</span>
              <span className="grow" />
              {v.n !== list.current && <button className="btn" disabled={busy} onClick={() => restore(v.n)}>Restore</button>}
            </div>
            {v.details?.request && (
              <div className="revision-note">
                <q>{v.details.request}</q>
                {v.details.summary && <span> {v.details.summary}.</span>}
                {v.details.scope && v.details.scope.kind !== 'lesson' && <span className="hint"> Asked about {v.details.scope.kind === 'scene' ? `scene ${v.details.scope.name}` : `block [${v.details.scope.id}]`}.</span>}
                {v.details.outsideScope?.length > 0 && <span className="hint warn"> Also changed outside it: {v.details.outsideScope.join(', ')}.</span>}
              </div>
            )}
            <div className="hint">
              {[
                v.details?.request ? null : v.note,
                v.costUsd != null ? `${fmtUsd(v.costUsd)} to write` : null,
                v.checkOk == null ? null : v.checkOk ? `checked${v.warnings ? `, ${v.warnings} warning${v.warnings === 1 ? '' : 's'}` : ''}` : 'failed its check',
                v.builtAt ? `built${v.quality ? ` at ${v.quality}` : ''}${v.durationSec ? `, ${fmtDuration(v.durationSec)}` : ''}${v.renderKept ? '' : ', render not kept'}` : 'not built',
              ].filter(Boolean).join(' · ')}
            </div>
          </li>
        ))}
      </ul>

      {pair && (
        <section className="block compare">
          <div className="row wrap">
            <h4>Compare</h4>
            <select className="input" aria-label="Older version" value={a} onChange={(e) => setPair([Number(e.target.value), b])}>{options}</select>
            <span>with</span>
            <select className="input" aria-label="Newer version" value={b} onChange={(e) => setPair([a, Number(e.target.value)])}>{options}</select>
          </div>
          {!A || !B ? <p className="hint">Loading…</p> : (
            <>
              {(A.voice !== B.voice || A.speed !== B.speed) && (
                <p className="hint">{A.voice !== B.voice ? `Voice: ${A.voice} → ${B.voice}. ` : ''}{A.speed !== B.speed ? `Speed: ${A.speed}× → ${B.speed}×.` : ''}</p>
              )}
              <h4>Narration</h4>
              <NarrationDiff a={A.script} b={B.script} />
              <h4>scenes.py</h4>
              <ScenesDiff a={A.scenes} b={B.scenes} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
