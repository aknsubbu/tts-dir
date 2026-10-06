import { describe, expect, it } from 'vitest';
import { MARK_END, MARK_START, fmtBytes, fmtDuration, highlightParts, parseSnippet, stripExt } from './utils.js';

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
