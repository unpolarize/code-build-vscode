import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSandboxPosture,
  findPostureConflicts,
  formatSandboxPostureDetail,
  formatSandboxPostureTooltip,
  getSandboxPostureHub,
  resetSandboxPostureHubForTests,
  toSandboxPostureUpdate
} from '../../src/shared/sandboxPostureChip';
import { reduce, initialState } from '../../webview-ui/src/store';

/** Claude 2.1.248 `--restricted` spawn (no shell; file tools cwd-bound). */
const CLAUDE_RESTRICTED_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'default',
  '--restricted'
];

/** Unrestricted Claude spawn — no restricted flag, no env. */
const CLAUDE_OPEN_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--permission-mode',
  'default'
];

/** Codex exec with default OS sandbox + network-off. */
const CODEX_READONLY_ARGS = [
  'exec',
  '--json',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only'
];

test('Restricted Claude spawn → shell:off + files:cwd', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS,
    env: {}
  });
  assert.equal(chip.shell, 'off');
  assert.equal(chip.files, 'cwd');
  assert.equal(chip.available, true);
  assert.equal(chip.warn, true);
  assert.match(chip.label, /sh×/);
  assert.match(chip.label, /cwd/);
  assert.ok(chip.signals.some((s) => s.key === '--restricted' && s.source === 'spawn-args'));
});

test('CLAUDE_CODE_RESTRICTED=1 env → same restricted badges', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_OPEN_ARGS,
    env: { CLAUDE_CODE_RESTRICTED: '1' }
  });
  assert.equal(chip.shell, 'off');
  assert.equal(chip.files, 'cwd');
  assert.ok(chip.signals.some((s) => s.key === 'CLAUDE_CODE_RESTRICTED' && s.source === 'env'));
});

test('Unrestricted Claude fixture does not show shell:off + files:cwd', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_OPEN_ARGS,
    env: {}
  });
  assert.notEqual(chip.shell, 'off');
  assert.notEqual(chip.files, 'cwd');
  assert.equal(chip.shell, 'unknown');
  assert.equal(chip.files, 'unknown');
  assert.equal(chip.warn, true);
  assert.equal(chip.label, 'posture ?');
});

test('Unknown initialize → unknown badges, not silent green', () => {
  const chip = evaluateSandboxPosture({
    backend: 'grok',
    spawnArgs: ['agent', 'stdio'],
    env: {},
    agentInitialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } }
  });
  assert.equal(chip.shell, 'unknown');
  assert.equal(chip.network, 'unknown');
  assert.equal(chip.files, 'unknown');
  assert.equal(chip.creds, 'unknown');
  assert.equal(chip.warn, true);
  assert.match(chip.warnReason ?? '', /unknown/i);
});

test('initialize _meta.restricted=true → restricted badges', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    agentInitialize: { _meta: { restricted: true } }
  });
  assert.equal(chip.shell, 'off');
  assert.equal(chip.files, 'cwd');
  assert.ok(chip.signals.some((s) => s.source === 'initialize' && s.key === 'restricted'));
});

test('Codex --sandbox read-only → network:off + files:workspace + shell:on', () => {
  const chip = evaluateSandboxPosture({
    backend: 'codex',
    spawnArgs: CODEX_READONLY_ARGS,
    env: {}
  });
  assert.equal(chip.shell, 'on');
  assert.equal(chip.network, 'off');
  assert.equal(chip.files, 'workspace');
  assert.match(chip.label, /net×/);
  assert.match(chip.label, /ws/);
  assert.ok(chip.signals.some((s) => s.key === '--sandbox' && s.value === 'read-only'));
});

test('Codex danger-full-access → unrestricted files + network on', () => {
  const chip = evaluateSandboxPosture({
    backend: 'codex',
    spawnArgs: ['exec', '--sandbox', 'danger-full-access']
  });
  assert.equal(chip.files, 'unrestricted');
  assert.equal(chip.network, 'on');
  assert.equal(chip.shell, 'on');
});

test('Codex initialize sandbox object is accepted', () => {
  const chip = evaluateSandboxPosture({
    backend: 'codex',
    agentInitialize: {
      sandbox: { mode: 'workspace-write', network: false }
    }
  });
  assert.equal(chip.files, 'workspace');
  assert.equal(chip.network, 'off');
  assert.equal(chip.shell, 'on');
});

test('Missing/garbage input never throws and never goes silent green', () => {
  for (const bad of [null, undefined, {}, { spawnArgs: 'nope' as any }]) {
    const chip = evaluateSandboxPosture(bad as any);
    assert.equal(chip.available, true);
    assert.equal(chip.shell, 'unknown');
    assert.equal(chip.warn, true);
    assert.equal(chip.label, 'posture ?');
  }
});

