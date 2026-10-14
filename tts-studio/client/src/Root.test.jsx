// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import Root from './Root.jsx';
import { api } from './api.js';

vi.mock('./api.js', () => ({ api: { session: vi.fn(), profiles: vi.fn() } }));
vi.mock('./App.jsx', () => ({ default: ({ profile }) => <div>the dashboard for {profile ? profile.name : 'nobody'}</div> }));

const SAM = { id: 'o1', name: 'Sam', avatar: { color: '#c2410c', glyph: 'S' }, locked: false, isOwner: true };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.location.hash = '';
});

describe('Root', () => {
  it('opens the dashboard with no gate for an install of one profile with no PIN', async () => {
    api.session.mockResolvedValue({ profile: SAM, needsGate: false, implicit: true });
    render(<Root />);
    expect(await screen.findByText('the dashboard for Sam')).toBeTruthy();
    expect(api.profiles).not.toHaveBeenCalled();
  });

  it('shows Who’s watching? when no one has chosen yet', async () => {
    api.session.mockResolvedValue({ profile: null, needsGate: true });
    api.profiles.mockResolvedValue({ profiles: [SAM], max: 5, canAdd: true });
    render(<Root />);
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    expect(screen.queryByText(/the dashboard/)).toBeNull();
  });

  it('shows the gate on #who even when signed in, with a way back', async () => {
    window.location.hash = '#who';
    api.session.mockResolvedValue({ profile: SAM, needsGate: false, implicit: true });
    api.profiles.mockResolvedValue({ profiles: [SAM], max: 5, canAdd: true });
    render(<Root />);
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '← Back' })).toBeTruthy();
  });

  it('goes back to the gate when a session ends mid-use', async () => {
    api.session.mockResolvedValueOnce({ profile: SAM, needsGate: true });
    api.session.mockResolvedValue({ profile: null, needsGate: true });
    api.profiles.mockResolvedValue({ profiles: [SAM], max: 5, canAdd: true });
    render(<Root />);
    await screen.findByText('the dashboard for Sam');
    act(() => {
      window.dispatchEvent(new Event('tts:signin'));
    });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Who’s watching?' })).toBeTruthy());
  });

  it('still opens the page when the server does not answer, so its own banner can say so', async () => {
    api.session.mockRejectedValue(new Error('down'));
    render(<Root />);
    expect(await screen.findByText('the dashboard for nobody')).toBeTruthy();
  });
});
