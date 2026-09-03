import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acpIdForPermissionMode,
  FALLBACK_MODE_PICKER_OPTIONS,
  isClaudePermissionBackend,
  isPermissionMode,
  modePickerOptions,
  permissionModeFromAcpId,
  permissionModeSupportedByInventory,
  resolveEffectivePermissionMode,
  shouldShowAutoEducateBanner
} from '../../src/shared/permissionModes';
import type { PermissionMode } from '../../src/shared/acpTypes';
import { reduce, initialState } from '../../webview-ui/src/store';

test('permissionModeFromAcpId maps every Claude wire id', () => {
  const table: [string, PermissionMode | null][] = [
    ['default', 'default'],
    ['manual', 'default'], // alias ≥2.1.200
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'plan'],
    ['auto', 'auto'],
    ['dontAsk', 'dontAsk'],
    ['bypassPermissions', 'bypass'],
    ['bypass', 'bypass'],
    // Non-permission vendor ids (opencode agent roles, codex presets,
    // goose approval modes) must pass through as null, never coerce.
    ['build', null],
    ['read-only', null],
    ['smart_approve', null],
    ['', null]
  ];
  for (const [wire, expected] of table) {
    assert.equal(permissionModeFromAcpId(wire), expected, `wire id '${wire}'`);
  }
});

test('acpIdForPermissionMode round-trips through permissionModeFromAcpId', () => {
  const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypass', 'auto', 'dontAsk'];
  for (const mode of modes) {
    const wire = acpIdForPermissionMode(mode);
    assert.equal(permissionModeFromAcpId(wire), mode, `mode '${mode}' via wire '${wire}'`);
  }
  assert.equal(acpIdForPermissionMode('bypass'), 'bypassPermissions');
});

test('isPermissionMode accepts only the CB union', () => {
  assert.equal(isPermissionMode('auto'), true);
  assert.equal(isPermissionMode('dontAsk'), true);
  assert.equal(isPermissionMode('build'), false);
  assert.equal(isPermissionMode(null), false);
  assert.equal(isPermissionMode(undefined), false);
});

test('resolveEffectivePermissionMode precedence: pin > lastMode > initial > vendor > default', () => {
  const table: Array<{
    name: string;
    input: Parameters<typeof resolveEffectivePermissionMode>[0];
    mode: PermissionMode;
    source: string;
    bypassGated?: boolean;
  }> = [
    {
      name: 'pin wins over lastMode and initial',
      input: {
        pin: 'plan',
        lastMode: 'acceptEdits',
        initialPermissionMode: 'bypass',
        vendorMode: 'auto',
        allowBypass: true
      },
      mode: 'plan',
      source: 'pin'
    },
    {
      name: 'lastMode when no pin',
      input: {
        pin: null,
        lastMode: 'acceptEdits',
        initialPermissionMode: 'default',
        allowBypass: false
      },
      mode: 'acceptEdits',
      source: 'lastMode'
    },
    {
      name: 'initial when no pin/lastMode',
      input: {
        initialPermissionMode: 'auto',
        vendorMode: 'default',
        allowBypass: false
      },
      mode: 'auto',
      source: 'initialPermissionMode'
    },
    {
      name: 'vendor when nothing else set',
      input: { vendorMode: 'dontAsk', allowBypass: false },
      mode: 'dontAsk',
      source: 'vendor'
    },
    {
      name: 'default when empty',
      input: { allowBypass: false },
      mode: 'default',
      source: 'default'
    },
    {
      name: 'skip-pin path (resume/handoff): lastMode still applies',
      input: {
        pin: null, // caller omits pin
        lastMode: 'plan',
        initialPermissionMode: 'auto',
        allowBypass: false
      },
      mode: 'plan',
      source: 'lastMode'
    },
    {
      name: 'bypass pin gated without allowBypass',
      input: {
        pin: 'bypass',
        lastMode: 'plan',
        allowBypass: false
      },
      mode: 'default',
      source: 'pin',
      bypassGated: true
    },
    {
      name: 'bypass pin allowed when allowBypass',
      input: { pin: 'bypass', allowBypass: true },
      mode: 'bypass',
      source: 'pin'
    },
    {
      name: 'bypass lastMode gated without allowBypass',
      input: { lastMode: 'bypass', initialPermissionMode: 'auto', allowBypass: false },
      mode: 'default',
      source: 'lastMode',
      bypassGated: true
    },
    {
      name: 'bypass initial gated (package default trap)',
      input: { initialPermissionMode: 'bypass', allowBypass: false },
      mode: 'default',
      source: 'initialPermissionMode',
      bypassGated: true
    }
  ];
  for (const row of table) {
    const got = resolveEffectivePermissionMode(row.input);
    assert.equal(got.mode, row.mode, row.name);
    assert.equal(got.source, row.source, `${row.name} source`);
    assert.equal(got.bypassGated, row.bypassGated ?? false, `${row.name} bypassGated`);
  }
});

