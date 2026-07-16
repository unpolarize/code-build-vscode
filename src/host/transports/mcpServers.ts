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
 * Returns null when input is empty/invalid so callers can fall back to defaults.
 * Always forces `env` to an array so ACP deserialize succeeds.
 */
export function normalizeMcpServerConfig(raw: unknown): AcpMcpServer[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
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
  return out.length > 0 ? out : null;
}

export function defaultBrowserMcpServers(): AcpMcpServer[] {
  return DEFAULT_BROWSER_MCP_SERVERS.map((s) => ({
    ...s,
    args: s.args ? [...s.args] : undefined,
    env: [...s.env]
  }));
}
