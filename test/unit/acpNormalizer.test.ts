import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAcpUpdate } from '../../src/host/transports/normalizers/acp';

test('agent_message_chunk -> agent_message_chunk text', () => {
  const out = normalizeAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  } as never);
  assert.deepEqual(out, [{ kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }]);
});

test('tool_call maps id/title/status/kind', () => {
  const out = normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc1',
    title: 'Read file',
    kind: 'read',
    status: 'in_progress'
  } as never);
  assert.ok(out[0].kind === 'tool_call');
  if (out[0].kind === 'tool_call') {
    assert.equal(out[0].toolCall.toolCallId, 'tc1');
    assert.equal(out[0].toolCall.status, 'in_progress');
    assert.equal(out[0].toolCall.kind, 'read');
  }
});

test('tool_call_update carries status only when present', () => {
  const out = normalizeAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc1',
    status: 'completed'
  } as never);
  assert.ok(out[0].kind === 'tool_call_update');
  if (out[0].kind === 'tool_call_update') {
    assert.equal(out[0].toolCall.toolCallId, 'tc1');
    assert.equal(out[0].toolCall.status, 'completed');
  }
});

test('tool content array (content + diff) extracted to text blocks', () => {
  const out = normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc2',
    title: 'Edit',
    content: [
      { type: 'content', content: { type: 'text', text: 'output' } },
      { type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }
    ]
  } as never);
  assert.ok(out[0].kind === 'tool_call');
  if (out[0].kind === 'tool_call') {
    const texts = (out[0].toolCall.content ?? []).map((c) => (c.type === 'text' ? c.text : ''));
    assert.equal(texts[0], 'output');
    assert.match(texts[1], /a\.ts/);
  }
});

test('plan entries normalized with valid status', () => {
  const out = normalizeAcpUpdate({
    sessionUpdate: 'plan',
    entries: [
      { content: 'step 1', status: 'completed' },
      { content: 'step 2', status: 'bogus' }
    ]
  } as never);
  assert.ok(out[0].kind === 'plan');
  if (out[0].kind === 'plan') {
    assert.equal(out[0].entries[0].status, 'completed');
    assert.equal(out[0].entries[1].status, 'pending');
  }
});

test('unknown sessionUpdate yields no events', () => {
  const out = normalizeAcpUpdate({ sessionUpdate: 'mystery' } as never);
  assert.equal(out.length, 0);
});
