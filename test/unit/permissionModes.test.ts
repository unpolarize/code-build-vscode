import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acpIdForPermissionMode,
  isPermissionMode,
  permissionModeFromAcpId,
  permissionModeSupportedByInventory,
  resolveEffectivePermissionMode
} from '../../src/shared/permissionModes';
import type { PermissionMode } from '../../src/shared/acpTypes';

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