test('Click-through detail lists raw vendor signals', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS,
    env: { CLAUDE_CODE_RESTRICTED: 'true' }
  });
  const detail = formatSandboxPostureDetail(chip);
  assert.match(detail, /shell: off/);
  assert.match(detail, /files: cwd/);
  assert.match(detail, /\[spawn-args\] --restricted/);
  assert.match(detail, /\[env\] CLAUDE_CODE_RESTRICTED/);
  const tip = formatSandboxPostureTooltip(chip);
  assert.match(tip, /Signals:/);
  assert.match(tip, /spawn-args --restricted/);
});

test('Same-cwd restricted vs open sessions conflict', () => {
  const restricted = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS
  });
  const open = evaluateSandboxPosture({
    backend: 'codex',
    spawnArgs: ['exec', '--sandbox', 'danger-full-access']
  });
  const conflicts = findPostureConflicts([
    { sessionId: 's1', cwd: '/tmp/repo', backend: 'claude', chip: restricted },
    { sessionId: 's2', cwd: '/tmp/repo', backend: 'codex', chip: open }
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.cwd, '/tmp/repo');
  assert.ok(conflicts[0]!.reasons.some((r) => r.startsWith('shell:')));
  assert.ok(conflicts[0]!.reasons.some((r) => r.startsWith('files:')));
});

test('Unknown vs known on same cwd does not conflict', () => {
  const unknown = evaluateSandboxPosture({ backend: 'grok', spawnArgs: ['agent', 'stdio'] });
  const restricted = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS
  });
  const conflicts = findPostureConflicts([
    { sessionId: 's1', cwd: '/tmp/repo', backend: 'grok', chip: unknown },
    { sessionId: 's2', cwd: '/tmp/repo', backend: 'claude', chip: restricted }
  ]);
  assert.equal(conflicts.length, 0);
});

test('Hub registers concurrent sessions and reports conflict', () => {
  resetSandboxPostureHubForTests();
  const hub = getSandboxPostureHub();
  const a = evaluateSandboxPosture({ backend: 'claude', spawnArgs: CLAUDE_RESTRICTED_ARGS });
  const b = evaluateSandboxPosture({
    backend: 'codex',
    spawnArgs: ['exec', '--sandbox', 'danger-full-access']
  });
  assert.equal(hub.register({ sessionId: 'a', cwd: '/ws', backend: 'claude', chip: a }), null);
  const conflict = hub.register({ sessionId: 'b', cwd: '/ws', backend: 'codex', chip: b });
  assert.ok(conflict);
  assert.deepEqual(conflict.sessionIds.sort(), ['a', 'b']);
  hub.unregister('a');
  assert.equal(hub.conflictFor('b'), null);
});

test('webview reducer stores sandbox_posture_update on ChatState.sandboxPosture', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS
  });
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: toSandboxPostureUpdate(chip)
  });
  assert.ok(next.sandboxPosture);
  assert.equal(next.sandboxPosture!.shell, 'off');
  assert.equal(next.sandboxPosture!.files, 'cwd');
  assert.match(next.sandboxPosture!.label, /sh×/);
});

test('historyLoaded clears stale sandboxPosture until a persisted update re-applies', () => {
  const chip = evaluateSandboxPosture({
    backend: 'claude',
    spawnArgs: CLAUDE_RESTRICTED_ARGS
  });
  const withChip = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: toSandboxPostureUpdate(chip)
  });
  assert.equal(withChip.sandboxPosture?.shell, 'off');

  const cleared = reduce(withChip, {
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
  assert.equal(cleared.sandboxPosture, null);

  const restored = reduce(withChip, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'claude',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: [{ type: 'update', update: toSandboxPostureUpdate(chip) }]
  });
  assert.equal(restored.sandboxPosture?.shell, 'off');
  assert.equal(restored.sandboxPosture?.files, 'cwd');
});

test('HostToWebview sandboxPosture message updates chip without SessionUpdate', () => {
  const chip = evaluateSandboxPosture({
    backend: 'codex',
    spawnArgs: CODEX_READONLY_ARGS
  });
  const next = reduce(initialState, { type: 'sandboxPosture', chip });
  assert.equal(next.sandboxPosture?.network, 'off');
  assert.equal(next.sandboxPosture?.files, 'workspace');
  const cleared = reduce(next, { type: 'sandboxPosture', chip: null });
  assert.equal(cleared.sandboxPosture, null);
});
