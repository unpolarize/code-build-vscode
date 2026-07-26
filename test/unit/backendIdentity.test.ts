import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBackendSessionId } from '../../src/host/backendIdentity';
import type { SessionMeta } from '../../src/shared/protocol';

function freshMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'cb-local-1',
    backend: 'claude',
    title: 'Test',
    mode: 'default',
    cwd: '/repo',
    createdAt: 1_700_000_000_000,
    ...over
  };
}

test('legacy meta without new fields round-trips untouched (no rewrite-on-load)', () => {
  const raw = JSON.stringify(freshMeta({ backendSessionId: 'native-old' }));
  const meta: SessionMeta = JSON.parse(raw);
  assert.equal(meta.backendSessionHistory, undefined);
  assert.equal(meta.native, undefined);
  // Same id re-announced → no-op: nothing is added to a legacy meta.
  assert.equal(applyBackendSessionId(meta, 'native-old', 'respawn', 123), false);
  assert.equal(JSON.stringify(meta), raw);
});

test('first system_init sets id + native + one initial history entry', () => {
  const meta = freshMeta();
  const changed = applyBackendSessionId(meta, 'native-1', 'initial', 111);
  assert.equal(changed, true);
  assert.equal(meta.backendSessionId, 'native-1');
  assert.deepEqual(meta.native, { format: 'claude-jsonl', id: 'native-1' });
  assert.deepEqual(meta.backendSessionHistory, [{ id: 'native-1', ts: 111, reason: 'initial' }]);
});

test('same id → no-op, no history spam from re-init-heavy sessions', () => {
  const meta = freshMeta();
  applyBackendSessionId(meta, 'native-1', 'initial', 111);
  for (let i = 0; i < 100; i++) {
    assert.equal(applyBackendSessionId(meta, 'native-1', 'respawn', 200 + i), false);
  }
  assert.equal(meta.backendSessionHistory!.length, 1);
  assert.equal(meta.backendSessionId, 'native-1');
});

test('resume_fallback rotation: current = new id, history keeps old + new with reason', () => {
  const meta = freshMeta({ backend: 'grok' });
  applyBackendSessionId(meta, 'native-1', 'initial', 111);
  const changed = applyBackendSessionId(meta, 'native-2', 'resume_fallback', 222);
  assert.equal(changed, true);
  assert.equal(meta.backendSessionId, 'native-2');
  assert.deepEqual(meta.native, { format: 'grok-jsonl', id: 'native-2' });
  assert.deepEqual(meta.backendSessionHistory, [
    { id: 'native-1', ts: 111, reason: 'initial' },
    { id: 'native-2', ts: 222, reason: 'resume_fallback' }
  ]);
});

test('native.id always equals backendSessionId across rotations', () => {
  const meta = freshMeta({ backend: 'codex' });
  applyBackendSessionId(meta, 'a', 'initial', 1);
  applyBackendSessionId(meta, 'b', 'respawn', 2);
  applyBackendSessionId(meta, 'c', 'respawn', 3);
  assert.equal(meta.native!.id, meta.backendSessionId);
  assert.equal(meta.native!.format, 'codex-rollout');
  assert.deepEqual(
    meta.backendSessionHistory!.map((h) => h.id),
    ['a', 'b', 'c']
  );
});

test('legacy meta with pre-existing id gets it seeded into history on first rotation', () => {
  const meta = freshMeta({ backendSessionId: 'native-legacy' });
  const changed = applyBackendSessionId(meta, 'native-2', 'respawn', 555);
  assert.equal(changed, true);
  assert.deepEqual(meta.backendSessionHistory, [
    { id: 'native-legacy', ts: meta.createdAt, reason: 'initial' },
    { id: 'native-2', ts: 555, reason: 'respawn' }
  ]);
});

test('unmapped backend tracks id + history but sets no native pointer', () => {
  const meta = freshMeta({ backend: 'opencode' });
  applyBackendSessionId(meta, 'native-1', 'initial', 1);
  assert.equal(meta.backendSessionId, 'native-1');
  assert.equal(meta.native, undefined);
  assert.equal(meta.backendSessionHistory!.length, 1);
});
