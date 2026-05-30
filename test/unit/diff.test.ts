import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, diffStats } from '../../webview-ui/src/diff';

test('pure addition (write new file) counts all lines as added', () => {
  const rows = lineDiff('', 'a\nb\nc');
  assert.deepEqual(
    rows.map((r) => r.type),
    ['add', 'add', 'add']
  );
  assert.deepEqual(diffStats('', 'a\nb\nc'), { added: 3, removed: 0 });
});

test('pure removal counts all lines as removed', () => {
  assert.deepEqual(diffStats('a\nb', ''), { added: 0, removed: 2 });
});

test('edit keeps unchanged context and marks only the changed line', () => {
  const rows = lineDiff('a\nb\nc', 'a\nB\nc');
  // a context, b removed, B added, c context (order: context, del, add, context)
  const types = rows.map((r) => r.type);
  assert.deepEqual(types, ['context', 'del', 'add', 'context']);
  assert.deepEqual(diffStats('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
});

test('insertion in the middle is a single add', () => {
  assert.deepEqual(diffStats('a\nc', 'a\nb\nc'), { added: 1, removed: 0 });
});

test('identical text yields only context rows', () => {
  const rows = lineDiff('x\ny', 'x\ny');
  assert.ok(rows.every((r) => r.type === 'context'));
  assert.deepEqual(diffStats('x\ny', 'x\ny'), { added: 0, removed: 0 });
});
