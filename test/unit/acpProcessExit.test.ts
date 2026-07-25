import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate } from '../../src/shared/acpTypes';
import {
  isAbnormalAcpExit,
  settleAcpProcessExit
} from '../../src/host/transports/acpProcessExit';
import { JsonRpcEndpoint } from '../../src/host/transports/acp/jsonRpc';
import { PendingPermissionResolvers } from '../../src/host/transports/permissionRequest';
import { PassThrough } from 'node:stream';

test('isAbnormalAcpExit: code 0 / null without signal is clean', () => {
  assert.equal(isAbnormalAcpExit(0, null), false);
  assert.equal(isAbnormalAcpExit(null, null), false);
});

test('isAbnormalAcpExit: nonzero code or any signal is abnormal', () => {
  assert.equal(isAbnormalAcpExit(1, null), true);
  assert.equal(isAbnormalAcpExit(137, null), true);
  assert.equal(isAbnormalAcpExit(null, 'SIGTERM'), true);
  assert.equal(isAbnormalAcpExit(0, 'SIGKILL'), true);
});

test('clean exit (code 0): synthetic result only, drains permissions + rpc', async () => {
  const events: SessionUpdate[] = [];
  const permissions = new PendingPermissionResolvers();
  let permOutcome: unknown;
  permissions.add('p1', (o) => {
    permOutcome = o;
  });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const rpc = new JsonRpcEndpoint(stdin, stdout);
  const pending = rpc.request('session/prompt', { sessionId: 's' });

  settleAcpProcessExit({
    code: 0,
    signal: null,
    bin: 'grok',
    startupStderr: '',
    emit: (u) => events.push(u),
    disposeRpc: () => rpc.dispose(),
    cancelPermissions: () => permissions.cancelAll()
  });

  assert.equal(permissions.size, 0, 'pending permissions drained');
  assert.deepEqual(permOutcome, { outcome: 'cancelled' });

  await assert.rejects(pending, /disposed/i, 'in-flight session/prompt settles');

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { kind: 'result', stopReason: 'exit' });
});

test('signal kill: error bubble + synthetic result; drains pending work', async () => {
  const events: SessionUpdate[] = [];
  const permissions = new PendingPermissionResolvers();
  permissions.add('p1', () => undefined);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const rpc = new JsonRpcEndpoint(stdin, stdout);
  const pending = rpc.request('session/prompt', { sessionId: 's' });

  settleAcpProcessExit({
    code: null,
    signal: 'SIGTERM',
    bin: 'grok',
    startupStderr: 'oom killed\n',
    emit: (u) => events.push(u),
    disposeRpc: () => rpc.dispose(),
    cancelPermissions: () => permissions.cancelAll()
  });

  assert.equal(permissions.size, 0);
  await assert.rejects(pending, /disposed/i);

  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, 'error');
  if (events[0]!.kind === 'error') {
    assert.match(events[0]!.message, /signal SIGTERM/);
    assert.match(events[0]!.message, /oom killed/);
  }
  assert.deepEqual(events[1], { kind: 'result', stopReason: 'exit' });
});

test('nonzero exit code: error + result, stderr tail included', () => {
  const events: SessionUpdate[] = [];
  settleAcpProcessExit({
    code: 1,
    signal: null,
    bin: 'grok',
    startupStderr: 'fatal: protocol mismatch',
    emit: (u) => events.push(u),
    disposeRpc: () => undefined,
    cancelPermissions: () => undefined
  });

  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, 'error');
  if (events[0]!.kind === 'error') {
    assert.match(events[0]!.message, /code 1/);
    assert.match(events[0]!.message, /protocol mismatch/);
  }
  assert.deepEqual(events[1], { kind: 'result', stopReason: 'exit' });
});
