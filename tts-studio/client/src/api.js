async function req(path, { method = 'GET', body } = {}) {
  // body may be an object (sent as JSON) or left out.
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), {
      status: res.status,
      data,
    });
  }
  return data;
}

const query = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v !== undefined && v !== null && v !== false) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => req('/health'),
  voices: () => req('/voices'),
  stats: () => req('/stats'),
  tags: () => req('/tags'),
  list: (params) => req(`/generations${query(params)}`),
  get: (id) => req(`/generations/${id}`),
  create: (body) => req('/generations', { method: 'POST', body }),
  patch: (id, body) => req(`/generations/${id}`, { method: 'PATCH', body }),
  remove: (id, { project = false } = {}) => req(`/generations/${id}${query({ project: project && 1 })}`, { method: 'DELETE' }),
  retry: (id) => req(`/generations/${id}/retry`, { method: 'POST' }),
  cancel: (id) => req(`/generations/${id}/cancel`, { method: 'POST' }),
  videoProjects: () => req('/video/projects'),
  buildVideo: (body) => req('/videos', { method: 'POST', body }),
  createLesson: (body) => req('/lessons', { method: 'POST', body }),
  approve: (id, body = {}) => req(`/generations/${id}/approve`, { method: 'POST', body: { action: 'render', ...body } }),
  storyboard: (id, version, chapter) => req(`/generations/${id}/storyboard${query({ version, chapter })}`),
  versions: (id) => req(`/generations/${id}/versions`),
  // Editing a lesson: its working copy, a save checked at once, a full check, a render, and versions.
  // A lesson in chapters is edited a chapter at a time: `chapter` names it.
  source: (id, chapter) => req(`/generations/${id}/source${query({ chapter })}`),
  saveSource: (id, body) => req(`/generations/${id}/source`, { method: 'PUT', body }),
  checkEdit: (id, chapter) => req(`/generations/${id}/check`, { method: 'POST', body: { chapter } }),
  buildEdit: (id, quality, chapter) => req(`/generations/${id}/build`, { method: 'POST', body: { quality, chapter } }),
  discard: (id) => req(`/generations/${id}/discard`, { method: 'POST' }),
  restore: (id, version) => req(`/generations/${id}/restore`, { method: 'POST', body: { version } }),
  versionSource: (id, n, chapter) => req(`/generations/${id}/versions/${n}/source${query({ chapter })}`),
  transcript: (id) => req(`/generations/${id}/transcript`),
  revise: (id, body) => req(`/generations/${id}/revise`, { method: 'POST', body }),
  // A long lesson's outline: read, changed while it waits, redone on request.
  outline: (id) => req(`/generations/${id}/outline`),
  saveOutline: (id, outline) => req(`/generations/${id}/outline`, { method: 'PUT', body: { outline } }),
  redoOutline: (id, request) => req(`/generations/${id}/outline/redo`, { method: 'POST', body: { request } }),
  // Settings: who writes lessons, defaults, Claude's limits, costs. Keys go in and never come back.
  settings: () => req('/settings'),
  patchSettings: (body) => req('/settings', { method: 'PATCH', body }),
  undoSettings: (seq) => req('/settings/undo', { method: 'POST', body: seq ? { seq } : {} }),
  saveProvider: (id, body) => req(`/providers/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  removeProvider: (id) => req(`/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setKey: (id, key) => req(`/providers/${encodeURIComponent(id)}/key`, { method: 'PUT', body: { key } }),
  removeKey: (id) => req(`/providers/${encodeURIComponent(id)}/key`, { method: 'DELETE' }),
  testProvider: (id, model) => req(`/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: { model } }),
  providerModels: (id) => req(`/providers/${encodeURIComponent(id)}/models`),
  estimate: (body) => req('/estimate', { method: 'POST', body }),
  connect: () => req('/connect'),
};
