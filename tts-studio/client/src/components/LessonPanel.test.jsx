// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LessonPanel from './LessonPanel.jsx';
import { api } from '../api.js';
import { MAX_FILES, MAX_NOTES } from '../../../shared/limits.js';

vi.mock('../api.js', () => ({ api: { createLesson: vi.fn() } }));

const VOICES = [
  { voiceId: 'ef_dora', name: 'Dora', lang: 'e' },
  { voiceId: 'af_heart', name: 'Heart', lang: 'a', gender: 'female' },
  { voiceId: 'bm_george', name: 'George', lang: 'b', gender: 'male' },
];
const file = (name, body = 'x', type = '') => new File([body], name, { type });

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

  it('can stop at the storyboard and ask Claude to look over its frames, and remembers both', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Chain rule' } });
    fireEvent.click(screen.getByLabelText('Show me the storyboard'));
    fireEvent.click(screen.getByLabelText(/look over its own frames/));
    fireEvent.click(make());
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(api.createLesson).toHaveBeenCalledWith(expect.objectContaining({ review: 'storyboard', visualReview: true }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/waits for you at its storyboard/) }));
    cleanup();
    show();
    expect(screen.getByLabelText('Show me the storyboard').checked).toBe(true);
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
