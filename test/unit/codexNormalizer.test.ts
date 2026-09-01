import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexNormalizer } from '../../src/host/transports/normalizers/codex';
import { buildCodexExecArgv } from '../../src/host/transports/codexTransport';
import { BACKENDS } from '../../src/host/backendRegistry';

test('thread.started emits system_init and captures thread id', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({ type: 'thread.started', thread_id: 'th-1' } as never);
  assert.equal(out.length, 1);
  assert.ok(out[0].kind === 'system_init');
  if (out[0].kind === 'system_init') assert.equal(out[0].backendSessionId, 'th-1');
  assert.equal(n.threadId, 'th-1');
});

test('thread.started dedupes system_init for the same thread id', () => {
  const n = new CodexNormalizer();
  n.parseLine({ type: 'thread.started', thread_id: 'th-1' } as never);
  // Later turns may re-announce the same thread — must not re-emit system_init
  // (host capture is a no-op for same id, but spam still hits the store/watchdog).
  const again = n.parseLine({ type: 'thread.started', thread_id: 'th-1' } as never);
  assert.equal(again.length, 0);
  assert.equal(n.threadId, 'th-1');
});

test('a new thread id re-emits system_init (mid-session rotation)', () => {
  const n = new CodexNormalizer();
  n.parseLine({ type: 'thread.started', thread_id: 'th-old' } as never);
  const out = n.parseLine({ type: 'thread.started', thread_id: 'th-new' } as never);
  assert.equal(out.length, 1);
  assert.ok(out[0].kind === 'system_init');
  if (out[0].kind === 'system_init') assert.equal(out[0].backendSessionId, 'th-new');
  assert.equal(n.threadId, 'th-new');
});

test('buildCodexExecArgv without threadId is a plain exec + prompt', () => {
  const base = BACKENDS.codex.buildArgs({ cwd: '/tmp', mode: 'default' });
  const args = buildCodexExecArgv(base, 'hello');
  assert.equal(args[0], 'exec');
  assert.ok(!args.includes('resume'));
  assert.equal(args[args.length - 1], 'hello');
  // base flags preserved
  assert.ok(args.includes('--json'));
});

test('buildCodexExecArgv with resumeId puts exec resume <id> before flags + prompt', () => {
  const base = BACKENDS.codex.buildArgs({ cwd: '/tmp', mode: 'default', model: 'o3' });
  const args = buildCodexExecArgv(base, 'continue', 'th-resume-xyz');
  // Documented shape: codex exec resume <id> --json … <prompt>
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'th-resume-xyz']);
  assert.ok(args.includes('--json'));
  assert.ok(args.includes('--model'));
  assert.equal(args[args.length - 1], 'continue');
  // Must appear before any prompt and before flags (resume is positional after exec)
  const resumeIdx = args.indexOf('resume');
  const promptIdx = args.lastIndexOf('continue');
  assert.ok(resumeIdx < promptIdx);
  assert.equal(args[resumeIdx + 1], 'th-resume-xyz');
});

test('resumeId on StartOpts is what first-prompt argv would use (normalizer still empty)', () => {
  // Mirrors CodexTransport.prompt resolution: live thread id wins, else resumeId.
  // Before any thread.started, only resumeId is available — that's the restore path.
  const n = new CodexNormalizer();
  const resumeId = 'th-from-meta';
  const threadId = n.threadId ?? resumeId;
  const base = BACKENDS.codex.buildArgs({ cwd: '/tmp', mode: 'default' });
  const args = buildCodexExecArgv(base, 'first after restore', threadId);
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'th-from-meta']);
  // And the first real thread.started still emits system_init (seed did not
  // pre-set normalizer.threadId, so firstForId stays true).
  const init = n.parseLine({ type: 'thread.started', thread_id: 'th-from-meta' } as never);
  assert.equal(init.length, 1);
  assert.ok(init[0].kind === 'system_init');
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

// ---- codex-cli ≥0.142 item vocabulary (tracker #14 + parity leg of
// ideas/cb-progressive-tool-activity-stream) --------------------------------

