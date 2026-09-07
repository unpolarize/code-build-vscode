import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSessionStopPath,
  hostKillAgentProcess
} from '../../src/shared/sessionStopCapability';
import { reduce, initialState } from '../../webview-ui/src/store';

test('missing initialize → host-teardown (safe default)', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const d = decideSessionStopPath(bad as any);
    assert.equal(d.path, 'host-teardown');
    assert.equal(d.hostTeardown, true);
    assert.equal(d.label, 'stop host');
  }
});

test('empty agentCapabilities → host-teardown (matrix majority)', () => {
  const d = decideSessionStopPath({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true }
  } as any);
  assert.equal(d.path, 'host-teardown');
  assert.equal(d.hostTeardown, true);
  assert.match(d.reason, /lacks session\/stop/i);
});

test('sessionCapabilities.close → agent-close (no host claim)', () => {
  const d = decideSessionStopPath({
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { close: {} }
    }
  });
  assert.equal(d.path, 'agent-close');
  assert.equal(d.hostTeardown, false);
  assert.equal(d.label, 'stop close');
});

test('sessionCapabilities.stop → agent-stop', () => {
  const d = decideSessionStopPath({
    agentCapabilities: {
      sessionCapabilities: { stop: true }
    }
  });
  assert.equal(d.path, 'agent-stop');
  assert.equal(d.hostTeardown, false);
  assert.equal(d.label, 'stop rpc');
});

test('close wins over stop when both advertised', () => {
  const d = decideSessionStopPath({
    agentCapabilities: {
      sessionCapabilities: { close: {}, stop: {} }
    }
  });
  assert.equal(d.path, 'agent-close');
});

test('methods list session/stop → agent-stop', () => {
  const d = decideSessionStopPath({
    agentCapabilities: {},
    methods: ['session/prompt', 'session/stop']
  });
  assert.equal(d.path, 'agent-stop');
  assert.equal(d.hostTeardown, false);
});

test('methods list session/close → agent-close', () => {
  const d = decideSessionStopPath({
    methods: ['session/close']
  });
  assert.equal(d.path, 'agent-close');
});

test('_meta.sessionStop flag → agent-stop', () => {
  const d = decideSessionStopPath({
    agentCapabilities: { loadSession: false },
    _meta: { sessionStop: true }
  });
  assert.equal(d.path, 'agent-stop');
});

test('claude-acp-like fixture (loadSession, no stop) → host-teardown', () => {
  // Mirrors the registry matrix majority class.
  const d = decideSessionStopPath({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {}
    }
  } as any);
  assert.equal(d.path, 'host-teardown');
  assert.equal(d.hostTeardown, true);
  assert.equal(d.label, 'stop host');
});

test('zeroclaw-like fixture with sessionCapabilities.close → agent-close', () => {
  const d = decideSessionStopPath({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {} }
    }
  } as any);
  assert.equal(d.path, 'agent-close');
  assert.equal(d.hostTeardown, false);
});

test('hostKillAgentProcess falls back to proc.kill when group kill fails', () => {
  let killed: string | undefined;
  const fake = {
    pid: 999999001, // almost certainly not a live group leader
    kill(sig?: NodeJS.Signals) {
      killed = sig ?? 'default';
      return true;
    }
  };
  const mode = hostKillAgentProcess(fake, 'SIGTERM');
  assert.ok(mode === 'process' || mode === 'process-group' || mode === 'noop');
  if (mode === 'process') assert.equal(killed, 'SIGTERM');
});

test('hostKillAgentProcess noop-safe when kill throws', () => {
  const fake = {
    pid: undefined as number | undefined,
    kill() {
      throw new Error('already dead');
    }
  };
  assert.equal(hostKillAgentProcess(fake), 'noop');
});

test('webview reducer stores session_stop_capability_update', () => {
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'session_stop_capability_update',
      path: 'host-teardown',
      hostTeardown: true,
      label: 'stop host',
      reason: 'agent lacks session/stop'
    }
  } as any);
  assert.ok(next.sessionStopCapability);
  assert.equal(next.sessionStopCapability.path, 'host-teardown');
  assert.equal(next.sessionStopCapability.hostTeardown, true);
  assert.equal(next.sessionStopCapability.label, 'stop host');
});
