import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeNormalizer } from '../../src/host/transports/normalizers/claude';

test('captures session id from system init', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({ type: 'system', session_id: 'sess-123' } as never);
  assert.equal(out.length, 0);
  assert.equal(n.sessionId, 'sess-123');
});

test('assistant text -> agent_message_chunk', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }
  } as never);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { kind: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
});

test('tool_use -> tool_call in_progress with classified kind', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file: 'a.ts' } }]
    }
  } as never);
  const tc = out.find((u) => u.kind === 'tool_call');
  assert.ok(tc && tc.kind === 'tool_call');
  assert.equal(tc.toolCall.toolCallId, 't1');
  assert.equal(tc.toolCall.kind, 'edit');
  assert.equal(tc.toolCall.status, 'in_progress');
});

test('tool_result -> tool_call_update completed', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]
    }
  } as never);
  assert.equal(out.length, 1);
  assert.ok(out[0].kind === 'tool_call_update');
  if (out[0].kind === 'tool_call_update') {
    assert.equal(out[0].toolCall.status, 'completed');
    assert.deepEqual(out[0].toolCall.content, [{ type: 'text', text: 'done' }]);
  }
});

test('result -> result update with usage and cost', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 20 }
  } as never);
  assert.equal(out.length, 1);
  assert.ok(out[0].kind === 'result');
  if (out[0].kind === 'result') {
    assert.equal(out[0].usage?.costUsd, 0.0123);
    assert.equal(out[0].usage?.outputTokens, 20);
  }
});

test('encodeUserMessage produces a valid stream-json user line', () => {
  const n = new ClaudeNormalizer();
  const line = n.encodeUserMessage([{ type: 'text', text: 'hi' }]);
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, 'user');
  assert.equal(parsed.message.role, 'user');
  assert.deepEqual(parsed.message.content, [{ type: 'text', text: 'hi' }]);
});
