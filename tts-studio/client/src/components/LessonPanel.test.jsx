// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LessonPanel from './LessonPanel.jsx';
import { api } from '../api.js';
import { MAX_FILES, MAX_NOTES } from '../../../shared/limits.js';

vi.mock('../api.js', () => ({ api: { createLesson: vi.fn(), estimate: vi.fn() } }));

const VOICES = [
  { voiceId: 'ef_dora', name: 'Dora', lang: 'e' },
  { voiceId: 'af_heart', name: 'Heart', lang: 'a', gender: 'female' },
  { voiceId: 'bm_george', name: 'George', lang: 'b', gender: 'male' },
];
const file = (name, body = 'x', type = '') => new File([body], name, { type });
const CC = { provider: 'claude-code', label: 'Claude Code', model: '', effort: 'high', caps: {} };
const ESTIMATE = { lowUsd: 0.4, highUsd: 1.1, free: false, unknown: [], note: null, problem: null, notesGo: [{ where: 'Anthropic', steps: ['writing the lesson'], local: false }], writer: { read: CC, write: CC, fix: CC, polish: CC } };
const STUDIO = {
  values: { 'lesson.defaults': { minutes: 3, quality: 'medium', review: 'storyboard', visualReview: true, voiceId: 'bm_george' } },
  providers: [
    { id: 'claude-code', kind: 'claude-code', label: 'Claude Code', configured: true, test: null, models: [] },
    { id: 'ollama', kind: 'ollama', label: 'This Mac: Ollama', configured: true, test: { ok: true, caps: { 'qwen3:8b': {} } }, models: ['qwen3:8b'] },
    { id: 'groq', kind: 'groq', label: 'Groq', configured: false, models: [] },
  ],
};

let toast, onQueued, addRef;
function show(props = {}) {
  toast = vi.fn();
  onQueued = vi.fn(async () => {});
  addRef = { current: null };
  return render(<LessonPanel voices={VOICES} defaultVoiceId="af_heart" engineReady toast={toast} onQueued={onQueued} addRef={addRef} {...props} />);
}
const add = (files) => act(() => addRef.current(files));
const notes = () => screen.getByLabelText('Your notes');
const make = () => screen.getByRole('button', { name: /make the video/i });

beforeEach(() => {
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
  api.createLesson.mockReset().mockResolvedValue({ generation: { id: 'g1' } });
  api.estimate.mockReset().mockResolvedValue(ESTIMATE);
});
afterEach(cleanup);