test('permissionModeSupportedByInventory treats empty inventory as supported', () => {
  assert.equal(permissionModeSupportedByInventory('auto', undefined), true);
  assert.equal(permissionModeSupportedByInventory('auto', []), true);
  assert.equal(permissionModeSupportedByInventory('auto', ['default', 'auto', 'plan']), true);
  assert.equal(permissionModeSupportedByInventory('default', ['manual', 'plan']), true); // alias
  assert.equal(permissionModeSupportedByInventory('bypass', ['bypassPermissions']), true);
  assert.equal(permissionModeSupportedByInventory('auto', ['default', 'plan']), false);
  assert.equal(permissionModeSupportedByInventory('plan', ['build', 'plan']), true);
});

test('isClaudePermissionBackend is Claude-only', () => {
  assert.equal(isClaudePermissionBackend('claude'), true);
  assert.equal(isClaudePermissionBackend('grok'), false);
  assert.equal(isClaudePermissionBackend('codex'), false);
  assert.equal(isClaudePermissionBackend('opencode'), false);
  assert.equal(isClaudePermissionBackend('cline'), false);
  assert.equal(isClaudePermissionBackend(null), false);
  assert.equal(isClaudePermissionBackend(undefined), false);
});

test('shouldShowAutoEducateBanner matrix (educate-on-select)', () => {
  const base = {
    selectedMode: 'auto' as PermissionMode,
    backendId: 'claude',
    pinnedMode: null as PermissionMode | null,
    dismissed: false,
    systemDriven: false
  };
  const table: Array<{
    name: string;
    input: Parameters<typeof shouldShowAutoEducateBanner>[0];
    show: boolean;
  }> = [
    { name: 'happy path: user picks auto on Claude', input: { ...base }, show: true },
    {
      name: 'not auto',
      input: { ...base, selectedMode: 'plan' },
      show: false
    },
    {
      name: 'never for grok',
      input: { ...base, backendId: 'grok' },
      show: false
    },
    {
      name: 'never for codex',
      input: { ...base, backendId: 'codex' },
      show: false
    },
    {
      name: 'never for opencode',
      input: { ...base, backendId: 'opencode' },
      show: false
    },
    {
      name: 'never for cline',
      input: { ...base, backendId: 'cline' },
      show: false
    },
    {
      name: 'never when dismissed',
      input: { ...base, dismissed: true },
      show: false
    },
    {
      name: 'never when workspace pin set',
      input: { ...base, pinnedMode: 'default' },
      show: false
    },
    {
      name: 'never when auto is already pinned',
      input: { ...base, pinnedMode: 'auto' },
      show: false
    },
    {
      name: 'never on resume/handoff/systemDriven',
      input: { ...base, systemDriven: true },
      show: false
    },
    {
      name: 'missing backend',
      input: { ...base, backendId: undefined },
      show: false
    }
  ];
  for (const row of table) {
    assert.equal(shouldShowAutoEducateBanner(row.input), row.show, row.name);
  }
});

