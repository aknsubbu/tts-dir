// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageProfile, PinBoxes, PinEntry, ProfileMenu, WhoIsWatching } from './Profiles.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({
  api: {
    profiles: vi.fn(),
    allProfiles: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    addProfile: vi.fn(),
    patchProfile: vi.fn(),
    setPin: vi.fn(),
    removePin: vi.fn(),
    deleteProfile: vi.fn(),
  },
}));

const av = (color, glyph) => ({ color, glyph });
const OWNER = { id: 'o1', name: 'Sam', avatar: av('#c2410c', 'S'), locked: true, isOwner: true, canUseHostClaude: true, canUseHostKeys: true, requirePinToAdd: false };
const ROBIN = { id: 'r1', name: 'Robin', avatar: av('#0f766e', 'R'), locked: false, isOwner: false, canUseHostClaude: false, canUseHostKeys: false, requirePinToAdd: false };
const LIST = (extra = {}) => ({ profiles: [OWNER, ROBIN], max: 5, canAdd: true, needsOwnerPinToAdd: false, ...extra });
const fail = (status, error, data = {}) => Object.assign(new Error(error), { status, data: { error, ...data } });

beforeEach(() => {
  api.profiles.mockResolvedValue(LIST());
  api.allProfiles.mockResolvedValue({ profiles: [OWNER, ROBIN] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  window.location.hash = '';
});

describe('Who’s watching?', () => {
  it('shows a tile per profile with a padlock label on locked ones, and an Add profile tile', async () => {
    render(<WhoIsWatching onSignedIn={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Who’s watching?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sam, locked with a PIN' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Robin' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add profile/ })).toBeTruthy();
  });

  it('hides Add profile at the limit', async () => {
    api.profiles.mockResolvedValue(LIST({ canAdd: false }));
    render(<WhoIsWatching onSignedIn={() => {}} />);
    await screen.findByRole('button', { name: 'Robin' });
    expect(screen.queryByRole('button', { name: /Add profile/ })).toBeNull();
  });

  it('opens a profile with no PIN at once', async () => {
    api.signIn.mockResolvedValue({ profile: ROBIN });
    const onSignedIn = vi.fn();
    render(<WhoIsWatching onSignedIn={onSignedIn} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Robin' }));
    expect(api.signIn).toHaveBeenCalledWith('r1');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ROBIN, { manage: false }));
  });

  it('Manage profiles marks the tiles as editable, and signing in then goes to manage', async () => {
    api.signIn.mockResolvedValue({ profile: ROBIN });
    const onSignedIn = vi.fn();
    render(<WhoIsWatching onSignedIn={onSignedIn} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Manage profiles' }));
    expect(screen.getByRole('heading', { name: 'Manage profiles' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Robin, edit this profile' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(ROBIN, { manage: true }));
  });

  it('adds a profile and opens it', async () => {
    api.addProfile.mockResolvedValue({ profile: { ...ROBIN, id: 'n1', name: 'Kai' } });
    api.signIn.mockResolvedValue({ profile: { ...ROBIN, id: 'n1', name: 'Kai' } });
    const onSignedIn = vi.fn();
    render(<WhoIsWatching onSignedIn={onSignedIn} />);
    await userEvent.click(await screen.findByRole('button', { name: /Add profile/ }));
    const dialog = screen.getByRole('dialog', { name: 'Add profile' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Kai');
    await userEvent.type(within(dialog).getByLabelText('PIN (optional)'), '12a345');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add and open' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(api.addProfile).toHaveBeenCalledWith({ name: 'Kai', avatar: { color: '#0f766e', glyph: '' }, pin: '1234' });
    expect(api.signIn).toHaveBeenCalledWith('n1', '1234');
  });

  it('asks for the Owner’s PIN when the Owner wants to approve new profiles', async () => {
    api.profiles.mockResolvedValue(LIST({ needsOwnerPinToAdd: true }));
    render(<WhoIsWatching onSignedIn={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /Add profile/ }));
    expect(screen.getByLabelText('Owner’s PIN')).toBeTruthy();
  });

  it('shows an error from the server', async () => {
    api.profiles.mockRejectedValue(new Error('Cannot reach the server'));
    render(<WhoIsWatching onSignedIn={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Cannot reach/);
  });
});

describe('PIN entry', () => {
  const boxes = () => screen.getAllByLabelText(/digit \d of 4/);

  it('has four numeric boxes that move on by themselves and submits on the fourth digit', async () => {
    api.signIn.mockResolvedValue({ profile: OWNER });
    const onSuccess = vi.fn();
    render(<PinEntry profile={OWNER} onCancel={() => {}} onSuccess={onSuccess} />);
    expect(boxes()).toHaveLength(4);
    expect(boxes()[0].getAttribute('inputmode')).toBe('numeric');
    await userEvent.keyboard('4821'); // typed with no clicking: each digit moves focus on
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(OWNER));
    expect(api.signIn).toHaveBeenCalledWith('o1', '4821');
  });

  it('ignores letters, takes a pasted PIN, and Backspace goes back a box', async () => {
    const onDone = vi.fn();
    render(<PinBoxes label="PIN" onDone={onDone} />);
    await userEvent.click(boxes()[0]);
    await userEvent.keyboard('a');
    expect(boxes()[0].value).toBe('');
    await userEvent.paste('1234');
    expect(onDone).toHaveBeenCalledWith('1234');
    cleanup();
    render(<PinBoxes label="PIN" onDone={onDone} />);
    await userEvent.keyboard('12');
    await userEvent.keyboard('{Backspace}'); // the third box is empty: clear the second and step back to it
    expect(document.activeElement).toBe(boxes()[1]);
    expect(boxes().map((x) => x.value)).toEqual(['1', '', '', '']);
  });

  it('a wrong PIN shakes, says so, and clears the boxes', async () => {
    api.signIn.mockRejectedValue(fail(401, 'That PIN is not right.'));
    render(<PinEntry profile={OWNER} onCancel={() => {}} onSuccess={() => {}} />);
    await userEvent.keyboard('0000');
    expect((await screen.findByRole('status')).textContent).toBe('That PIN is not right.');
    expect(document.querySelector('.pin-shake.shake')).toBeTruthy();
    expect(boxes().map((b) => b.value)).toEqual(['', '', '', '']);
    expect(boxes()[0].disabled).toBe(false);
  });

  it('a lockout counts down, and the boxes wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.signIn.mockRejectedValue(fail(429, 'Too many wrong PINs.', { retryAfterSec: 30 }));
    render(<PinEntry profile={OWNER} onCancel={() => {}} onSuccess={() => {}} />);
    fireEvent.change(boxes()[0], { target: { value: '1234' } });
    expect((await screen.findByRole('status')).textContent).toMatch(/Try again in 0:30/);
    expect(boxes().every((b) => b.disabled)).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByRole('status').textContent).toMatch(/Try again in 0:2[4-6]/);
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(boxes()[0].disabled).toBe(false);
  });

  it('Forgot PIN? explains the Owner reset and the host command, with the profile’s name', async () => {
    render(<PinEntry profile={OWNER} onCancel={() => {}} onSuccess={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Forgot PIN?' }));
    expect(screen.getByText(/npm run profiles -- reset-pin Sam/)).toBeTruthy();
    expect(screen.getByText(/The Owner can reset it/)).toBeTruthy();
  });

  it('Escape closes it', async () => {
    const onCancel = vi.fn();
    render(<PinEntry profile={OWNER} onCancel={onCancel} onSuccess={() => {}} />);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('the header menu', () => {
  it('offers Switch profile, Manage profile and Sign out, and Escape closes it', async () => {
    api.signOut.mockResolvedValue({ ok: true });
    render(<ProfileMenu profile={ROBIN} />);
    const button = screen.getByRole('button', { name: /Robin/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(button);
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Switch profile', 'Manage profile', 'Sign out']);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Manage profile' }));
    expect(window.location.hash).toBe('#profile');
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Switch profile' }));
    expect(window.location.hash).toBe('#who');
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(api.signOut).toHaveBeenCalled();
  });

  it('shows nothing without a profile', () => {
    const { container } = render(<ProfileMenu profile={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('managing a profile', () => {
  const toast = vi.fn();

  it('lets a profile set a PIN, with four digits only', async () => {
    api.setPin.mockResolvedValue({});
    render(<ManageProfile profile={ROBIN} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    const set = screen.getByRole('button', { name: 'Set PIN' });
    expect(set.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('PIN'), '12x345');
    expect(screen.getByLabelText('PIN').value).toBe('1234');
    await userEvent.click(set);
    expect(api.setPin).toHaveBeenCalledWith('r1', { pin: '1234' });
  });

  it('changing or removing a PIN needs the current one', async () => {
    api.setPin.mockResolvedValue({});
    api.removePin.mockResolvedValue({});
    render(<ManageProfile profile={{ ...ROBIN, locked: true }} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    expect(screen.getByRole('button', { name: 'Change PIN' }).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Current PIN'), '1111');
    await userEvent.type(screen.getByLabelText('New PIN'), '2222');
    await userEvent.click(screen.getByRole('button', { name: 'Change PIN' }));
    expect(api.setPin).toHaveBeenCalledWith('r1', { pin: '2222', currentPin: '1111' });
    await userEvent.type(screen.getByLabelText('Current PIN'), '2222');
    await userEvent.click(screen.getByRole('button', { name: 'Remove PIN' }));
    expect(api.removePin).toHaveBeenCalledWith('r1', { currentPin: '2222' });
  });

  it('the Owner sees the others, and decides what each may borrow from the host', async () => {
    api.patchProfile.mockResolvedValue({});
    render(<ManageProfile profile={OWNER} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    const robin = (await screen.findByText('Robin')).closest('li');
    await userEvent.click(within(robin).getByLabelText(/Claude sign-in/));
    expect(api.patchProfile).toHaveBeenCalledWith('r1', { canUseHostClaude: true });
    await userEvent.click(within(robin).getByLabelText(/API keys/));
    expect(api.patchProfile).toHaveBeenCalledWith('r1', { canUseHostKeys: true });
  });

  it('only the Owner has the Owner’s section; a profile that is not the Owner can delete itself', async () => {
    render(<ManageProfile profile={ROBIN} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    expect(screen.queryByText('Other profiles')).toBeNull();
    expect(api.allProfiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Robin…' }));
    const go = screen.getByRole('button', { name: 'Delete forever' });
    expect(go.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Type “Robin”/), 'robin');
    expect(go.disabled).toBe(false);
  });

  it('the Owner needs their own PIN to reset another’s, and is told what to do with none', async () => {
    api.setPin.mockResolvedValue({});
    api.allProfiles.mockResolvedValue({ profiles: [OWNER, { ...ROBIN, locked: true }] });
    const { unmount } = render(<ManageProfile profile={OWNER} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset Robin’s PIN…' }));
    await userEvent.type(screen.getByLabelText('Your PIN (the Owner’s)'), '9999');
    await userEvent.type(screen.getByLabelText('New PIN (leave empty to remove it)'), '1357');
    await userEvent.click(screen.getByRole('button', { name: 'Set new PIN' }));
    expect(api.setPin).toHaveBeenCalledWith('r1', { pin: '1357', ownerPin: '9999' });
    unmount();
    render(<ManageProfile profile={{ ...OWNER, locked: false }} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset Robin’s PIN…' }));
    expect(screen.getByText(/npm run profiles -- reset-pin Robin/)).toBeTruthy();
  });

  it('the Owner can ask for their PIN before profiles are added, once they have one', async () => {
    api.patchProfile.mockResolvedValue({});
    render(<ManageProfile profile={OWNER} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    await userEvent.click(await screen.findByLabelText(/Ask for my PIN before anyone adds a profile/));
    expect(api.patchProfile).toHaveBeenCalledWith('o1', { requirePinToAdd: true });
    cleanup();
    render(<ManageProfile profile={{ ...OWNER, locked: false }} onClose={() => {}} onChanged={() => {}} toast={toast} />);
    expect(screen.getByLabelText(/Ask for my PIN before anyone adds a profile/).disabled).toBe(true);
  });
});
