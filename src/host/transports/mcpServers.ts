/**
 * ACP session/new MCP server entries and defaults for personal-browser stack.
 * Kept free of the vscode module so unit tests can import it.
 *
 * IMPORTANT: agent-client-protocol's untagged `McpServer` enum requires stdio
 * entries to include `env` as an array of `{name,value}` objects (may be empty).
 * Omitting `env` causes Grok ACP to reject session/new with:
 *   Invalid params: data did not match any variant of untagged enum McpServer
 * which breaks every Grok session start including restore. See 0.10.2 fix.
 */

export interface AcpMcpEnvVar {
  name: string;
  value: string;
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  /** Required by ACP untagged enum — always send an array (empty OK). */
  env: AcpMcpEnvVar[];
}

/** Default browser stack for personal Chrome (zhirafovod@gmail.com via CDP autoConnect). */
export const DEFAULT_BROWSER_MCP_SERVERS: AcpMcpServer[] = [
  {
    name: 'chrome-devtools',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
    env: []
  },
  {
    name: 'playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: []
  }
];

function normalizeEnv(raw: unknown): AcpMcpEnvVar[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpMcpEnvVar[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    const value = typeof o.value === 'string' ? o.value : '';
    if (name) out.push({ name, value });
  }
  return out;
}

/**
 * Normalize raw config items into AcpMcpServer list.
 *
 * Distinguishes:
 * - unset / not-an-array (`undefined`, `null`, non-array) → `null` so callers
 *   can inject defaults
 * - explicit empty array `[]` → `[]` (no servers — opt out of defaults)
 * - populated array → normalized servers (invalid items skipped; if every item
 *   is invalid, returns `[]` so we do not re-inject defaults after a deliberate
 *   but broken config)
 */
export function normalizeMcpServerConfig(raw: unknown): AcpMcpServer[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  // Explicit empty — caller must NOT fall back to defaults.
  if (raw.length === 0) return [];
  const out: AcpMcpServer[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    const command = typeof o.command === 'string' ? o.command : '';
    if (!name || !command) continue;
    const args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : undefined;
    out.push({ name, command, args, env: normalizeEnv(o.env) });
  }
  // Explicit array that yielded nothing after filtering → empty, not null.
  return out;
}

export function defaultBrowserMcpServers(): AcpMcpServer[] {
  return DEFAULT_BROWSER_MCP_SERVERS.map((s) => ({
    ...s,
    args: s.args ? [...s.args] : undefined,
    env: [...s.env]
  }));
}

/**
 * VS Code configuration inspect layers for `codeBuild.mcpServers`.
 * package.json default is `[]`, so `cfg.get('mcpServers')` cannot tell unset
 * from explicit empty — only workspace/global layer presence can.
 */
export interface McpServersConfigInspect {
  workspaceFolderValue?: unknown;
  workspaceValue?: unknown;
  globalValue?: unknown;
}

/** First user-defined layer (folder → workspace → global), else undefined. */
export function explicitMcpServersValue(
  inspect: McpServersConfigInspect | undefined
): unknown | undefined {
  if (!inspect) return undefined;
  if (inspect.workspaceFolderValue !== undefined) return inspect.workspaceFolderValue;
  if (inspect.workspaceValue !== undefined) return inspect.workspaceValue;
  if (inspect.globalValue !== undefined) return inspect.globalValue;
  return undefined;
}

/**
 * Resolve MCP servers for ACP session/new (pure; no vscode import).
 *
 * - `disableDefaultMcpServers: true` and no user override → `[]`
 * - no user override (all inspect layers unset) → personal-browser defaults
 * - user override `[]` → `[]` (opt out)
 * - user override populated → those servers
 * - user override non-array / all-invalid → `[]` (fail closed, no silent defaults)
 */
export function resolveAcpMcpServersFromInspect(
  inspect: McpServersConfigInspect | undefined,
  disableDefaultMcpServers = false
): AcpMcpServer[] {
  const explicit = explicitMcpServersValue(inspect);

  if (explicit === undefined) {
    return disableDefaultMcpServers ? [] : defaultBrowserMcpServers();
  }

  return normalizeMcpServerConfig(explicit) ?? [];
}

