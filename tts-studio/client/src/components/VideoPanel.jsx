import { useEffect, useState } from 'react';
import { api } from '../api.js';

const QUALITIES = [
  ['default', '1080p (manim default)'],
  ['low', '480p, quick check'],
  ['medium', '720p'],
  ['hd', '1080p'],
  ['4k', '4K'],
];

/** Build a narrated video from a project in video/projects; the result lands in the library. */
export default function VideoPanel({ onQueued, toast }) {
  const [projects, setProjects] = useState(null);
  const [project, setProject] = useState('');
  const [quality, setQuality] = useState('default');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .videoProjects()
      .then((r) => {
        setProjects(r.projects);
        setProject((p) => p || r.projects[0]?.name || '');
      })
      .catch(() => setProjects([]));
  }, []);

  const chosen = projects?.find((p) => p.name === project);

  const build = async () => {
    setBusy(true);
    try {
      await api.buildVideo({ project, quality });
      toast({ kind: 'success', text: `Building “${project}”. It appears in the library when done.` });
      await onQueued();
    } catch (e) {
      toast({ kind: 'error', text: e.message, ms: 10000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <details>
        <summary>Narrated video</summary>
        {projects === null ? (
          <span className="hint">Looking for projects…</span>
        ) : projects.length === 0 ? (
          <span className="hint">
            No projects found. Each one is a folder in <code>video/projects/</code>; see <code>video/README.md</code>.
          </span>
        ) : (
          <>
            <label className="field">
              <span>Project</span>
              <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              {chosen && (
                <span className="hint">
                  {chosen.scenes.length} scene{chosen.scenes.length === 1 ? '' : 's'} · voice {chosen.voice}
                </span>
              )}
            </label>
            <label className="field">
              <span>Quality</span>
              <select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}>
                {QUALITIES.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </label>
            <div className="row">
              <button className="btn primary grow" disabled={busy || !chosen?.scenes.length} onClick={build}>
                {busy ? 'Queuing…' : 'Build video'}
              </button>
            </div>
            <p className="hint">Speaks the script, renders every scene and adds captions. Takes a minute or more.</p>
          </>
        )}
      </details>
    </section>
  );
}
