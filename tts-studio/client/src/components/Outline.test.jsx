// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Outline from './Outline.jsx';
import Workspace, { ChapterPicker } from './Workspace.jsx';
import Transcript from './Transcript.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: { outline: vi.fn(), saveOutline: vi.fn(), redoOutline: vi.fn(), get: vi.fn(), versions: vi.fn(), storyboard: vi.fn(), transcript: vi.fn(), source: vi.fn(), revise: vi.fn() },
}));

const OUTLINE = {
  title: 'Backpropagation',
  through_line: 'One neuron, then a chain of them',
  notation: [{ tex: 'w', meaning: 'a weight', color: 'BLUE' }],
  chapters: [
    { id: '01-one-neuron', title: 'One neuron', minutes: 3, goal: 'What a weight does', covers: ['weights', 'bias'], from_notes: '', files: [], starts_from: '', ends_with: '', written: false },
    { id: '02-chain', title: 'The chain', minutes: 4, goal: 'Why the chain rule', covers: ['chain rule'], from_notes: '', files: ['page-2.jpg'], starts_from: '', ends_with: '', written: false },
  ],
  waiting: true,
};
const G = { id: 'g1', status: 'awaiting', stage: 'Outline ready: 2 chapters, about 7 minutes', settings: { lesson: { chaptered: true, phase: 'outline' } } };

let toast, onApprove;
beforeEach(() => {
  toast = vi.fn();
  onApprove = vi.fn(async () => {});
  for (const fn of Object.values(api)) fn.mockReset();
  api.outline.mockResolvedValue(OUTLINE);
});
afterEach(cleanup);

