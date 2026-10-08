// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import EditTab from './EditTab.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { source: vi.fn(), saveSource: vi.fn(), checkEdit: vi.fn(), buildEdit: vi.fn(), discard: vi.fn() } }));

// CodeMirror measures text; jsdom has no layout, so give it empty rectangles.
document.createRange = () => {
  const range = new Range();
  range.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  range.getClientRects = () => ({ item: () => null, length: 0, [Symbol.iterator]: [][Symbol.iterator] });
  return range;
};

const SOURCE = {
  project: 'slope-1', script: '[intro]\nEvery line has a <mark name="slope"/>slope.\n', scenes: 'from manimlib import *\n\nclass Intro:\n    pass\n',
  voice: 'af_heart', speed: 1, hash: 'h1', version: 1, builtVersion: 1, draft: false, editable: true, busy: false, static: null, report: null, edit: null,
};
const VOICES = [{ voiceId: 'af_heart', name: 'Heart', lang: 'a' }, { voiceId: 'bm_george', name: 'George', lang: 'b' }];
const G = { id: 'g1', status: 'done', version: 1, builtVersion: 1, settings: { quality: 'default' } };

const editor = (label) => EditorView.findFromDOM(screen.getByLabelText(label));
const type = (label, text) => act(() => {
  const v = editor(label);
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
});

let toast;
beforeEach(() => {
  toast = vi.fn();
  for (const fn of Object.values(api)) fn.mockReset();
  api.source.mockResolvedValue(SOURCE);
});
afterEach(cleanup);

describe('the Edit tab', () => {
  it('saves with the hash it started from, and puts problems on their lines', async () => {
    render(<EditTab g={G} voices={VOICES} toast={toast} />);
    await screen.findByLabelText('scenes.py');
    expect(screen.getByRole('status').textContent).toMatch(/^Saved/);
    type('scenes.py', 'from manimlib import *\n\nclass Intro:\n    open("x")\n');
    expect(screen.getByRole('status').textContent).toMatch(/Unsaved changes/);
    api.saveSource.mockResolvedValue({
      ...SOURCE, scenes: 'from manimlib import *\n\nclass Intro:\n    open("x")\n', hash: 'h2', draft: true,
      static: { ok: false, at: 2, errors: [{ where: 'scenes.py', file: 'scenes.py', line: 4, message: 'line 4: open is not allowed in a scene' }], warnings: [] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveSource).toHaveBeenCalledWith('g1', expect.objectContaining({ base: 'h1', scenes: expect.stringContaining('open("x")') })));
    expect(await screen.findByRole('button', { name: 'scenes.py:4' })).toBeTruthy();
    expect(screen.getByText('open is not allowed in a scene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Render v2' }).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/quick check · 1 problem/);
  });

  it('offers to reload when the files changed underneath', async () => {
    render(<EditTab g={G} voices={VOICES} toast={toast} />);
    await screen.findByLabelText('script.txt');
    type('script.txt', '[intro]\nMine.\n');
    api.saveSource.mockRejectedValue(Object.assign(new Error('changed'), { status: 409, data: { current: { ...SOURCE, script: '[intro]\nTheirs.\n', hash: 'h9' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }));
    expect(editor('script.txt').state.doc.toString()).toBe('[intro]\nTheirs.\n');
  });

  it('checks before rendering, saving first', async () => {
    render(<EditTab g={G} voices={VOICES} toast={toast} />);
    await screen.findByLabelText('script.txt');
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1.1' } });
    api.saveSource.mockResolvedValue({ ...SOURCE, speed: 1.1, hash: 'h3', draft: true });
    api.buildEdit.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Render v2' }));
    await waitFor(() => expect(api.buildEdit).toHaveBeenCalledWith('g1', 'default', null));
    expect(api.saveSource).toHaveBeenCalledWith('g1', expect.objectContaining({ speed: 1.1 }));
  });

  it('is read-only while the lesson is busy, and for projects written by hand', async () => {
    const { unmount } = render(<EditTab g={{ ...G, status: 'processing', stage: 'Building 2/4' }} voices={VOICES} toast={toast} />);
    await screen.findByLabelText('script.txt');
    expect(screen.getByText(/Building 2\/4… The files can be edited once it finishes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' }).disabled).toBe(true);
    expect(editor('script.txt').state.readOnly).toBe(true);
    unmount();
    api.source.mockResolvedValue({ ...SOURCE, editable: false, project: 'demo' });
    render(<EditTab g={G} voices={VOICES} toast={toast} />);
    expect(await screen.findByText(/written by hand/)).toBeTruthy();
  });
});
