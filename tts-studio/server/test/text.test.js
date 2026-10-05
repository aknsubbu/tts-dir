import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, slugify } from '../text.js';

test('cleanText strips markdown but keeps words and snake_case', () => {
  const md = '# Title\n\nHello **bold** and _soft_ with [a link](http://x.com) and `code`.\n\n- item one\n- item two\n\n```js\nignore()\n```\n\nuse my_snake_case_name here';
  const out = cleanText(md);
  assert.equal(
    out,
    'Title\n\nHello bold and soft with a link and code.\n\nitem one\nitem two\n\nuse my_snake_case_name here',
  );
});

test('cleanText keeps pronunciation hints but still strips ordinary links', () => {
  assert.equal(cleanText('Say [Kokoro](/kˈOkəɹO/) on [this page](/docs/intro).'), 'Say [Kokoro](/kˈOkəɹO/) on this page.');
});

test('cleanText can leave markdown alone and normalizes line endings', () => {
  assert.equal(cleanText('**x**\r\n\r\n\r\n\r\ny', { stripMarkdown: false }), '**x**\n\ny');
});

test('slugify makes safe filenames', () => {
  assert.equal(slugify('Lecture 3: Graphs & Trees!'), 'lecture-3-graphs-trees');
  assert.equal(slugify('???', 'fallback'), 'fallback');
});
