import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendId, PermissionMode } from '../shared/acpTypes';

const pexecFile = promisify(execFile);

export type TransportKind = 'stream-json' | 'acp' | 'exec-json';

export interface BackendSpec {
  id: BackendId;
  label: string;
  bin: string;
  transport: TransportKind;
  /** Build argv to spawn the agent process for an interactive session. */
  buildArgs(opts: { cwd: string; mode: PermissionMode; model?: string; resumeId?: string }): string[];
  /** Map our permission mode to the backend's own flag values, where relevant. */
  models?: string[];
}

// Centralizing spawn args here isolates CLI flag drift to one place (see spec §8).
export const BACKENDS: Record<BackendId, BackendSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    transport: 'stream-json',
    buildArgs: ({ mode, model, resumeId }) => {
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose'
      ];
      if (model) args.push('--model', model);
      args.push('--permission-mode', claudePermMode(mode));
      if (resumeId) args.push('--resume', resumeId);
      return args;
    }
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    transport: 'acp',
    buildArgs: () => ['agent', 'stdio']
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    transport: 'exec-json',
    // The prompt is appended by CodexTransport at spawn time (spawn-per-prompt model).
    buildArgs: ({ mode, model }) => {
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', codexSandbox(mode)];
      if (model) args.push('--model', model);
      return args;
    }
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    bin: 'opencode',
    transport: 'acp',
    buildArgs: () => ['acp']
  },
  cline: {
    id: 'cline',
    label: 'Cline',
    bin: 'cline',
    transport: 'acp',
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
): Promise<{ id: BackendId; label: string; available: boolean }[]> {
  const entries = Object.values(BACKENDS);
  const results = await Promise.all(
    entries.map(async (spec) => ({
      id: spec.id,
      label: spec.label,
      available: await detectBackend(spec, overrides)
    }))
  );
  return results;
}