describe('the lesson form', () => {
  it('offers only English voices, since animations follow individual words', () => {
    show();
    const voice = screen.getByLabelText('Voice');
    expect([...voice.options].map((o) => o.value)).toEqual(['af_heart', 'bm_george']);
    expect(voice.value).toBe('af_heart');
  });

  it('needs a topic before it can be sent', () => {
    show();
    expect(make().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Binary search' } });
    expect(make().disabled).toBe(false);
  });

  it('puts dropped text files into the notes and names them', async () => {
    show();
    fireEvent.change(notes(), { target: { value: 'typed first' } });
    await add([file('chain.md', '  dL/dw = x  \n'), file('empty.txt', '   ')]);
    expect(notes().value).toBe('typed first\n\n# From chain.md\n\ndL/dw = x');
    expect(screen.getByText(/Added the text of chain\.md\./)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('attaches photos, PDFs and documents, and says what it skipped', async () => {
    show();
    await add([file('page.HEIC'), file('paper.pdf'), file('working.docx'), file('sheet.xlsx'), file('photo.png')]);
    expect(screen.getAllByRole('listitem').map((li) => li.querySelector('.attachment-name').textContent)).toEqual(['page.HEIC', 'paper.pdf', 'working.docx', 'photo.png']);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1); // only the PNG can be shown in a browser
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', text: expect.stringContaining('Skipped sheet.xlsx') }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo.png' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb');
  });

  it('stops at the file limit the server enforces', async () => {
    show();
    await add(Array.from({ length: MAX_FILES + 2 }, (_, i) => file(`p${i}.pdf`)));
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_FILES);
    expect(toast.mock.calls[0][0].text).toContain(`at most ${MAX_FILES} files`);
  });

  it('will not send notes longer than the limit', () => {
    show();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Limits' } });
    fireEvent.change(notes(), { target: { value: 'x'.repeat(MAX_NOTES + 1) } });
    expect(make().disabled).toBe(true);
    expect(screen.getByText(/The notes are too long/)).toBeTruthy();
  });

  it('sends the lesson with its files in base64, then clears the form', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    fireEvent.change(screen.getByLabelText('What do you want to understand?'), { target: { value: 'why it multiplies' } });
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '3' } });
    await add([file('paper.pdf', 'PDF!')]);
    fireEvent.click(make());

    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.createLesson).toHaveBeenCalledWith({
      topic: 'Chain rule', goal: 'why it multiplies', notes: '', minutes: 3, quality: 'default', voiceId: 'af_heart',
      attachments: [{ name: 'paper.pdf', data: btoa('PDF!') }], review: 'render', visualReview: false,
    });
    expect(screen.getByLabelText('Topic').value).toBe('');
    expect(screen.queryByRole('list')).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }));
  });

  it('can stop at the storyboard and ask the writer to look over its frames', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    fireEvent.click(screen.getByLabelText('Show me the storyboard'));
    fireEvent.click(screen.getByLabelText(/look over its own frames/));
    fireEvent.click(make());
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.createLesson).toHaveBeenCalledWith(expect.objectContaining({ review: 'storyboard', visualReview: true }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/waits for you at its storyboard/) }));
  });

  it('starts from the defaults in Settings, and shows who writes it and about what it costs', async () => {
    show({ studio: STUDIO });
    expect(screen.getByLabelText('Length').value).toBe('3');
    expect(screen.getByLabelText('Quality').value).toBe('medium');
    expect(screen.getByLabelText('Voice').value).toBe('bm_george');
    expect(screen.getByLabelText('Show me the storyboard').checked).toBe(true);
    await waitFor(() => expect(screen.getByText(/about \$0\.40–\$1\.10/)).toBeTruthy());
    expect(screen.getByText(/Notes go to Anthropic/)).toBeTruthy();
    const writer = screen.getByLabelText('Written by');
    expect([...writer.options].map((o) => o.textContent)).toEqual(['As in Settings (Claude Code)', 'Claude Code', 'This Mac: Ollama · qwen3:8b']);
  });

  it('can write one lesson with another set-up writer, and send only some pages of a PDF', async () => {
    show({ studio: STUDIO });
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    fireEvent.change(await screen.findByLabelText('Written by'), { target: { value: JSON.stringify({ provider: 'ollama', model: 'qwen3:8b' }) } });
    await waitFor(() => expect(api.estimate).toHaveBeenLastCalledWith(expect.objectContaining({ writer: { provider: 'ollama', model: 'qwen3:8b' } })));
    await add([file('paper.pdf', 'PDF!')]);
    fireEvent.change(screen.getByLabelText('Pages of paper.pdf'), { target: { value: '1-3, 7x' } });
    fireEvent.click(screen.getByLabelText('text only'));
    fireEvent.click(make());
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.createLesson).toHaveBeenCalledWith(expect.objectContaining({
      writer: { provider: 'ollama', model: 'qwen3:8b' },
      attachments: [{ name: 'paper.pdf', data: btoa('PDF!'), pages: '1-3, 7', asText: true }],
    }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/^This Mac: Ollama is writing/) }));
  });

  it('writes a long lesson in chapters, after an outline you can review', async () => {
    api.estimate.mockResolvedValue({ ...ESTIMATE, lowUsd: 3.6, highUsd: 16.2, chapters: 5 });
    show({ studio: { ...STUDIO, values: { ...STUDIO.values, costs: { lessonCapUsd: 15 } } } });
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Backpropagation' } });
    expect(screen.getByLabelText('Show me the narration first')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show me the narration first'));
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '20' } });
    expect(screen.queryByLabelText('Show me the narration first')).toBeNull(); // the outline is reviewed instead
    expect(screen.getByLabelText(/Show me the outline before writing the chapters/).checked).toBe(true);
    await waitFor(() => expect(screen.getByText(/for an outline and about 5 chapters/)).toBeTruthy());
    expect(screen.getByText(/could reach the cap of \$15\.00 a lesson/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('A title card before each chapter'));
    fireEvent.click(make());
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.createLesson).toHaveBeenCalledWith(expect.objectContaining({ minutes: 20, review: 'render', outlineReview: true, titleCards: false }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/waits for you once the outline is written/) }));
  });

  it('will not start when the chosen writer is not ready', async () => {
    api.estimate.mockResolvedValue({ ...ESTIMATE, problem: 'Groq, chosen for “Writing the lesson”, has no key.' });
    show({ studio: STUDIO });
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    await waitFor(() => expect(screen.getByText(/has no key/)).toBeTruthy());
    expect(make().disabled).toBe(true);
  });

  it('keeps what was typed when the server refuses', async () => {
    api.createLesson.mockRejectedValue(new Error('Lessons need an English voice.'));
    show();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    fireEvent.click(make());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', text: 'Lessons need an English voice.' })));
    expect(screen.getByLabelText('Topic').value).toBe('Chain rule');
    expect(onQueued).not.toHaveBeenCalled();
  });
});
