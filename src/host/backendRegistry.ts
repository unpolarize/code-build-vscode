import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackendId, PermissionMode } from '../shared/acpTypes';

const pexecFile = promisify(execFile);

export type TransportKind = 'stream-json' | 'acp' | 'exec-json';

/** Effort / thinking-budget level. These are the exact levels both the
 * `claude` and `grok` CLIs accept for `--effort` (low/medium/high/xhigh/max).
 * `default` = let the agent pick (don't pass a flag). */
export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The effort levels offered in the UI picker (shared by every backend that
 * supports effort). Kept here so the webview and host agree on the set. */
export const EFFORT_LEVELS: EffortLevel[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

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
    /** Whether the user has opted into the bypass/skip-permissions escape
     * hatch (codeBuild.allowDangerouslySkipPermissions). buildArgs uses it
     * to gate --dangerously-skip-permissions. */
    allowBypass?: boolean;
    /** Extra directories the agent's tools are allowed to read/write
     * beyond `cwd`. claude maps these to `--add-dir`; other backends
     * may ignore. */
    additionalTrustedDirs?: string[];
  }): string[];
  /** Known model ids for the dropdown. The first entry is treated as the
   * default; empty list disables the picker (UI shows nothing). */
  models?: string[];
  /** Whether the effort picker should be shown for this backend. */
  supportsEffort?: boolean;
  /** Whether the CLI accepts an external `--resume <session-id>` flag
   * to pick up a prior conversation's transcript on a fresh spawn.
   * `true` for claude (we pass `--resume <backendSessionId>` and the
   * agent reads its own jsonl). `false` for ACP-based backends like
   * grok — the protocol doesn't expose a session id the host can hand
   * back to a new process. For backends with `false`, code-build
   * auto-injects the conversation history as a primer on the user's
   * first prompt so the resumed agent has context. */
  supportsResume?: boolean;
}

// Centralizing spawn args here isolates CLI flag drift to one place (see spec §8).
export const BACKENDS: Record<BackendId, BackendSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    transport: 'stream-json',
    // Aliases, not version-pinned ids. The `claude` CLI resolves 'opus' /
    // 'sonnet' / 'haiku' to the latest model in each family, so these never
    // go stale (e.g. 'opus' → Opus 4.8 today). detectAll() may replace this
    // with a dynamically-discovered list when available.
    models: ['default', 'opus', 'sonnet', 'haiku'],
    supportsEffort: true,
    // claude -p --resume <session-id> reads the jsonl claude itself
    // wrote at ~/.claude/projects/<...>/<id>.jsonl on a clean restart.
    supportsResume: true,
    buildArgs: ({ mode, model, resumeId, effort, allowBypass, additionalTrustedDirs }) => {
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose'
      ];
      if (model && model !== 'default') args.push('--model', model);
      // Permission handling. In bypass mode we hand claude full autonomy via
      // --dangerously-skip-permissions (the only flag that actually stops ALL
      // prompts in headless -p mode — --permission-mode bypassPermissions
      // still expects a permission responder we don't run). Gated by the
      // allowBypass capability so it can't fire unless the user opted in.
      if (mode === 'bypass' && allowBypass) {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--permission-mode', claudePermMode(mode));
      }
      if (resumeId) args.push('--resume', resumeId);
      // claude effort levels: low/medium/high/xhigh/max. `default` skips.
      if (effort && effort !== 'default') args.push('--effort', effort);
      // --add-dir is the ONLY way to widen claude's tool-access scope
      // beyond the spawn cwd. --dangerously-skip-permissions only
      // skips the prompt UI — tools still refuse paths outside cwd +
      // --add-dir entries. Terminal-claude users typically run from
      // ~ or have ~/.claude/settings.json pre-trusting their home,
      // which is why their workflow feels unrestricted. Code-build
      // spawns from the workspace folder, so without these flags
      // claude looks "locked to the project repo" — exactly the bug
      // the user reported. We pass every entry from the host through.
      if (additionalTrustedDirs && additionalTrustedDirs.length > 0) {
        for (const dir of additionalTrustedDirs) {
          if (dir) args.push('--add-dir', dir);
        }
      }
      return args;
    }
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    bin: 'grok',
    transport: 'acp',
    // Populated dynamically from ~/.grok/models_cache.json by detectAll().
    // This static fallback covers a fresh install whose cache isn't written
    // yet. grok ACP takes the model on the spawn command line via -m.
    models: ['default', 'grok-build'],
    supportsEffort: true,
    // ACP transports don't expose a session id the host can hand back
    // to a new process. The host auto-injects the conversation history
    // as a primer on the first prompt instead.
    supportsResume: false,
    // grok's reasoning options belong to the `grok agent` command and MUST
    // precede the `stdio` subcommand, which itself accepts no flags. The flag
    // is `--reasoning-effort` (NOT `--effort`), and grok's accepted levels are
    // none/minimal/low/medium/high/xhigh — it rejects `max`, so map our `max`
    // down to grok's ceiling `xhigh`. (Passing `--effort` or putting any option
    // after `stdio` makes grok exit 2 with "unexpected argument", which is what
    // hung new grok sessions / broke claude→grok hand-off.)
    buildArgs: ({ model, effort }) => {
      const args = ['agent'];
      if (model && model !== 'default') args.push('--model', model);
      if (effort && effort !== 'default') {
        args.push('--reasoning-effort', effort === 'max' ? 'xhigh' : effort);
      }
      args.push('stdio');
      return args;
    }
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
      models: discoverModels(spec),
      supportsEffort: spec.supportsEffort
    }))
  );
  return results;
}

/** Resolve the model list for a backend at detection time. Grok ships a
 * `~/.grok/models_cache.json` the CLI keeps fresh — we read it so the picker
 * reflects what the user can actually select (and picks up new xAI models
 * without a code change). Other backends fall back to the static list on the
 * spec. Always prepends 'default' so the user can defer to the CLI. */
function discoverModels(spec: BackendSpec): string[] {
  if (spec.id === 'grok') {
    const fromCache = readGrokModels();
    if (fromCache.length > 0) return ['default', ...fromCache];
  }
  return spec.models ?? [];
}

/** Read model ids out of grok's local cache. Returns [] on any failure
 * (missing file, malformed JSON, hidden models) so callers fall back to
 * the static list. */
function readGrokModels(): string[] {
  try {
    // Lazy require keeps these node builtins out of the module's import
    // graph for environments that don't need them.
    const fsmod = require('node:fs') as typeof import('node:fs');
    const osmod = require('node:os') as typeof import('node:os');
    const pathmod = require('node:path') as typeof import('node:path');
    const p = pathmod.join(osmod.homedir(), '.grok', 'models_cache.json');
    const raw = fsmod.readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as { models?: Record<string, { info?: { hidden?: boolean } }> };
    const models = json.models ?? {};
    return Object.keys(models).filter((id) => !models[id]?.info?.hidden);
  } catch {
    return [];
  }
}
