// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Storyboard from './Storyboard.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { storyboard: vi.fn() } }));

const still = (file, mark, at) => ({ block: 'x', mark, file, at, url: `/s/${file}` });
const BOARD = {
  duration: 8,
  unplayed: ['spare'],
  scenes: [
    {
      name: 'Puzzle', error: null, issues: [],
      blocks: [
        { id: 'model', text: 'A score <mark name="z"/>z, squashed by the <mark name="sig"/>sigmoid.', duration: 5, marks: { z: 1, sig: 3 }, stills: [still('P-model.png', null, 5), still('P-model--z.png', 'z', 1)], issues: [], audioUrl: '/n/model' },
        { id: 'loss', text: 'The loss.', duration: 3, marks: {}, stills: [still('P-loss.png', null, 3)], issues: [{ kind: 'layout', message: 'text "L" and text "y" overlap' }], audioUrl: '/n/loss' },
      ],
    },
    { name: 'Chain', error: 'NameError: name \'MathTex\' is not defined', issues: [], blocks: [{ id: 'chain', text: 'Three links.', duration: 0, marks: {}, stills: [], issues: [], audioUrl: '/n/chain' }] },
  ],
};

beforeEach(() => api.storyboard.mockReset().mockResolvedValue(BOARD));
afterEach(cleanup);

describe('the storyboard', () => {
  it('shows each block with its narration, marks, stills and problems, scene by scene', async () => {
    render(<Storyboard id="g1" />);
    const model = await screen.findByLabelText('Block model');
    expect(within(model).getByText('z')).toBeTruthy(); // a mark, shown where it falls
    expect(within(model).getByAltText(/Puzzle, block model, end of block/)).toBeTruthy();
    fireEvent.click(within(model).getByLabelText('Show the still at “z”'));
    expect(within(model).getByAltText(/Puzzle, block model, at “z”/)).toBeTruthy();

    const loss = screen.getByLabelText('Block loss');
    expect(within(loss).getByText('text "L" and text "y" overlap')).toBeTruthy();
    expect(screen.getByText(/NameError: name 'MathTex'/)).toBeTruthy();
    expect(screen.getByText(/No scene plays \[spare\]/)).toBeTruthy();
    expect(screen.getByText(/3 blocks · 2 scenes · 3 stills · 1 warning/)).toBeTruthy();
    expect(api.storyboard).toHaveBeenCalledWith('g1', undefined, undefined);
  });

  it('says plainly when there is no storyboard yet', async () => {
    // A plain function: vitest's spy reports a rejected promise it returned as an error of its own.
    const spy = api.storyboard;
    api.storyboard = () => Promise.reject(new Error('No storyboard yet. It appears once the scenes have been checked.'));
    try {
      render(<Storyboard id="g1" />);
      expect(await screen.findByText(/No storyboard yet/)).toBeTruthy();
    } finally {
      api.storyboard = spy;
    }
  });

  it('plays silently when no narration was kept', async () => {
    api.storyboard.mockResolvedValue({ ...BOARD, unplayed: [], scenes: BOARD.scenes.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, audioUrl: null })) })) });
    render(<Storyboard id="g1" version={2} />);
    expect(await screen.findByText(/plays silently/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play as animatic/ }).disabled).toBe(true);
    expect(api.storyboard).toHaveBeenCalledWith('g1', 2, undefined);
  });
});
