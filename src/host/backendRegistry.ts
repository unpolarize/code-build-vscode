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

/**
 * Collapse any claude model id — version-pinned (`claude-opus-4-8`), vendor-prefixed
 * (`us.anthropic.claude-opus-4-1-…`), or bare — to its family alias (`opus`/`sonnet`/
 * `haiku`). The `claude` CLI resolves these aliases to whatever model each environment
 * actually provisions, so they're portable across installs. Resuming a session must
 * pass the alias, NOT the transcript's pinned id: a differently-provisioned install
 * (e.g. Bedrock that only serves Opus 4.1) rejects an unknown pinned id with
 * "The provided model identifier is invalid". Returns undefined for ids with no
 * recognizable family (opaque ARNs, non-claude models) so the caller falls back to
 * the environment default.
 */
export function claudeFamilyAlias(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const m = modelId.toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return undefined;
}

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
    // Aliases, not version-pinned ids. The `claude` CLI resolves 'fable' /
    // 'opus' / 'sonnet' / 'haiku' to the latest model in each family, so these
    // never go stale (e.g. 'fable' → Fable 5, 'opus' → Opus 4.8 today).
    // detectAll() may replace this with a dynamically-discovered list.
    models: ['default', 'fable', 'opus', 'sonnet', 'haiku'],
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
      // Always hand claude a portable FAMILY ALIAS (opus/sonnet/haiku), never a
      // version-pinned id. A pinned id baked into a resumed session (`--resume`)
      // can reach a Bedrock/enterprise backend untranslated and be rejected with
      // "The provided model identifier is invalid" — even when the same id worked
      // on a fresh turn (where modelOverrides translate it). The alias resolves to
      // whatever model the environment actually provisions. Unknown ids (opaque
      // inference-profile ARNs) pass through unchanged.
      const claudeModel = claudeFamilyAlias(model) ?? model;
      if (claudeModel && claudeModel !== 'default') args.push('--model', claudeModel);
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
    // Grok ACP advertises loadSession and accepts session/load with the
    // native session UUID from ~/.grok/sessions. AcpTransport uses
    // session/load when resumeId is set (see 0.10.2). Primer injection
    // remains a fallback if load fails or loadSession is false.
    supportsResume: true,
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

/** Resolve the model list for a backend at detection time.
 *
 * Every backend now discovers what's actually available on THIS machine, so a
 * newer model (e.g. `claude-fable-5`) shows up in the picker without a code
 * change. Discovery is best-effort and additive: whatever a backend finds is
 * merged with its curated aliases and de-duplicated, so a discovery miss never
 * makes the picker worse than the static list. `default` always leads. */
function discoverModels(spec: BackendSpec): string[] {
  const discovered =
    spec.id === 'grok' ? readGrokModels() : spec.id === 'claude' ? readClaudeModels() : spec.id === 'codex' ? readCodexModels() : [];
  return dedupeModels(['default', ...(spec.models ?? []).filter((m) => m !== 'default'), ...discovered]);
}

/** Discovered model list for a backend id — the same list the picker shows.
 * Use this (not the static `BACKENDS[id].models`) anywhere a model needs to be
 * validated, so a dynamically-discovered selection (e.g. `claude-fable-5`)
 * survives session restore. */
export function modelsFor(id: BackendId): string[] {
  const spec = BACKENDS[id];
  return spec ? discoverModels(spec) : [];
}

/** Order-preserving de-dupe, dropping empties. */
function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/** Lazy node builtins — kept out of the import graph for environments that
 * don't need them (webview bundle). */
function nodeMods() {
  return {
    fs: require('node:fs') as typeof import('node:fs'),
    os: require('node:os') as typeof import('node:os'),
    path: require('node:path') as typeof import('node:path')
  };
}

/** Read model ids out of grok's local cache (the CLI keeps it fresh). Returns
 * [] on any failure so callers fall back to the static list. */
function readGrokModels(): string[] {
  try {
    const { fs, os, path } = nodeMods();
    const p = path.join(os.homedir(), '.grok', 'models_cache.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      models?: Record<string, { info?: { hidden?: boolean } }>;
    };
    const models = json.models ?? {};
    return Object.keys(models).filter((id) => !models[id]?.info?.hidden);
  } catch {
    return [];
  }
}

/** Discover Claude models for THIS machine. The `claude` CLI has no `models`
 * subcommand and no model cache, so we combine two local signals:
 *   1. the configured default in ~/.claude/settings.json (`model`, and any
 *      fallback), stripping a trailing context-window tag like `[1m]`; and
 *   2. distinct model ids seen in recent session transcripts under
 *      ~/.claude/projects/<...>/*.jsonl.
 * This is why `claude-fable-5` shows up on a machine configured to use it —
 * the old hardcoded [opus,sonnet,haiku] alias list never could. Returns [] on
 * any failure. */
function readClaudeModels(): string[] {
  const found = new Set<string>();
  try {
    const { fs, os, path } = nodeMods();
    const home = os.homedir();

    // (1) configured model(s) from settings.json
    try {
      const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      for (const key of ['model', 'fallbackModel', 'fallback-model']) {
        const v = s[key];
        if (typeof v === 'string') {
          const id = normalizeClaudeModel(v);
          if (id) found.add(id);
        }
      }
    } catch {
      /* settings optional */
    }

    // (2) model ids used in recent session transcripts (last ~10 files)
    const projects = path.join(home, '.claude', 'projects');
    const files = recentJsonl(fs, path, projects, 10);
    const re = /"model":"([^"]+)"/g;
    for (const file of files) {
      try {
        const text = fs.readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const id = normalizeClaudeModel(m[1]);
          if (id) found.add(id);
        }
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    return [];
  }
  return [...found];
}

/** Keep real model ids (`claude-fable-5`, `claude-opus-4-8`), drop the CLI's
 * `[1m]`-style context suffix and synthetic/placeholder markers. */
function normalizeClaudeModel(raw: string): string | null {
  const id = raw.replace(/\[[^\]]*\]\s*$/, '').trim();
  if (!id || id.startsWith('<')) return null; // e.g. "<synthetic>"
  return /^claude-/.test(id) ? id : null;
}

/** Codex has no `models` subcommand or cache; surface any ids hinted in
 * ~/.codex/config.toml (e.g. the model-availability block). Additive to the
 * curated list. */
function readCodexModels(): string[] {
  try {
    const { fs, os, path } = nodeMods();
    const toml = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const ids = new Set<string>();
    // `model = "gpt-5.5"` and quoted keys like `"gpt-5.5" = 1`
    for (const m of toml.matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)) ids.add(m[1]);
    for (const m of toml.matchAll(/"(gpt-[^"]+|o[0-9][^"]*)"\s*=/g)) ids.add(m[1]);
    return [...ids];
  } catch {
    return [];
  }
}

/** N most-recently-modified *.jsonl files under a directory tree (shallow
 * recurse, cheap: one level of project dirs). */
function recentJsonl(
  fs: typeof import('node:fs'),
  path: typeof import('node:path'),
  root: string,
  limit: number
): string[] {
  const out: Array<{ file: string; mtime: number }> = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root).map((d) => path.join(root, d));
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        out.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((e) => e.file);
}
