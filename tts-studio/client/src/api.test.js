import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => answer(200, { ok: true }));
});
afterEach(() => vi.restoreAllMocks());

describe('api', () => {
  it('leaves empty filters out of the query', async () => {
    await api.list({ q: 'chain rule', status: '', favorite: false, kind: 'video', offset: 0 });
    expect(fetch.mock.calls[0][0]).toBe('/api/generations?q=chain+rule&kind=video&offset=0');
  });

  it('deletes the project folder only when asked', async () => {
    await api.remove('abc');
    await api.remove('abc', { project: true });
    expect(fetch.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
      ['/api/generations/abc', 'DELETE'],
      ['/api/generations/abc?project=1', 'DELETE'],
    ]);
  });

  it('turns a refusal into an error with the server’s words', async () => {
    fetch.mockResolvedValue(answer(400, { error: 'Say what the video should be about.' }));
    await expect(api.createLesson({})).rejects.toMatchObject({ message: 'Say what the video should be about.', status: 400 });
  });
});
