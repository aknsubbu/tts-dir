async function req(path, { method = 'GET', body } = {}) {
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
  remove: (id) => req(`/generations/${id}`, { method: 'DELETE' }),
  retry: (id) => req(`/generations/${id}/retry`, { method: 'POST' }),
  cancel: (id) => req(`/generations/${id}/cancel`, { method: 'POST' }),
};