test('agent_message item.completed -> agent_message_chunk (0.142 rename of assistant_message)', () => {
  const n = new CodexNormalizer();
  const ev = { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'hi' } };
  const first = n.parseLine(ev as never);
  assert.deepEqual(first, [{ kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }]);
  // second completed for the same id -> deduped
  assert.equal(n.parseLine(ev as never).length, 0);
});

test('agent_message shares the dedupe set with assistant_message', () => {
  const n = new CodexNormalizer();
  n.parseLine({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'hi' } } as never);
  const alias = n.parseLine({
    type: 'item.completed',
    item: { id: 'm1', type: 'assistant_message', text: 'hi' }
  } as never);
  assert.equal(alias.length, 0);
});

test('agent_message item.started / item.updated emit nothing (partial text would duplicate)', () => {
  const n = new CodexNormalizer();
  assert.equal(
    n.parseLine({ type: 'item.started', item: { id: 'm1', type: 'agent_message' } } as never).length,
    0
  );
  assert.equal(
    n.parseLine({ type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'par' } } as never)
      .length,
    0
  );
  const done = n.parseLine({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: 'partial then full' }
  } as never);
  assert.equal(done.length, 1);
});

test('mcp_tool_call started -> in_progress tool_call titled server.tool; completed -> update only', () => {
  const n = new CodexNormalizer();
  const start = n.parseLine({
    type: 'item.started',
    item: { id: 't1', type: 'mcp_tool_call', server: 'linear', tool: 'create_issue', status: 'in_progress' }
  } as never);
  assert.equal(start.length, 1);
  assert.ok(start[0].kind === 'tool_call');
  if (start[0].kind === 'tool_call') {
    assert.equal(start[0].toolCall.title, 'linear.create_issue');
    assert.equal(start[0].toolCall.kind, 'other');
    assert.equal(start[0].toolCall.status, 'in_progress');
  }
  // item.updated for an already-open tool is silent
  assert.equal(
    n.parseLine({
      type: 'item.updated',
      item: { id: 't1', type: 'mcp_tool_call', server: 'linear', tool: 'create_issue' }
    } as never).length,
    0
  );
  const done = n.parseLine({
    type: 'item.completed',
    item: { id: 't1', type: 'mcp_tool_call', server: 'linear', tool: 'create_issue', status: 'completed' }
  } as never);
  assert.equal(done.length, 1);
  assert.ok(done[0].kind === 'tool_call_update');
  if (done[0].kind === 'tool_call_update') assert.equal(done[0].toolCall.status, 'completed');
});

test('mcp_tool_call with error -> failed update', () => {
  const n = new CodexNormalizer();
  n.parseLine({
    type: 'item.started',
    item: { id: 't2', type: 'mcp_tool_call', server: 's', tool: 't' }
  } as never);
  const done = n.parseLine({
    type: 'item.completed',
    item: { id: 't2', type: 'mcp_tool_call', server: 's', tool: 't', error: { message: 'boom' } }
  } as never);
  assert.ok(done[0].kind === 'tool_call_update');
  if (done[0].kind === 'tool_call_update') assert.equal(done[0].toolCall.status, 'failed');
});

test('web_search completed-only -> tool_call THEN completed update (card must appear, not orphan update)', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({
    type: 'item.completed',
    item: { id: 'w1', type: 'web_search', query: 'acp spec tool kinds' }
  } as never);
  assert.equal(out.length, 2);
  assert.ok(out[0].kind === 'tool_call');
  if (out[0].kind === 'tool_call') {
    assert.equal(out[0].toolCall.title, 'acp spec tool kinds');
    assert.equal(out[0].toolCall.kind, 'search');
  }
  assert.ok(out[1].kind === 'tool_call_update');
  if (out[1].kind === 'tool_call_update') {
    assert.equal(out[1].toolCall.toolCallId, 'w1');
    assert.equal(out[1].toolCall.status, 'completed');
  }
});

