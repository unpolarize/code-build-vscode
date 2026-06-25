import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCommandText } from '../../src/shared/cleanCommandText';

test('derives "<name> <args>" from a slash-command invocation', () => {
  const text =
    '<command-message>load</command-message><command-name>/load</command-name><command-args>review the requirements and implement it</command-args>';
  assert.equal(cleanCommandText(text), '/load review the requirements and implement it');
});

test('handles a command with no args', () => {
  const text = '<command-message>clear</command-message><command-name>/clear</command-name><command-args></command-args>';
  assert.equal(cleanCommandText(text), '/clear');
});

test('falls back to command-message when command-name is absent', () => {
  assert.equal(cleanCommandText('<command-message>load</command-message>'), '/load');
});

test('strips a system-reminder block from a plain prompt', () => {
  assert.equal(
    cleanCommandText('<system-reminder>context</system-reminder>Fix the parser crash now'),
    'Fix the parser crash now',
  );
});

test('leaves a normal prompt untouched', () => {
  assert.equal(cleanCommandText('Fix the bug in foo.ts please'), 'Fix the bug in foo.ts please');
});
