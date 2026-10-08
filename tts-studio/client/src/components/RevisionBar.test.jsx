// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import RevisionBar, { scopeLabel } from './RevisionBar.jsx';
import Workspace from './Workspace.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { revise: vi.fn(), get: vi.fn(), versions: vi.fn(), transcript: vi.fn(), storyboard: vi.fn() } }));

const G = { id: 'g1', version: 2, status: 'done', text: '[intro]\nHello.\n\n[chain]\nTwo links.', settings: { scenes: ['Intro', 'Chain'], lesson: { review: 'render' } } };

function Harness({ g = G, videoRef = null }) {
  const [scope, setScope] = useState({ kind: 'lesson' });
  return <RevisionBar g={g} scope={scope} setScope={setScope} videoRef={videoRef} toast={toast} />;
}
let toast;
beforeEach(() => {
  toast = vi.fn();
  api.revise.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('asking for a change', () => {
  it('sends the request with the scope chosen', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('What to change'), { target: { value: 'Slow it down' } });
    fireEvent.change(screen.getByLabelText('A scene'), { target: { value: 'Chain' } });
    expect(screen.getByText(/Scene: Chain/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show me the storyboard first'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.revise).toHaveBeenCalledWith('g1', { request: 'Slow it down', scope: { kind: 'scene', name: 'Chain' }, attachments: [], review: 'storyboard' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/until v3 is ready/) }));
    expect(screen.getByLabelText('What to change').value).toBe('');
  });

  it('offers the moment the video is paused at', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 41.3, writable: true });
    render(<Harness videoRef={{ current: video }} />);
    act(() => video.dispatchEvent(new Event('pause')));
    fireEvent.click(await screen.findByRole('button', { name: /Paused at/ }));
    fireEvent.change(screen.getByLabelText('What to change'), { target: { value: 'Clearer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.revise).toHaveBeenCalledWith('g1', expect.objectContaining({ scope: { kind: 'time', at: 41.3 } })));
  });

  it('says when the last change could not be made', () => {
    render(<Harness g={{ ...G, settings: { ...G.settings, lastRevision: { ok: false, request: 'Add a graph', error: 'The scenes still fail after 3 fixes.' } } }} />);
    expect(screen.getByText(/“Add a graph”, could not be made: The scenes still fail after 3 fixes\. The lesson is as it was\./)).toBeTruthy();
  });

  it('labels scopes', () => {
    expect(scopeLabel({ kind: 'block', id: 'x' })).toBe('Block: [x]');
    expect(scopeLabel(undefined)).toBe('Whole lesson');
  });
});

describe('a narration waiting for approval', () => {
  it('is shown to read, and approved to have its scenes written', async () => {
    api.get.mockResolvedValue({ ...G, version: 0, status: 'awaiting', stage: 'Narration ready: have a look', title: 'Slope', videoUrl: null, createdAt: 0, tags: [], settings: { project: 'p', quality: 'default', lesson: { topic: 'Slope', minutes: 1, phase: 'script', attachments: [] } } });
    api.versions.mockResolvedValue({ current: 0, built: 0, versions: [] });
    const onApprove = vi.fn();
    render(<Workspace id="g1" tab="watch" onClose={vi.fn()} onPatch={vi.fn()} onDelete={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} onApprove={onApprove} toast={toast} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve the narration' }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), expect.objectContaining({ action: 'scenes' }));
    expect(screen.getByText(/Two links\./)).toBeTruthy();
    expect(screen.queryByLabelText('What to change')).toBeNull();
  });
});
