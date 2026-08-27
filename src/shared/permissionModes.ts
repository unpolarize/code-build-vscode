import type { PermissionMode } from './acpTypes';

/**
 * Claude / claude-agent-acp wire id → CB PermissionMode. The wire vocabulary
 * is `default` (alias `manual` ≥2.1.200) | `acceptEdits` | `plan` | `auto` |
 * `dontAsk` | `bypassPermissions`. ACP SessionModeId is an opaque string and
 * other backends put NON-permission concepts there (opencode agent roles like
 * `build`, codex approval presets) — those return null and must be shown as a
 * labeled passthrough, never coerced into a permission mode.
 */
export function permissionModeFromAcpId(id: string): PermissionMode | null {
  switch (id) {
    case 'default':
    case 'manual':
      return 'default';
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'auto':
      return 'auto';
    case 'dontAsk':
      return 'dontAsk';
    case 'bypassPermissions':
    case 'bypass':
      return 'bypass';
    default:
      return null;
  }
}

/** CB PermissionMode → the wire id to send on `session/set_mode` (and the
 * `--permission-mode` value for Claude stream-json spawns). */
export function acpIdForPermissionMode(mode: PermissionMode): string {
  return mode === 'bypass' ? 'bypassPermissions' : mode;
}