describe('the outline', () => {
  it('is approved as it is, and the chapters are written', async () => {
    render(<Outline g={G} quality="medium" onApprove={onApprove} toast={toast} />);
    expect(await screen.findByDisplayValue('One neuron')).toBeTruthy();
    expect(screen.getByText(/2 chapters · about 7 minutes/)).toBeTruthy();
    expect(screen.getByText('Uses page-2.jpg')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write the 2 chapters' }));
    expect(onApprove).toHaveBeenCalledWith(G, { quality: 'medium', action: 'chapters', chapters: 2 });
  });

  it('is changed here: chapters renamed, moved, removed and added, then sent with the approval', async () => {
    render(<Outline g={G} quality="default" onApprove={onApprove} toast={toast} />);
    fireEvent.change(await screen.findByLabelText('Title of chapter 1'), { target: { value: 'A single neuron' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move chapter 2 up' }));
    expect(screen.getByLabelText('Title of chapter 1').value).toBe('The chain');
    fireEvent.change(screen.getByLabelText('Length of chapter 2'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '＋ Add a chapter' }));
    expect(screen.getByRole('button', { name: 'Write the 3 chapters' }).disabled).toBe(true); // the new one needs a title
    fireEvent.change(screen.getByLabelText('Title of chapter 3'), { target: { value: 'Training' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove chapter 3' }));
    fireEvent.change(screen.getByLabelText('Colour of symbol 1'), { target: { value: 'GOLD' } });
    expect(screen.getByText('Changed here, not yet saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write the 2 chapters' }));
    const [, sent] = onApprove.mock.calls[0];
    expect(sent.action).toBe('chapters');
    expect(sent.outline.chapters.map((c) => [c.id, c.title, c.minutes])).toEqual([['02-chain', 'The chain', 4], ['01-one-neuron', 'A single neuron', 5]]);
    expect(sent.outline.notation[0].color).toBe('GOLD');
  });

  it('saves changes, and is asked for again in other words', async () => {
    api.saveOutline.mockImplementation(async (id, o) => ({ outline: o, generation: G }));
    api.redoOutline.mockResolvedValue({});
    render(<Outline g={G} quality="default" onApprove={onApprove} toast={toast} />);
    const covers = await screen.findAllByLabelText(/It covers/);
    fireEvent.change(covers[0], { target: { value: 'weights\n\nbias\nthe sum' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveOutline).toHaveBeenCalled());
    expect(api.saveOutline.mock.calls[0][1].chapters[0].covers).toEqual(['weights', 'bias', 'the sum']);
    expect(await screen.findByText('Saved.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('What to change in the outline'), { target: { value: 'Fewer symbols' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write it again' }));
    await waitFor(() => expect(api.redoOutline).toHaveBeenCalledWith('g1', 'Fewer symbols'));
  });

  it('is read-only once the chapters are being written', async () => {
    api.outline.mockResolvedValue({ ...OUTLINE, waiting: false, chapters: OUTLINE.chapters.map((c, i) => ({ ...c, written: i === 0 })) });
    render(<Outline g={{ ...G, status: 'processing' }} quality="default" onApprove={onApprove} toast={toast} />);
    expect(await screen.findByText('One neuron')).toBeTruthy();
    expect(screen.getByText('3 min · written')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Write the/ })).toBeNull();
  });
});

describe('a lesson in chapters', () => {
  const LONG = {
    id: 'g1', kind: 'video', title: 'Backpropagation', status: 'done', stage: null, version: 1, builtVersion: 1, videoUrl: '/api/generations/g1/video', voiceId: 'af_heart', wordCount: 900, createdAt: 0, text: '', tags: [],
    settings: { project: 'bp', quality: 'default', lesson: { topic: 'Backprop', minutes: 10, chaptered: true, chapters: [{ id: '01-one-neuron', title: 'One neuron', minutes: 3 }, { id: '02-chain', title: 'The chain', minutes: 4 }], attachments: [] } },
  };
  const props = () => ({ onClose: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onApprove: vi.fn(), toast: vi.fn() });
  beforeEach(() => {
    api.versions.mockResolvedValue({ current: 1, built: 1, versions: [{ n: 1, source: 'written', createdAt: 0 }] });
    api.storyboard.mockResolvedValue({ scenes: [], unplayed: [] });
    api.transcript.mockRejectedValue(new Error('none'));
    api.source.mockImplementation(async (id, chapter) => ({ chapter, script: `[${chapter}-intro]\nHello.\n`, scenes: `class Open${chapter.slice(0, 2)}(VoiceoverScene, Scene):\n    pass\n` }));
  });

  it('has an Outline tab, and waits there for you', async () => {
    api.get.mockResolvedValue({ ...LONG, status: 'awaiting', version: 0, builtVersion: 0, videoUrl: null, settings: { ...LONG.settings, lesson: { ...LONG.settings.lesson, phase: 'outline' } } });
    render(<Workspace id="g1" tab="watch" {...props()} />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Watch', 'Outline', 'Storyboard', 'Edit', 'History', 'Notes']);
    expect(screen.getByText(/The outline is ready: 2 chapters/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review the outline' }).getAttribute('href')).toBe('#lesson/g1/outline');
  });

  it('shows one chapter at a time in the storyboard', async () => {
    api.get.mockResolvedValue(LONG);
    render(<Workspace id="g1" tab="storyboard" {...props()} />);
    const picker = await screen.findByRole('group', { name: 'Chapter' });
    await waitFor(() => expect(api.storyboard).toHaveBeenCalledWith('g1', undefined, '01-one-neuron'));
    fireEvent.click(within(picker).getByRole('button', { name: 'Next chapter' }));
    await waitFor(() => expect(api.storyboard).toHaveBeenCalledWith('g1', undefined, '02-chain'));
    expect(within(picker).getByRole('button', { name: 'Next chapter' }).disabled).toBe(true);
  });

  it('asks for a change to the chapter shown, from its own scenes and blocks', async () => {
    api.get.mockResolvedValue(LONG);
    api.revise.mockResolvedValue({});
    render(<Workspace id="g1" tab="storyboard" {...props()} />);
    const picker = await screen.findByRole('group', { name: 'Chapter' });
    fireEvent.click(within(picker).getByRole('button', { name: 'Next chapter' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Which chapter' }).value).toBe('02-chain'));
    await waitFor(() => expect([...screen.getByLabelText('A scene').options].map((o) => o.value)).toEqual(['', 'Open02']));
    expect([...screen.getByLabelText('A block').options].map((o) => o.value)).toEqual(['', '02-chain-intro']);
    expect(screen.getByRole('button', { name: 'Whole chapter' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('A block'), { target: { value: '02-chain-intro' } });
    fireEvent.change(screen.getByLabelText('What to change'), { target: { value: 'Slower' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.revise).toHaveBeenCalledWith('g1', { request: 'Slower', scope: { kind: 'block', id: '02-chain-intro' }, chapter: '02-chain', attachments: [], review: 'render' }));
  });

  it('a short lesson has no Outline tab, even at its address', async () => {
    api.get.mockResolvedValue({ ...LONG, settings: { ...LONG.settings, lesson: { topic: 'x', minutes: 2, attachments: [] } } });
    render(<Workspace id="g1" tab="outline" {...props()} />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).not.toContain('Outline');
    expect(screen.getByRole('tab', { name: 'Watch' }).getAttribute('aria-selected')).toBe('true');
  });

  it('picks a chapter by name or by its neighbours', () => {
    const onChange = vi.fn();
    render(<ChapterPicker chapters={LONG.settings.lesson.chapters} value="02-chain" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous chapter' }));
    expect(onChange).toHaveBeenCalledWith('01-one-neuron');
    expect(screen.getByRole('combobox', { name: 'Chapter' }).value).toBe('02-chain');
  });

  it('lists the chapters beside the player, and heads each in the transcript', async () => {
    api.transcript.mockResolvedValue({
      chapters: [{ id: '01-a', title: 'One neuron', start: 0, end: 30 }, { id: '02-b', title: 'The chain', start: 30, end: 75 }],
      blocks: [
        { id: 'intro', chapter: '01-a', start: 0, end: 3, text: 'Hello.', words: [['Hello.', 0, 1]] },
        { id: 'intro', chapter: '02-b', start: 30, end: 33, text: 'Again.', words: [['Again.', 30, 31]] },
      ],
    });
    const video = document.createElement('video');
    video.play = vi.fn(async () => {});
    render(<Transcript id="g1" builtVersion={1} videoRef={{ current: video }} />);
    const nav = await screen.findByRole('navigation', { name: 'Chapters' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['One neuron0s', 'The chain30s']);
    expect(screen.getByRole('heading', { name: '2. The chain' })).toBeTruthy();
    fireEvent.click(within(nav).getByRole('button', { name: /The chain/ }));
    expect(video.currentTime).toBeCloseTo(30.01);
  });
});
