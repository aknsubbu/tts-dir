import { useEffect, useState } from 'react';

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const fmtNumber = (n) => (n == null ? '—' : Number(n).toLocaleString());

export function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString([], { dateStyle: 'medium' });
}

export const stripExt = (name) => name.replace(/\.[^./\\]+$/, '');

export const estimateSeconds = (words) => (words / 150) * 60;
export const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/** Split a server snippet into [{ text, hit }] parts using the marker characters. */
export function parseSnippet(snippet) {
  if (!snippet) return [];
  const parts = [];
  let hit = false;
  let buf = '';
  for (const ch of snippet) {
    if (ch === MARK_START || ch === MARK_END) {
      if (buf) parts.push({ text: buf, hit });
      buf = '';
      hit = ch === MARK_START;
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push({ text: buf, hit });
  return parts;
}

/** Split plain text into [{ text, hit }] parts, marking words that start with a search token. */
export function highlightParts(text, q) {
  const tokens = (q.match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 12);
  if (!tokens.length) return [{ text, hit: false }];
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useLocalStorage(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) {
        const parsed = JSON.parse(raw);
        return typeof initial === 'object' && initial !== null && !Array.isArray(initial)
          ? { ...initial, ...parsed }
          : parsed;
      }
    } catch {
      /* ignore */
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}

export const isActive = (g) => g.status === 'queued' || g.status === 'processing';
