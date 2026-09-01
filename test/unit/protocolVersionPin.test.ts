import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProtocolVersionPin,
  HOST_ACP_PROTOCOL_VERSION,
  isExperimentalInitialize
} from '../../src/shared/protocolVersionPin';
import { reduce, initialState } from '../../webview-ui/src/store';

test('HOST_ACP_PROTOCOL_VERSION is stable v1', () => {
  assert.equal(HOST_ACP_PROTOCOL_VERSION, 1);
});

test('v1 initialize fixture — matched, no warn', () => {
  const pin = evaluateProtocolVersionPin({
    agentInitialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
  });
  assert.equal(pin.hostVersion, 1);
  assert.equal(pin.agentVersion, 1);
  assert.equal(pin.experimental, false);
  assert.equal(pin.label, 'ACP v1');
  assert.equal(pin.warn, false);
  assert.equal(pin.warnReason, undefined);
});

test('experimental-v2 initialize fixture — warn on major + draft', () => {
  const pin = evaluateProtocolVersionPin({
    hostVersion: 1,
    agentInitialize: {
      protocolVersion: 2,
      experimental: true,
      agentCapabilities: { loadSession: false }
    }
  });
  assert.equal(pin.agentVersion, 2);
  assert.equal(pin.experimental, true);
  assert.equal(pin.label, 'ACP v2*');
  assert.equal(pin.warn, true);
  assert.match(pin.warnReason ?? '', /v1.*v2|Host speaks ACP v1/i);
});

test('same major but experimental flag — warn, starred label', () => {
  const pin = evaluateProtocolVersionPin({
    agentInitialize: {
      protocolVersion: 1,
      _meta: { protocolExperimental: true }
    }
  });
  assert.equal(pin.agentVersion, 1);
  assert.equal(pin.experimental, true);
  assert.equal(pin.label, 'ACP v1*');
  assert.equal(pin.warn, true);
  assert.match(pin.warnReason ?? '', /experimental|draft/i);
});

test('missing protocolVersion — warn with unknown label', () => {
  const pin = evaluateProtocolVersionPin({
    agentInitialize: { agentCapabilities: {} }
  });
  assert.equal(pin.agentVersion, null);
  assert.equal(pin.label, 'ACP ?');
  assert.equal(pin.warn, true);
});

test('null/garbage initialize — never throws', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const pin = evaluateProtocolVersionPin({ agentInitialize: bad as any });
    assert.equal(pin.agentVersion, null);
    assert.equal(pin.warn, true);
  }
});

test('string protocolVersion coerces when numeric', () => {
  const pin = evaluateProtocolVersionPin({
    agentInitialize: { protocolVersion: '1' }
  });
  assert.equal(pin.agentVersion, 1);
  assert.equal(pin.warn, false);
});

test('isExperimentalInitialize reads top-level and _meta flags', () => {
  assert.equal(isExperimentalInitialize({ protocolVersion: 1 }), false);
  assert.equal(isExperimentalInitialize({ experimental: true }), true);
  assert.equal(isExperimentalInitialize({ protocolExperimental: true }), true);
  assert.equal(isExperimentalInitialize({ _meta: { experimental: true } }), true);
  assert.equal(isExperimentalInitialize(null), false);
});

test('webview reducer stores protocol_version_update on ChatState.protocolPin', () => {
  const pin = evaluateProtocolVersionPin({
    agentInitialize: { protocolVersion: 2, experimental: true }
  });
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'protocol_version_update',
      hostVersion: pin.hostVersion,
      agentVersion: pin.agentVersion,
      experimental: pin.experimental,
      label: pin.label,
      warn: pin.warn,
      warnReason: pin.warnReason
    }
  });
  assert.ok(next.protocolPin);
  assert.equal(next.protocolPin!.label, 'ACP v2*');
  assert.equal(next.protocolPin!.warn, true);
});

test('historyLoaded clears stale protocolPin until a persisted update re-applies', () => {
  const withPin = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'protocol_version_update',
      hostVersion: 1,
      agentVersion: 1,
      experimental: false,
      label: 'ACP v1',
      warn: false
    }
  });
  assert.equal(withPin.protocolPin?.label, 'ACP v1');

  const cleared = reduce(withPin, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'grok',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: []
  });
  assert.equal(cleared.protocolPin, null);

  const restored = reduce(withPin, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'grok',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: [
      {
        type: 'update',
        update: {
          kind: 'protocol_version_update',
          hostVersion: 1,
          agentVersion: 2,
          experimental: false,
          label: 'ACP v2',
          warn: true,
          warnReason: 'mismatch'
        }
      }
    ]
  });
  assert.equal(restored.protocolPin?.label, 'ACP v2');
  assert.equal(restored.protocolPin?.warn, true);
});
