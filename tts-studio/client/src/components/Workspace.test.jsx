// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Workspace, { whoWrote } from './Workspace.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), versions: vi.fn(), storyboard: vi.fn() } }));

const LESSON = {
  id: 'g1', kind: 'video', title: 'Why the gradient collapses', status: 'awaiting', stage: 'Storyboard ready: have a look',
  version: 1, builtVersion: 0, videoUrl: null, voiceId: 'af_heart', wordCount: 391, createdAt: 0, text: '[model]\nA score z.', tags: [],
  settings: { project: 'grad-1', quality: 'default', lesson: { topic: 'Gradient', goal: 'Why', minutes: 2, costUsd: 0.7, fixes: 1, autofixed: 2, usage: { inputTokens: 900, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 4000 }, attachments: [] } },
};

let props;
function show(over = {}, tab = 'watch') {
  props = { onClose: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onApprove: vi.fn(), toast: vi.fn() };
  api.get.mockResolvedValue({ ...LESSON, ...over });
  return render(<Workspace id="g1" tab={tab} {...props} />);
}

beforeEach(() => {
  api.get.mockReset();
  api.versions.mockReset().mockResolvedValue({ current: 1, built: 0, versions: [{ n: 1, source: 'written', createdAt: 0 }] });
  api.storyboard.mockReset().mockResolvedValue({ scenes: [], unplayed: [] });
});
afterEach(cleanup);

describe('the lesson workspace', () => {
  it('a lesson waiting on its storyboard is approved at the quality chosen', async () => {
    show();
    const approve = await screen.findByRole('button', { name: 'Approve and render' });
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'medium' } });
    fireEvent.click(approve);
    expect(props.onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), { quality: 'medium' });
    expect(screen.getByText(/Nothing is rendered yet/)).toBeTruthy();
    expect(screen.getByText('v1 · Written')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t render' }));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('says what writing the lesson took', async () => {
    show({ status: 'done', stage: null, videoUrl: '/api/generations/g1/video', builtVersion: 1 });
    expect(await screen.findByText(/\$0\.70 · 6,900 tokens read \(6,000 from the cache\) · 4,000 written/)).toBeTruthy();
    expect(screen.getByText(/1 fix by the writer · 2 common mistakes fixed automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and render' })).toBeNull();
  });

  it('says who wrote each step', () => {
    expect(whoWrote([
      { step: 'write', provider: 'claude-code', label: 'Claude Code', model: 'claude-opus-5-5' },
      { step: 'fix', provider: 'ollama', label: 'This Mac: Ollama', model: 'qwen3-coder' },
      { step: 'polish', provider: 'ollama', label: 'This Mac: Ollama', model: 'qwen3-coder' },
    ])).toBe('Claude Code (claude-opus-5-5) wrote; This Mac: Ollama (qwen3-coder) fixed, polished');
    expect(whoWrote(undefined)).toBeNull();
  });

  it('has a tab for each view, each with its own address', async () => {
    show({}, 'notes');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('href')])).toEqual([
      ['Watch', '#lesson/g1/watch'], ['Storyboard', '#lesson/g1/storyboard'], ['Notes', '#lesson/g1/notes'],
    ]);
    expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Gradient')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Library' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
