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
