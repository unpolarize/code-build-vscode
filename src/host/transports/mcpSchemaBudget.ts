/**
 * MCP schema token budget (PR1): static-table knapsack over ACP MCP servers.
 *
 * Pure / vscode-free. Live probe + cache is PR2 — this module only ever
 * REMOVES known-cost servers under an explicit budget (fail-open otherwise).
 *
 * Estimate convention mirrors webview estimateTokensFromText: ceil(chars/4).
 * Static defaults for the personal-browser stack were measured once from
 * tools/list JSON (chrome-devtools ≈ 5811, playwright ≈ 4617).
 */

import type { AcpMcpServer } from './mcpServers';

/** Pre-seeded schema-token costs for known default servers. */
export const DEFAULT_SCHEMA_TOKEN_TABLE: Readonly<Record<string, number>> = {
  'chrome-devtools': 5811,
  playwright: 4617
};

/** kp is always exempt — filter composes after appendKpMcpServer and never drops it. */
export const MCP_SCHEMA_BUDGET_EXEMPT = new Set(['kp']);

export interface McpSchemaBudgetOpts {
  /** Token budget. 0 / undefined / null / NaN / negative → off (byte-identical list). */
  budget: number;
  /**
   * Explicit priority order (highest first). Servers not listed keep their
   * relative input order after all priority-listed ones.
   */
  priority?: readonly string[];
  /** Per-name overrides (from config schemaTokens or a side map). */
  schemaTokensOverrides?: Readonly<Record<string, number>>;
}

export interface McpSchemaCost {
  name: string;
  /** Resolved token cost, or undefined when unknown (fail-open include). */
  tokens: number | undefined;
  known: boolean;
  exempt: boolean;
}

export interface McpSchemaBudgetResult {
  included: AcpMcpServer[];
  deferred: AcpMcpServer[];
  /** Exact log shape for the Code Build: MCP channel. */
  logLine: string;
  /** Human-readable warnings (oversize solo, unknown costs included, …). */
  warnings: string[];
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** ceil(stableStringify(tools).length / 4) — used by PR2 probe path; exported for tests. */
export function estimateSchemaTokensFromTools(tools: unknown): number {
  const s = stableStringify(tools);
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}

/**
 * Resolve schema-token cost for a server.
 * Priority: per-server schemaTokens field → overrides map → static table → unknown.
 */
export function resolveSchemaTokenCost(
  server: AcpMcpServer,
  overrides?: Readonly<Record<string, number>>
): McpSchemaCost {
  const exempt = MCP_SCHEMA_BUDGET_EXEMPT.has(server.name);
  if (typeof server.schemaTokens === 'number' && Number.isFinite(server.schemaTokens) && server.schemaTokens >= 0) {
    return { name: server.name, tokens: Math.floor(server.schemaTokens), known: true, exempt };
  }
  const fromOverride = overrides?.[server.name];
  if (typeof fromOverride === 'number' && Number.isFinite(fromOverride) && fromOverride >= 0) {
    return { name: server.name, tokens: Math.floor(fromOverride), known: true, exempt };
  }
  const fromTable = DEFAULT_SCHEMA_TOKEN_TABLE[server.name];
  if (typeof fromTable === 'number') {
    return { name: server.name, tokens: fromTable, known: true, exempt };
  }
  return { name: server.name, tokens: undefined, known: false, exempt };
}

/** Strip host-only fields before the ACP session/new|load payload. */
export function toAcpMcpPayload(servers: readonly AcpMcpServer[]): AcpMcpServer[] {
  return servers.map((s) => {
    const { schemaTokens: _drop, ...rest } = s;
    return {
      name: rest.name,
      command: rest.command,
      ...(rest.args !== undefined ? { args: rest.args } : {}),
      env: Array.isArray(rest.env) ? rest.env.map((e) => ({ name: e.name, value: e.value })) : []
    };
  });
}

function formatCostLabel(cost: McpSchemaCost): string {
  if (!cost.known || cost.tokens === undefined) return `${cost.name}(unknown)`;
  return `${cost.name}(~${cost.tokens})`;
}

function buildLogLine(
  included: McpSchemaCost[],
  deferred: McpSchemaCost[],
  budget: number
): string {
  const inc = included.map(formatCostLabel).join(',');
  const def = deferred.map(formatCostLabel).join(',');
  return `MCP schema budget: included=[${inc}] deferred=[${def}] budget=${budget}`;
}

/**
 * Greedy-by-priority knapsack. Higher priority is never dropped to fit lower.
 * Exempt (kp) always included and do not consume budget.
 * Unknown cost → include (fail-open) and do not consume budget.
 * Oversize single known server → skip + warn (never included).
 *
 * budget ≤ 0 → return servers unchanged (identity), empty deferred, no log pressure.
 */
export function applyMcpSchemaBudget(
  servers: readonly AcpMcpServer[],
  opts: McpSchemaBudgetOpts
): McpSchemaBudgetResult {
  const budgetRaw = opts.budget;
  const budget =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : 0;

  if (budget <= 0) {
    const included = [...servers];
    return {
      included,
      deferred: [],
      logLine: `MCP schema budget: included=[${included.map((s) => s.name).join(',')}] deferred=[] budget=0`,
      warnings: []
    };
  }

  const priority = opts.priority ?? [];
  const priIndex = new Map<string, number>();
  priority.forEach((name, i) => {
    if (!priIndex.has(name)) priIndex.set(name, i);
  });

  // Stable sort: priority-listed first (by list order), then original order.
  const indexed = servers.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const pa = priIndex.has(a.s.name) ? priIndex.get(a.s.name)! : Number.POSITIVE_INFINITY;
    const pb = priIndex.has(b.s.name) ? priIndex.get(b.s.name)! : Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.i - b.i;
  });

  const included: AcpMcpServer[] = [];
  const deferred: AcpMcpServer[] = [];
  const includedCosts: McpSchemaCost[] = [];
  const deferredCosts: McpSchemaCost[] = [];
  const warnings: string[] = [];
  let used = 0;

  for (const { s } of indexed) {
    const cost = resolveSchemaTokenCost(s, opts.schemaTokensOverrides);

    if (cost.exempt) {
      included.push(s);
      includedCosts.push(cost);
      continue;
    }

    if (!cost.known || cost.tokens === undefined) {
      included.push(s);
      includedCosts.push(cost);
      warnings.push(
        `MCP schema budget: including '${s.name}' with unknown schema cost (fail-open)`
      );
      continue;
    }

    if (cost.tokens > budget) {
      deferred.push(s);
      deferredCosts.push(cost);
      warnings.push(
        `MCP schema budget: skipping oversize '${s.name}' (~${cost.tokens} > budget ${budget})`
      );
      continue;
    }

    if (used + cost.tokens <= budget) {
      included.push(s);
      includedCosts.push(cost);
      used += cost.tokens;
    } else {
      deferred.push(s);
      deferredCosts.push(cost);
    }
  }

  // Restore original relative order for included/deferred (knapsack decided
  // membership by priority, but payload order should match input order).
  const includedSet = new Set(included);
  const deferredSet = new Set(deferred);
  const includedOrdered = servers.filter((s) => includedSet.has(s));
  const deferredOrdered = servers.filter((s) => deferredSet.has(s));
  const costByName = new Map(
    [...includedCosts, ...deferredCosts].map((c) => [c.name, c] as const)
  );

  return {
    included: includedOrdered,
    deferred: deferredOrdered,
    logLine: buildLogLine(
      includedOrdered.map((s) => costByName.get(s.name)!),
      deferredOrdered.map((s) => costByName.get(s.name)!),
      budget
    ),
    warnings
  };
}
