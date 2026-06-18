import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findActiveMention, parseUriList } from '../../webview-ui/src/util/mentions';

// --- findActiveMention: caret-aware @-token detection -----------------------

test('detects an @-token at the end of the text', () => {
  const text = 'see @foo';
  assert.deepEqual(findActiveMention(text, text.length), { start: 4, query: 'foo' });
});

test('detects an @-token when the caret is mid-text (trailing chars after)', () => {
  // caret sits right after "@foo", before " bar"
  const text = 'see @foo bar';
  assert.deepEqual(findActiveMention(text, 8), { start: 4, query: 'foo' });
});

test('bare @ at the caret yields an empty query (default suggestions)', () => {
  const text = 'see @';
  assert.deepEqual(findActiveMention(text, text.length), { start: 4, query: '' });
});

test('no mention when whitespace separates @ from the caret', () => {
  const text = 'see @foo bar';
  assert.equal(findActiveMention(text, text.length), null);
});

test('an email-like a@b is not a mention (@ not preceded by whitespace)', () => {
  const text = 'mail me@example.com';
  assert.equal(findActiveMention(text, text.length), null);
});

test('@ at the very start of the text is a mention', () => {
  const text = '@classic/agent';
  assert.deepEqual(findActiveMention(text, text.length), { start: 0, query: 'classic/agent' });
});

test('folder query with slash is captured whole', () => {
  const text = 'open @src/host/';
  assert.deepEqual(findActiveMention(text, text.length), { start: 5, query: 'src/host/' });
});

// --- parseUriList: drag-and-drop text/uri-list parsing ----------------------

test('parses newline-separated file URIs', () => {
  const list = 'file:///a/b.ts\nfile:///c/d.md\n';
  assert.deepEqual(parseUriList(list), ['file:///a/b.ts', 'file:///c/d.md']);
});

test('ignores comment lines and blank lines', () => {
  const list = '# comment\nfile:///a.ts\n\n  \nfile:///b.ts';
  assert.deepEqual(parseUriList(list), ['file:///a.ts', 'file:///b.ts']);
});

test('handles CRLF line endings', () => {
  const list = 'file:///a.ts\r\nfile:///b.ts';
  assert.deepEqual(parseUriList(list), ['file:///a.ts', 'file:///b.ts']);
});

test('empty input yields an empty list', () => {
  assert.deepEqual(parseUriList(''), []);
});
