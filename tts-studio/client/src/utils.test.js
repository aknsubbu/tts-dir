import { describe, expect, it } from 'vitest';
import { MARK_END, MARK_START, fmtBytes, fmtDuration, fmtUsd, highlightParts, parseRoute, parseSnippet, routeHash, stillAt, stripExt } from './utils.js';

describe('formatting', () => {
  it('shows lengths the way a person says them', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(8.4)).toBe('8s');
    expect(fmtDuration(125)).toBe('2m 05s');
    expect(fmtDuration(3725)).toBe('1h 02m');
  });

  it('shows sizes in the nearest unit', () => {
    expect(fmtBytes(900)).toBe('900 B');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(20 * 1024 * 1024)).toBe('20.0 MB');
  });

  it('drops only the last extension', () => {
    expect(stripExt('notes.final.md')).toBe('notes.final');
    expect(stripExt('README')).toBe('README');
  });
});

describe('search highlights', () => {
  it('splits a server snippet on its markers, so no HTML is ever needed', () => {
    expect(parseSnippet(`a ${MARK_START}slope${MARK_END} of <b>two</b>`)).toEqual([
      { text: 'a ', hit: false },
      { text: 'slope', hit: true },
      { text: ' of <b>two</b>', hit: false },
    ]);
    expect(parseSnippet(null)).toEqual([]);
  });

  it('marks whole words that start with a search word', () => {
    expect(highlightParts('Simmering the stew, then simmer.', 'simmer')).toEqual([
      { text: 'Simmering', hit: true },
      { text: ' the stew, then ', hit: false },
      { text: 'simmer', hit: true },
      { text: '.', hit: false },
    ]);
    expect(highlightParts('a.b', '.')).toEqual([{ text: 'a.b', hit: false }]);
  });
});

describe('lesson workspace addresses', () => {
  it('reads #lesson/<id>/<tab>, with watch as the default tab', () => {
    expect(parseRoute('#lesson/abc-123/storyboard')).toEqual({ id: 'abc-123', tab: 'storyboard' });
    expect(parseRoute('#lesson/abc-123')).toEqual({ id: 'abc-123', tab: 'watch' });
    expect(parseRoute('#lesson/abc-123/nonsense')).toEqual({ id: 'abc-123', tab: 'watch' });
    expect(parseRoute('#settings')).toBeNull();
    expect(parseRoute('')).toBeNull();
    expect(routeHash('abc', 'notes')).toBe('#lesson/abc/notes');
  });
});

describe('the still on screen during the animatic', () => {
  const blocks = [
    { id: 'a', scene: 'One', stills: [{ file: 'a-end', at: 4 }, { file: 'a-x', at: 1 }] },
    { id: 'b', scene: 'One', stills: [{ file: 'b-y', at: 2 }, { file: 'b-end', at: 5 }] },
    { id: 'c', scene: 'Two', stills: [{ file: 'c-end', at: 3 }] },
  ];
  it('is the last still taken by then, carried over from the block before within a scene', () => {
    expect(stillAt(blocks, 0, 0.5)).toBeNull(); // a scene starts empty
    expect(stillAt(blocks, 0, 1)?.file).toBe('a-x');
    expect(stillAt(blocks, 0, 4.2)?.file).toBe('a-end');
    expect(stillAt(blocks, 1, 0.5)?.file).toBe('a-end');
    expect(stillAt(blocks, 1, 2.5)?.file).toBe('b-y');
    expect(stillAt(blocks, 2, 1)).toBeNull(); // not carried into the next scene
  });

  it('formats money for the cost line', () => {
    expect(fmtUsd(0.696)).toBe('$0.70');
    expect(fmtUsd(0.042)).toBe('$0.042');
    expect(fmtUsd(null)).toBe('—');
  });
});
