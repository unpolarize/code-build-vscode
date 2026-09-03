import type { PermissionMode } from './acpTypes';

/** workspaceState key — per-workspace sticky permission mode (P2 pin). */
export const PINNED_PERMISSION_MODE_KEY = 'codeBuild.pinnedPermissionMode';

/** workspaceState flag — one-shot warn when a pin is not advertised by the agent. */
export const PIN_UNSUPPORTED_WARNED_KEY = 'codeBuild.pinnedPermissionMode.unsupportedWarned';

/**
 * workspaceState flag — P3 educate-on-select: once the Auto-mode notice has
 * been shown (or explicitly dismissed) for this workspace, never refire.
 */
export const AUTO_EDUCATE_DISMISSED_KEY = 'codeBuild.autoModeEducateDismissed';

/** Claude permission-modes docs linked from the educate-on-select notice. */
export const AUTO_MODE_DOCS_URL = 'https://code.claude.com/docs/en/permission-modes.md';

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

/**
 * Claude is the only backend whose permission vocabulary includes Auto
 * (classifier). Other backends either lack permission modes or use
 * non-permission mode ids (opencode roles, codex presets).
 */
export function isClaudePermissionBackend(backendId: string | null | undefined): boolean {
  return backendId === 'claude';
}

export interface AutoEducateBannerInput {
  /** Selected mode the user just applied (post-success). */
  selectedMode: PermissionMode;
  /** Active session backend id. */
  backendId: string | null | undefined;
  /** workspaceState pin — any pin means the user already made a sticky choice. */
  pinnedMode?: PermissionMode | null;
  /** workspaceState dismiss / already-shown flag. */
  dismissed: boolean;
  /**
   * True for resume / handoff / switchBackend / pin-reapply paths that must
   * never surface the notice (even if the resulting mode is auto).
   */
  systemDriven?: boolean;
}

/**
 * P3 educate-on-select predicate (redefined — vendor-inherit Auto-default
 * banner is dead under CB-owned spawn defaults). Show once per workspace
 * the first time the user successfully picks `auto` on Claude.
 */
export function shouldShowAutoEducateBanner(input: AutoEducateBannerInput): boolean {
  if (input.dismissed) return false;
  if (input.systemDriven) return false;
  if (input.selectedMode !== 'auto') return false;
  if (!isClaudePermissionBackend(input.backendId)) return false;
  if (input.pinnedMode != null) return false;
  return true;
}
