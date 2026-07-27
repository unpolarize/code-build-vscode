// Permission gate integrity (kp: tasks/cb-permission-gate-integrity):
// the emit shape must retain rawInput/content/locations (not the old
// {toolCallId,title,kind,status} skeleton), tolerate bare/malformed
// payloads, and the resolver registry must survive concurrency + teardown
// with zero hanging promises.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionOutcome } from '../../src/shared/acpTypes';
import {
  buildPermissionToolCall,
  PendingPermissionResolvers
} from '../../src/host/transports/permissionRequest';

describe('buildPermissionToolCall', () => {
  it('retains rawInput, locations and normalized ACP content', () => {
    const tc = buildPermissionToolCall(
      {
        toolCallId: 'tc1',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: 'git push origin main' },
        locations: [{ path: '/repo/a.ts', line: 12 }],
        content: [
          { type: 'content', content: { type: 'text', text: 'hello' } },
          { type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }
        ]
      },
      'req1'
    );
    assert.equal(tc.toolCallId, 'tc1');
    assert.equal(tc.title, 'Bash');
    assert.equal(tc.kind, 'execute');
    assert.equal(tc.status, 'pending');
    assert.deepEqual(tc.rawInput, { command: 'git push origin main' });
    assert.deepEqual(tc.locations, [{ path: '/repo/a.ts', line: 12 }]);
    assert.deepEqual(tc.content, [
      { type: 'text', text: 'hello' },
      { type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }
    ]);
  });

  it('renders a fallback for a bare {toolCallId} payload', () => {
    const tc = buildPermissionToolCall({ toolCallId: 'only-id' }, 'req1');
    assert.deepEqual(tc, { toolCallId: 'only-id', title: 'Permission request', kind: undefined, status: 'pending' });
  });

  it('never throws on malformed payloads', () => {
    for (const bad of [null, undefined, 42, 'nope', { locations: 'x', content: { not: 'array' }, kind: 7 }]) {
      const tc = buildPermissionToolCall(bad, 'req1');
      assert.equal(tc.status, 'pending');
      assert.equal(tc.toolCallId, 'req1');
      assert.equal(typeof tc.title, 'string');
    }
  });

  it('drops malformed location entries but keeps valid ones', () => {
    const tc = buildPermissionToolCall(
      { toolCallId: 'x', locations: [{ nope: 1 }, { path: '/ok.ts' }, null] },
      'req1'
    );
    assert.deepEqual(tc.locations, [{ path: '/ok.ts', line: undefined }]);
  });

  it('passes XSS-shaped command text through as a plain string (rendered as text nodes)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const tc = buildPermissionToolCall({ toolCallId: 'x', rawInput: { command: evil } }, 'r');
    assert.deepEqual(tc.rawInput, { command: evil });
  });
});

describe('PendingPermissionResolvers', () => {
  it('resolves concurrent requests independently, in any order', () => {
    const reg = new PendingPermissionResolvers();
    const outcomes: Record<string, PermissionOutcome> = {};
    reg.add('r1', (o) => (outcomes.r1 = o));
    reg.add('r2', (o) => (outcomes.r2 = o));
    assert.equal(reg.size, 2);

    // Answer the SECOND first — the first must stay resolvable (the old
    // single-slot store orphaned it).
    assert.equal(reg.resolve('r2', { outcome: 'selected', optionId: 'allow' }), true);
    assert.equal(reg.resolve('r1', { outcome: 'cancelled' }), true);
    assert.deepEqual(outcomes.r2, { outcome: 'selected', optionId: 'allow' });
    assert.deepEqual(outcomes.r1, { outcome: 'cancelled' });
    assert.equal(reg.size, 0);
  });

  it('is idempotent: a second response for the same id is ignored', () => {
    const reg = new PendingPermissionResolvers();
    let calls = 0;
    reg.add('r1', () => calls++);
    assert.equal(reg.resolve('r1', { outcome: 'cancelled' }), true);
    assert.equal(reg.resolve('r1', { outcome: 'cancelled' }), false);
    assert.equal(calls, 1);
  });

  it('cancelAll resolves EVERY pending request with cancelled (no orphaned promises)', async () => {
    const reg = new PendingPermissionResolvers();
    const p1 = new Promise<PermissionOutcome>((resolve) => reg.add('r1', resolve));
    const p2 = new Promise<PermissionOutcome>((resolve) => reg.add('r2', resolve));
    reg.cancelAll();
    assert.equal(reg.size, 0);
    // Both promises must settle — a leak here is the deadlock bug.
    assert.deepEqual(await p1, { outcome: 'cancelled' });
    assert.deepEqual(await p2, { outcome: 'cancelled' });
    // Late responses after teardown are safely ignored.
    assert.equal(reg.resolve('r1', { outcome: 'cancelled' }), false);
  });
});

describe('PendingPermissionResolvers id collision', () => {
  it('cancels the previous resolver when the same id is re-added (no orphan)', async () => {
    const reg = new PendingPermissionResolvers();
    const first = new Promise<PermissionOutcome>((resolve) => reg.add('dup', resolve));
    reg.add('dup', () => {});
    assert.deepEqual(await first, { outcome: 'cancelled' });
    assert.equal(reg.size, 1);
  });
});
