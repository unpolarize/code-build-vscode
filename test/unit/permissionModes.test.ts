import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acpIdForPermissionMode,
  permissionModeFromAcpId
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
