// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Library from './Library.jsx';

const base = { kind: 'video', voiceId: 'af_heart', voiceName: 'Heart', wordCount: 391, createdAt: Date.now(), tags: [], preview: '', settings: { lesson: { costUsd: 0.7 } } };
const ITEMS = [
  { ...base, id: 'wait', title: 'Waiting lesson', status: 'awaiting', stage: 'Storyboard ready: have a look', version: 1, videoUrl: null, posterUrl: null },
  { ...base, id: 'again', title: 'Rebuilding lesson', status: 'processing', progressDone: 1, progressTotal: 3, version: 2, builtVersion: 1, videoUrl: '/v', posterUrl: '/p', durationSec: 129 },
];

function show(filters = {}) {
  const props = {
    mode: 'lessons',
    list: { items: ITEMS, total: ITEMS.length, loaded: true, error: '' },
    filters: { q: '', status: '', voiceId: '', tag: '', favorite: false, sort: '', ...filters },
    setFilters: vi.fn(), stats: { voices: [] }, tags: [], selectedId: null,
    onOpen: vi.fn(), onFavorite: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onMore: vi.fn(),
  };
  render(<Library {...props} />);
  return props;
}
afterEach(cleanup);

describe('library cards for lessons', () => {
  it('a lesson waiting for you says so and opens to be looked over', () => {
    const props = show();
    const card = screen.getByText('Waiting lesson').closest('article');
    expect(within(card).getByText('Storyboard ready: have a look')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Look over Waiting lesson' }));
    expect(props.onOpen).toHaveBeenCalledWith('wait', false);
    expect(within(card).getByText('$0.70')).toBeTruthy();
  });

  it('a lesson being rebuilt still plays its last version', () => {
    const props = show();
    const card = screen.getByText('Rebuilding lesson').closest('article');
    const play = within(card).getByRole('button', { name: 'Play Rebuilding lesson' });
    expect(play.disabled).toBe(false);
    fireEvent.click(play);
    expect(props.onOpen).toHaveBeenCalledWith('again', true);
    expect(within(card).getByText('v2')).toBeTruthy();
    expect(within(card).getByRole('progressbar')).toBeTruthy();
  });

  it('can be filtered to the lessons that need you', () => {
    const props = show();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'awaiting' } });
    expect(props.setFilters).toHaveBeenCalledWith(expect.objectContaining({ status: 'awaiting' }));
  });
});
