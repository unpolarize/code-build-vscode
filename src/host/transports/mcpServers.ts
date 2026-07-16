/**
 * ACP session/new MCP server entries and defaults for personal-browser stack.
 * Kept free of the vscode module so unit tests can import it.
 */

export interface AcpMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

/** Default browser stack for personal Chrome (zhirafovod@gmail.com via CDP autoConnect). */
export const DEFAULT_BROWSER_MCP_SERVERS: AcpMcpServer[] = [
  {
    name: 'chrome-devtools',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect']
  },
  {
    name: 'playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest']
  }
];

/**
 * Normalize raw config items into AcpMcpServer list.
 * Returns null when input is empty/invalid so callers can fall back to defaults.
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
    out.push({ name, command, args });
  }
  return out.length > 0 ? out : null;
}

export function defaultBrowserMcpServers(): AcpMcpServer[] {
  return DEFAULT_BROWSER_MCP_SERVERS.map((s) => ({
    ...s,
    args: s.args ? [...s.args] : undefined
  }));
}
