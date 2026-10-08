// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import History, { NarrationDiff, ScenesDiff } from './History.jsx';
import { wordAt } from './Transcript.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { versions: vi.fn(), versionSource: vi.fn(), restore: vi.fn() } }));

const V1 = { script: '[intro]\nEvery line has a <mark name="slope"/>slope.\n\n[outro]\nThat is all.\n', scenes: 'class A:\n    a = 1\n    b = 2\n', voice: 'af_heart', speed: 1 };
const V2 = { script: '[intro]\nEvery straight line has a <mark name="slope"/>slope.\n\n[outro]\nThat is all.\n\n[extra]\nOne more.\n', scenes: 'class A:\n    a = 1\n    b = 3\n', voice: 'af_heart', speed: 1.1 };

beforeEach(() => {
  api.versions.mockReset().mockResolvedValue({
    current: 2, built: 1,
    versions: [
      { n: 2, source: 'edited', note: 'Edited in the dashboard', createdAt: Date.now(), checkOk: true, warnings: 0, builtAt: null, renderKept: false },
      { n: 1, source: 'written', note: null, createdAt: Date.now() - 3600_000, costUsd: 0.7, checkOk: true, warnings: 1, builtAt: 1, quality: 'default', durationSec: 129, renderKept: true },
    ],
  });
  api.versionSource.mockReset().mockImplementation(async (id, n) => ({ n, ...(n === 1 ? V1 : V2) }));
  api.restore.mockReset().mockResolvedValue({ status: 'done', version: 3 });
});
afterEach(cleanup);

describe('History', () => {
  it('lists every version with what made it and whether it was built', async () => {
    render(<History g={{ id: 'g1', status: 'done', version: 2, builtVersion: 1 }} toast={vi.fn()} />);
    expect(await screen.findByText('v2')).toBeTruthy();
    expect(screen.getByText(/Edited in the dashboard · checked · not built/)).toBeTruthy();
    expect(screen.getByText(/\$0\.70 to write · checked, 1 warning · built at default, 2m 09s/)).toBeTruthy();
    expect(screen.getByText('current')).toBeTruthy();
    expect(screen.getByText('playing')).toBeTruthy();
  });

  it('compares the last two versions, and restores an earlier one', async () => {
    const toast = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<History g={{ id: 'g1', status: 'done', version: 2, builtVersion: 1 }} toast={toast} />);
    expect(await screen.findByText(/Speed: 1× → 1.1×/)).toBeTruthy();
    expect(screen.getByText('straight')).toBeTruthy(); // the inserted word, marked
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('g1', 1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/v1 is back, as v3\. Its render was kept/) }));
  });
});

describe('diffs', () => {
  it('marks changed words, new blocks and counts the rest', () => {
    const { container } = render(<NarrationDiff a={V1.script} b={V2.script} />);
    expect([...container.querySelectorAll('.diff-block')].map((d) => d.className)).toEqual(['diff-block changed', 'diff-block new']);
    expect(container.querySelector('ins').textContent).toMatch(/straight/);
    expect(screen.getByText('1 block unchanged.')).toBeTruthy();
  });

  it('shows scenes.py as a line diff', () => {
    const { container } = render(<ScenesDiff a={V1.scenes} b={V2.scenes} />);
    expect([...container.querySelectorAll('.del code')].map((c) => c.textContent)).toEqual(['    b = 2']);
    expect([...container.querySelectorAll('.add code')].map((c) => c.textContent)).toEqual(['    b = 3']);
  });
});

describe('the transcript', () => {
  it('finds the word being spoken', () => {
    const words = [['a', 0.1, 0.2], ['b', 0.5, 0.7], ['c', 1.0, 1.2]];
    expect(wordAt(words, 0)).toBe(-1);
    expect(wordAt(words, 0.6)).toBe(1);
    expect(wordAt(words, 5)).toBe(2);
  });
});