test('modePickerOptions falls back to the static list without an inventory', () => {
  assert.deepEqual(modePickerOptions(undefined), FALLBACK_MODE_PICKER_OPTIONS);
  assert.deepEqual(modePickerOptions(null, 'plan'), FALLBACK_MODE_PICKER_OPTIONS);
  assert.deepEqual(modePickerOptions([], 'auto'), FALLBACK_MODE_PICKER_OPTIONS);
  assert.deepEqual(
    FALLBACK_MODE_PICKER_OPTIONS.map((o) => o.mode),
    ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypass']
  );
});

test('modePickerOptions maps a Claude ACP inventory with agent labels', () => {
  const options = modePickerOptions(
    [
      { id: 'default', name: 'Always Ask' },
      { id: 'acceptEdits', name: 'Accept Edits' },
      { id: 'plan', name: 'Plan Mode' },
      { id: 'bypassPermissions', name: 'Bypass Permissions' }
    ],
    'default'
  );
  assert.deepEqual(options, [
    { mode: 'default', label: 'Always Ask' },
    { mode: 'acceptEdits', label: 'Accept Edits' },
    { mode: 'plan', label: 'Plan Mode' },
    { mode: 'bypass', label: 'Bypass Permissions' }
  ]);
});

test('modePickerOptions skips non-permission ids and dedupes aliases', () => {
  // opencode agent roles must never render as permission modes.
  assert.deepEqual(
    modePickerOptions([{ id: 'build', name: 'Build' }, { id: 'read-only' }], 'default'),
    FALLBACK_MODE_PICKER_OPTIONS
  );
  // `manual` aliases `default` — first advertised label wins, no dupes.
  const options = modePickerOptions(
    [
      { id: 'default', name: 'Default' },
      { id: 'manual', name: 'Manual' },
      { id: 'plan', name: 'Plan' }
    ],
    'plan'
  );
  assert.deepEqual(options, [
    { mode: 'default', label: 'Default' },
    { mode: 'plan', label: 'Plan' }
  ]);
});

test('modePickerOptions appends the current mode when the inventory omits it', () => {
  const options = modePickerOptions(
    [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' }
    ],
    'auto'
  );
  assert.deepEqual(options, [
    { mode: 'default', label: 'Default' },
    { mode: 'plan', label: 'Plan' },
    { mode: 'auto', label: 'auto' }
  ]);
  // Present in inventory — no duplicate appended.
  assert.equal(
    modePickerOptions([{ id: 'plan', name: 'Plan' }], 'plan').filter((o) => o.mode === 'plan')
      .length,
    1
  );
});

test('modePickerOptions labels fall back to the mode id on blank names', () => {
  assert.deepEqual(modePickerOptions([{ id: 'acceptEdits', name: '  ' }]), [
    { mode: 'acceptEdits', label: 'acceptEdits' }
  ]);
  assert.deepEqual(modePickerOptions([{ id: 'dontAsk' }]), [
    { mode: 'dontAsk', label: 'dontAsk' }
  ]);
});

test('webview store ingests modes_update into modeOptions', () => {
  assert.equal(initialState.modeOptions, null);
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'modes_update',
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Always Ask' },
        { id: 'plan', name: 'Plan Mode' }
      ]
    }
  });
  assert.deepEqual(next.modeOptions, [
    { id: 'default', name: 'Always Ask' },
    { id: 'plan', name: 'Plan Mode' }
  ]);
});

test('historyLoaded clears stale modeOptions until a persisted modes_update re-applies', () => {
  const withInventory = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'modes_update',
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Always Ask' }]
    }
  });
  assert.equal(withInventory.modeOptions?.length, 1);

  const meta = {
    id: 's2',
    backend: 'claude' as const,
    title: 't',
    mode: 'default' as const,
    cwd: '/tmp',
    createdAt: 1
  };
  const cleared = reduce(withInventory, { type: 'historyLoaded', meta, records: [] });
  assert.equal(cleared.modeOptions, null);

  const restored = reduce(withInventory, {
    type: 'historyLoaded',
    meta,
    records: [
      {
        type: 'update',
        update: {
          kind: 'modes_update',
          currentModeId: 'plan',
          availableModes: [{ id: 'plan', name: 'Plan Mode' }]
        }
      }
    ]
  });
  assert.deepEqual(restored.modeOptions, [{ id: 'plan', name: 'Plan Mode' }]);
});