/**
 * KP (knowledge-planning) MCP injection for ACP backends.
 *
 * `kp mcp` is a stdio MCP server over the planning store (kp_search /
 * kp_create / kp_get / kp_pack / kp_link_session / kp_set_status) that stamps
 * provenance from KP_AGENT / KP_MODEL / KP_SESSION env. Injecting it on ACP
 * session/new lets agents on any ACP backend (grok, codex) search/create/link
 * planning items natively. Opt-in via `codeBuild.kpMcp.enabled` (default off);
 * `codeBuild.kp.command` (abs path to the KP CLI entry) and `codeBuild.kp.root`
 * have no defaults — missing either is a fail-open skip, never a broken spawn.
 */

/** Why a kp entry was not built/appended. `user-defined` = config already has one. */
export type KpMcpSkipReason =
  | 'disabled'
  | 'missing-command'
  | 'missing-root'
  | 'user-defined';

export interface KpMcpOptions {
  enabled: boolean;
  /** Absolute path to the KP CLI entry (e.g. .../knowledge-planning/src/cli/index.ts). */
  command: string | undefined;
  /** Planning store root → KP_ROOT. */
  root: string | undefined;
  /** ACP backend id → KP_AGENT (claude never reaches this path in v1). */
  backend: string;
  /** Session model → KP_MODEL. Falls back to 'default' — KP env beats
   * clientInfo, so without this creates get stamped model "0.0.1". */
  model: string | undefined;
  /** Host session id at spawn → KP_SESSION (backend uuid isn't known yet;
   * deferred link-session covers the real uuid later). */
  sessionId: string;
  /** Node executable for spawning the CLI; defaults to process.execPath. */
  execPath?: string;
}

/**
 * Build the kp MCP server entry (pure; no vscode import).
 *
 * The entry always spawns via the node executable (`execPath`) with
 * `args: [cliPath, 'mcp']` — a `command` of bare 'node' or of the node binary
 * itself is a misconfiguration (it is the CLI *script* path) and is rejected
 * as `missing-command` rather than producing a broken spawn.
 */
export function buildKpMcpServerEntry(
  opts: KpMcpOptions
): { server: AcpMcpServer } | { skip: KpMcpSkipReason } {
  if (!opts.enabled) return { skip: 'disabled' };
  const execPath = opts.execPath ?? process.execPath;
  const cli = (opts.command ?? '').trim();
  if (!cli || cli === 'node' || cli === execPath) return { skip: 'missing-command' };
  const root = (opts.root ?? '').trim();
  if (!root) return { skip: 'missing-root' };
  const model = (opts.model ?? '').trim();
  return {
    server: {
      name: 'kp',
      command: execPath,
      args: [cli, 'mcp'],
      // ALWAYS all four: KP resolves provenance env > clientInfo > defaults,
      // so a missing KP_MODEL stamps creates with clientInfo's "0.0.1".
      env: [
        { name: 'KP_ROOT', value: root },
        { name: 'KP_AGENT', value: opts.backend },
        { name: 'KP_MODEL', value: model || 'default' },
        { name: 'KP_SESSION', value: opts.sessionId }
      ]
    }
  };
}

/**
 * Append the kp entry to an already-resolved server list.
 *
 * - disabled / unconfigured → base unchanged, skip reason returned
 * - base already has an exact `name === 'kp'` entry → base unchanged
 *   (never rewrite a user-supplied kp entry), skip 'user-defined'
 * - otherwise append — including when base is `[]`: the kpMcp.enabled
 *   setting is the opt-in, independent of the browser defaults.
 */
export function appendKpMcpServer(
  base: AcpMcpServer[],
  opts: KpMcpOptions
): { servers: AcpMcpServer[]; skip?: KpMcpSkipReason } {
  const built = buildKpMcpServerEntry(opts);
  if ('skip' in built) return { servers: base, skip: built.skip };
  if (base.some((s) => s.name === 'kp')) return { servers: base, skip: 'user-defined' };
  return { servers: [...base, built.server] };
}
