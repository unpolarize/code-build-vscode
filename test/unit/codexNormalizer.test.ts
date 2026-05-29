import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexNormalizer } from '../../src/host/transports/normalizers/codex';

test('thread.started captures thread id', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({ type: 'thread.started', thread_id: 'th-1' } as never);
  assert.equal(out.length, 0);
  assert.equal(n.threadId, 'th-1');
});

test('assistant_message item.completed -> agent_message_chunk (once)', () => {
  const n = new CodexNormalizer();
  const ev = { type: 'item.completed', item: { id: 'a1', type: 'assistant_message', text: 'PONG' } };
  const first = n.parseLine(ev as never);
  assert.deepEqual(first, [{ kind: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } }]);
  // de-duped on repeat
  assert.equal(n.parseLine(ev as never).length, 0);
});

test('command_execution start then complete -> tool_call + tool_call_update', () => {
  const n = new CodexNormalizer();
  const start = n.parseLine({
    type: 'item.started',
    item: { id: 'c1', type: 'command_execution', command: 'ls' }
  } as never);
  assert.ok(start[0].kind === 'tool_call');
  const done = n.parseLine({
    type: 'item.completed',
    item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts', exit_code: 0 }
  } as never);
  assert.ok(done[0].kind === 'tool_call_update');
  if (done[0].kind === 'tool_call_update') {
    assert.equal(done[0].toolCall.status, 'completed');
  }
});

test('file_change -> tool_call_update with diff blocks', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({
    type: 'item.completed',
    item: { id: 'p1', type: 'file_change', changes: [{ path: 'a.ts', old: 'x', new: 'y' }] }
  } as never);
  assert.ok(out[0].kind === 'tool_call_update');
  if (out[0].kind === 'tool_call_update') {
    assert.deepEqual(out[0].toolCall.content, [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }]);
  }
});

test('turn.completed -> result with usage', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({
    type: 'turn.completed',
    usage: { input_tokens: 5, output_tokens: 7 }
  } as never);
  assert.ok(out[0].kind === 'result');
  if (out[0].kind === 'result') assert.equal(out[0].usage?.outputTokens, 7);
});

test('error message wrapped JSON is unwrapped to human message', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({
    type: 'error',
    message: JSON.stringify({ error: { message: 'model not supported' } })
  } as never);
  assert.ok(out[0].kind === 'error');
  if (out[0].kind === 'error') assert.equal(out[0].message, 'model not supported');
});
