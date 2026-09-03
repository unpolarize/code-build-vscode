import type { PermissionMode } from './acpTypes';

/** workspaceState key — per-workspace sticky permission mode (P2 pin). */
export const PINNED_PERMISSION_MODE_KEY = 'codeBuild.pinnedPermissionMode';

/** workspaceState flag — one-shot warn when a pin is not advertised by the agent. */
export const PIN_UNSUPPORTED_WARNED_KEY = 'codeBuild.pinnedPermissionMode.unsupportedWarned';

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypass',
  'auto',
  'dontAsk'
];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

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

/** Which layer won in {@link resolveEffectivePermissionMode}. */
export type PermissionModeSource =
  | 'pin'
  | 'lastMode'
  | 'initialPermissionMode'
  | 'vendor'
  | 'default';

export interface ResolvePermissionModeInput {
  /** workspaceState pin — wins when set (new sessions only). */
  pin?: PermissionMode | null;
  /** globalState.lastMode from a prior manual selection. */
  lastMode?: PermissionMode | null;
  /** `codeBuild.initialPermissionMode` setting. */
  initialPermissionMode?: PermissionMode | null;
  /** Agent-advertised current mode (session/new|load); last-resort fallback. */
  vendorMode?: PermissionMode | null;
  /** Escape hatch: bypass is never auto-applied without this. */
  allowBypass: boolean;
}

export interface ResolvePermissionModeResult {
  mode: PermissionMode;
  source: PermissionModeSource;
  /** True when the winning candidate was bypass and got gated to default. */
  bypassGated: boolean;
}

/**
 * Precedence for a NEW session: pin > lastMode > initialPermissionMode >
 * vendor advertised > default. Bypass is never restored unless allowBypass.
 * Resume/handoff callers must skip the pin layer (pass pin: null / omit).
 */
export function resolveEffectivePermissionMode(
  input: ResolvePermissionModeInput
): ResolvePermissionModeResult {
  const layers: Array<{ source: PermissionModeSource; mode: PermissionMode | null | undefined }> = [
    { source: 'pin', mode: input.pin },
    { source: 'lastMode', mode: input.lastMode },
    { source: 'initialPermissionMode', mode: input.initialPermissionMode },
    { source: 'vendor', mode: input.vendorMode }
  ];
  for (const layer of layers) {
    if (layer.mode == null) continue;
    if (!isPermissionMode(layer.mode)) continue;
    if (layer.mode === 'bypass' && !input.allowBypass) {
      return { mode: 'default', source: layer.source, bypassGated: true };
    }
    return { mode: layer.mode, source: layer.source, bypassGated: false };
  }
  return { mode: 'default', source: 'default', bypassGated: false };
}

/**
 * Whether a CB permission mode is present in an ACP availableModes inventory.
 * Aliases count: agent advertising `manual` accepts CB `default`; advertising
 * `bypassPermissions` accepts CB `bypass`. Empty/missing inventory → treat as
 * supported (stream-json / unknown agents have no inventory to validate).
 */
export function permissionModeSupportedByInventory(
  mode: PermissionMode,
  availableModeIds: readonly string[] | null | undefined
): boolean {
  if (!availableModeIds || availableModeIds.length === 0) return true;
  const wire = acpIdForPermissionMode(mode);
  if (availableModeIds.includes(wire)) return true;
  return availableModeIds.some((id) => permissionModeFromAcpId(id) === mode);
}
