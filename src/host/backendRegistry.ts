import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendId, PermissionMode } from '../shared/acpTypes';

const pexecFile = promisify(execFile);

export type TransportKind = 'stream-json' | 'acp' | 'exec-json';

/** Effort / thinking-budget level — Claude Code's runtime UI exposes this
 * as a 5-step slider; we mirror it for any backend that maps cleanly.
 * `default` = let the agent pick (don't pass a flag). */
export type EffortLevel = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface BackendSpec {
  id: BackendId;
  label: string;
  bin: string;
  transport: TransportKind;
  /** Build argv to spawn the agent process for an interactive session. */
  buildArgs(opts: {
    cwd: string;
    mode: PermissionMode;
    model?: string;
    resumeId?: string;
    effort?: EffortLevel;
  }): string[];
  /** Known model ids for the dropdown. The first entry is treated as the
   * default; empty list disables the picker (UI shows nothing). */
  models?: string[];
  /** Whether the effort picker should be shown for this backend. */
  supportsEffort?: boolean;
}

// Centralizing spawn args here isolates CLI flag drift to one place (see spec §8).
export const BACKENDS: Record<BackendId, BackendSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    transport: 'stream-json',
    // Model ids as of Claude Code 1.0.x. The CLI also accepts shorthand
    // ('sonnet'/'opus'/'haiku') and 'default' — we expose the verbose ids
    // to make per-version selection unambiguous.
    models: [
      'default',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5'
    ],
    supportsEffort: true,
    buildArgs: ({ mode, model, resumeId, effort }) => {
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose'
      ];
      if (model && model !== 'default') args.push('--model', model);
      args.push('--permission-mode', claudePermMode(mode));
      if (resumeId) args.push('--resume', resumeId);
      // `--thinking-budget` was renamed to `--effort` in claude code 1.x.
      // We pass the level by name; claude maps it to its internal token
      // budget. `default` skips the flag.
      if (effort && effort !== 'default') args.push('--effort', effort);
      return args;
    }
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    transport: 'acp',
    // xAI models surfaced by `grok` CLI as of 2026-05. `grok-build` is the
    // SuperGrok-bundled coding agent; `grok-4.20` / `grok-4.3` come with
    // API-key auth. Model swap mid-ACP-session isn't supported; the
    // selection only takes effect on next session spawn.
    models: ['default', 'grok-build', 'grok-4.20', 'grok-4.3'],
    // grok's ACP daemon takes the model from a session-level config that
    // we set via env. See env composition in streamJsonTransport.
    supportsEffort: false,
    buildArgs: () => ['agent', 'stdio']
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    transport: 'exec-json',
    models: ['default', 'gpt-5', 'gpt-5-mini', 'o3', 'o3-mini'],
    supportsEffort: true,
    // The prompt is appended by CodexTransport at spawn time (spawn-per-prompt model).
    buildArgs: ({ mode, model, effort }) => {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', codexSandbox(mode)];
      if (model && model !== 'default') args.push('--model', model);
      // Codex uses `--reasoning-effort` for the o-series models.
      if (effort && effort !== 'default') args.push('--reasoning-effort', effort);
      return args;
    }
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    transport: 'acp',
    models: [],
    supportsEffort: false,
    buildArgs: () => ['acp']
  },
  cline: {
    id: 'cline',
    label: 'Cline',
    bin: 'cline',
    transport: 'acp',
    models: [],
    supportsEffort: false,
    buildArgs: () => ['--acp']
  }
};

function claudePermMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'bypass':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

function codexSandbox(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
    case 'bypass':
      return 'workspace-write';
    default:
      return 'read-only';
  }
}

/** Resolve the binary path: explicit override > PATH lookup. */
export function resolveBin(spec: BackendSpec, overrides: Record<string, string>): string {
  return overrides[spec.id] || spec.bin;
}

/** Probe whether a backend binary is available on this machine. */
export async function detectBackend(
  spec: BackendSpec,
  overrides: Record<string, string>
): Promise<boolean> {
  const bin = resolveBin(spec, overrides);
  try {
    // `which` on POSIX; if an absolute override is given, just stat via which too.
    await pexecFile('which', [bin], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export async function detectAll(
  overrides: Record<string, string>
): Promise<
  Array<{
    id: BackendId;
    label: string;
    available: boolean;
    models?: string[];
    supportsEffort?: boolean;
  }>
> {
  const entries = Object.values(BACKENDS);
  const results = await Promise.all(
    entries.map(async (spec) => ({
      id: spec.id,
      label: spec.label,
      available: await detectBackend(spec, overrides),
      models: spec.models,
      supportsEffort: spec.supportsEffort
    }))
  );
  return results;
}