test('todo_list -> todo_write tool_call mirror with {content,status} todos, full snapshot each event', () => {
  const n = new CodexNormalizer();
  const started = n.parseLine({
    type: 'item.started',
    item: { id: 'td1', type: 'todo_list', items: [{ text: 'a', completed: false }] }
  } as never);
  assert.equal(started.length, 1);
  assert.ok(started[0].kind === 'tool_call');
  if (started[0].kind === 'tool_call') {
    assert.equal(started[0].toolCall.title, 'todo_write');
    assert.deepEqual(started[0].toolCall.rawInput, { todos: [{ content: 'a', status: 'pending' }] });
  }
  const updated = n.parseLine({
    type: 'item.updated',
    item: {
      id: 'td1',
      type: 'todo_list',
      items: [
        { text: 'a', completed: true },
        { text: 'b', completed: false }
      ]
    }
  } as never);
  assert.equal(updated.length, 1);
  assert.ok(updated[0].kind === 'tool_call');
  if (updated[0].kind === 'tool_call') {
    assert.deepEqual(updated[0].toolCall.rawInput, {
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' }
      ]
    });
    assert.equal(updated[0].toolCall.status, 'in_progress');
  }
});

test('unknown item types still fall through silently', () => {
  const n = new CodexNormalizer();
  assert.equal(
    n.parseLine({ type: 'item.completed', item: { id: 'x', type: 'some_future_item' } } as never).length,
    0
  );
});

test('fixture replay: real 0.142.4 exec --json stream — final answer lands after the tool update', () => {
  // Trimmed from a live `codex exec --json` probe (0.142.4, 2026-08-30) plus
  // the documented command_execution shape; line order as emitted.
  const stream = [
    '{"type":"thread.started","thread_id":"01a05536-bc2b-7d91-aa08-bfafde768cd2"}',
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"ls"}}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"a.ts","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":11779,"cached_input_tokens":4480,"output_tokens":6}}'
  ];
  const n = new CodexNormalizer();
  const kinds: string[] = [];
  let answer = '';
  for (const line of stream) {
    for (const u of n.parseLine(JSON.parse(line))) {
      kinds.push(u.kind);
      if (u.kind === 'agent_message_chunk' && u.content.type === 'text') answer = u.content.text;
    }
  }
  assert.deepEqual(kinds, [
    'system_init',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
    'result'
  ]);
  assert.equal(answer, 'PONG');
});

test('turn.started resets per-turn item-id state (codex restarts ids at item_0 each spawn)', () => {
  const n = new CodexNormalizer();
  n.parseLine({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'one' } } as never);
  n.parseLine({ type: 'turn.completed' } as never);
  n.parseLine({ type: 'turn.started' } as never);
  // Reused id in the next turn must still emit (previously deduped → dropped answer)
  const second = n.parseLine({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'two' }
  } as never);
  assert.equal(second.length, 1);
  // openedTools reset too: reused tool id re-opens a card next turn
  n.parseLine({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 's', tool: 't' } } as never);
  n.parseLine({ type: 'turn.started' } as never);
  const reopened = n.parseLine({
    type: 'item.started',
    item: { id: 'item_1', type: 'mcp_tool_call', server: 's', tool: 't' }
  } as never);
  assert.equal(reopened.length, 1);
});

test('duplicate completed-only web_search does not open a second card', () => {
  const n = new CodexNormalizer();
  const ev = { type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'q' } };
  assert.equal(n.parseLine(ev as never).length, 2); // open + close
  const again = n.parseLine(ev as never);
  assert.equal(again.length, 1); // close only — webview no-ops repeats
  assert.ok(again[0].kind === 'tool_call_update');
});

test('failed mcp_tool_call carries the error message on the update card', () => {
  const n = new CodexNormalizer();
  n.parseLine({ type: 'item.started', item: { id: 'e1', type: 'mcp_tool_call', server: 's', tool: 't' } } as never);
  const done = n.parseLine({
    type: 'item.completed',
    item: { id: 'e1', type: 'mcp_tool_call', server: 's', tool: 't', error: { message: 'tool exploded' } }
  } as never);
  assert.ok(done[0].kind === 'tool_call_update');
  if (done[0].kind === 'tool_call_update') {
    assert.equal(done[0].toolCall.status, 'failed');
    assert.deepEqual(done[0].toolCall.content, [{ type: 'text', text: 'tool exploded' }]);
  }
});
