/**
 * Teammate-context compact proxy (v1) — host-side detect/decide for Agent
 * Team / ACP Agent-tool children approaching their context limit.
 *
 * Claude Code Agent Teams leave member agents without auto-compaction
 * (anthropics/claude-code#49786): members fill windows, go unresponsive,
 * and the lead cannot trim them. This module is the host-side contract:
 * threshold detect → summarize primer OR vendor compact OR park + KP
 * handoff cartridge of last N tool results. Chip surfaces compacted N /
 * failed M per lead session.
 *
 * Pure / vscode-free — SessionManager feeds child snapshots (from Agent-
 * tool titles, teammate-status context_pct attributes, or explicit
 * upserts). Never silently wipes history: every action keeps a recoverable
 * summary / cartridge artifact.
 */

export const DEFAULT_TEAMMATE_COMPACT_THRESHOLD_PCT = 75;
export const DEFAULT_TEAMMATE_COMPACT_CRITICAL_PCT = 90;
export const DEFAULT_TEAMMATE_HANDOFF_LAST_N = 8;

export const TEAMMATE_COMPACT_HINT =
  'Teammate/subagent context near limit (Claude #49786 class). Host can ' +
  'summarize-compact the child, call vendor compact when advertised, or ' +
  'park the child and emit a KP handoff cartridge of recent tool results.';

export type TeammateChildRole = 'teammate' | 'subagent' | 'agent_tool' | 'unknown';

/** Recommended host action for one child. */
export type TeammateCompactAction =
  | 'none'
  | 'summarize'
  | 'vendor_compact'
  | 'park_handoff';

export type TeammateChildStatus = 'ok' | 'approaching' | 'critical';

export type TeammateCompactOutcome = 'compacted' | 'failed' | 'parked';

export interface TeammateChildSnapshot {
  /** Stable id (toolCallId, teammate agent name, or CB session id). */
  id: string;
  /** Short display label for chip / QuickPick. */
  label: string;
  role: TeammateChildRole;
  /** Tokens currently filling the child's context window. */
  usedTokens: number;
  /** Child context window size (tokens). */
  windowTokens: number;
  /** True when the child backend advertised session/compact or /compact. */
  vendorCompactAvailable?: boolean;
  /** Recent tool-result payloads for park-handoff fallback (oldest first). */
  lastToolResults?: Array<{ title?: string; text: string }>;
  backend?: string;
}

export interface TeammateCompactConfig {
  /**
   * off — disable chip + actions.
   * warn — chip + manual host action (default).
   * auto — same detect; callers may auto-fire summarize when approaching.
   */
  mode: 'off' | 'warn' | 'auto';
  /** Context fill % that triggers approaching / summarize. Default 75. */
  thresholdPct: number;
  /** Fill % that prefers park_handoff over summarize. Default 90. */
  criticalPct: number;
  /** Last-N tool results kept in a park-handoff cartridge. Default 8. */
  lastNToolResults: number;
}

export const DEFAULT_TEAMMATE_COMPACT_CONFIG: TeammateCompactConfig = {
  mode: 'warn',
  thresholdPct: DEFAULT_TEAMMATE_COMPACT_THRESHOLD_PCT,
  criticalPct: DEFAULT_TEAMMATE_COMPACT_CRITICAL_PCT,
  lastNToolResults: DEFAULT_TEAMMATE_HANDOFF_LAST_N
};

export interface TeammateChildEvaluation {
  child: TeammateChildSnapshot;
  /** used/window * 100; null when window unknown/zero. */
  fillPct: number | null;
  status: TeammateChildStatus;
  action: TeammateCompactAction;
  reason: string;
}

export interface TeammateCompactChip {
  /** Children currently registered on the lead. */
  childCount: number;
  approachingCount: number;
  criticalCount: number;
  compactedCount: number;
  failedCount: number;
  parkedCount: number;
  /** Short chip label, e.g. `team near 2 · compact 1`. */
  label: string;
  warn: boolean;
  hint?: string;
}

/** used/window * 100, capped at 999 for absurd overfill; null if unknown. */
export function contextFillPct(
  usedTokens: number,
  windowTokens: number
): number | null {
  if (
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(windowTokens) ||
    windowTokens <= 0 ||
    usedTokens < 0
  ) {
    return null;
  }
  return Math.min(999, (usedTokens / windowTokens) * 100);
}

/**
 * Decide status + host action for one child. mode 'off' always returns
 * ok/none. Prefer vendor_compact when available and past threshold;
 * summarize when approaching; park_handoff when critical (or summarize
 * unavailable because window unknown but usedTokens already huge — still
 * none until we know fill %).
 */
export function evaluateTeammateChild(
  child: TeammateChildSnapshot,
  cfg: TeammateCompactConfig = DEFAULT_TEAMMATE_COMPACT_CONFIG
): TeammateChildEvaluation {
  const fillPct = contextFillPct(child.usedTokens, child.windowTokens);
  if (cfg.mode === 'off') {
    return {
      child,
      fillPct,
      status: 'ok',
      action: 'none',
      reason: 'teammate-compact mode off'
    };
  }
  if (fillPct == null) {
    return {
      child,
      fillPct,
      status: 'ok',
      action: 'none',
      reason: 'context window unknown — cannot compute fill %'
    };
  }

  const threshold =
    cfg.thresholdPct > 0 ? cfg.thresholdPct : DEFAULT_TEAMMATE_COMPACT_THRESHOLD_PCT;
  const critical =
    cfg.criticalPct > 0 ? cfg.criticalPct : DEFAULT_TEAMMATE_COMPACT_CRITICAL_PCT;

  if (fillPct >= critical) {
    return {
      child,
      fillPct,
      status: 'critical',
      action: 'park_handoff',
      reason: `fill ${fmtPct(fillPct)}% ≥ critical ${critical}% — park child + handoff cartridge`
    };
  }
  if (fillPct >= threshold) {
    const action: TeammateCompactAction = child.vendorCompactAvailable
      ? 'vendor_compact'
      : 'summarize';
    return {
      child,
      fillPct,
      status: 'approaching',
      action,
      reason: child.vendorCompactAvailable
        ? `fill ${fmtPct(fillPct)}% ≥ ${threshold}% — vendor compact available`
        : `fill ${fmtPct(fillPct)}% ≥ ${threshold}% — inject summarize primer`
    };
  }
  return {
    child,
    fillPct,
    status: 'ok',
    action: 'none',
    reason: `fill ${fmtPct(fillPct)}% below threshold ${threshold}%`
  };
}

function fmtPct(n: number): string {
  if (n < 10) {
    const one = n.toFixed(1);
    return one.endsWith('.0') ? one.slice(0, -2) : one;
  }
  return String(Math.round(n));
}

/** Agent-tool / Task / Teammate title → role, or null when not a child spawn. */
export function classifyTeammateToolTitle(
  title: string | null | undefined
): TeammateChildRole | null {
  if (!title) return null;
  const t = title.trim();
  if (!t) return null;
  if (/^teammate\b/i.test(t)) return 'teammate';
  if (/^(agent\s*team|agent-team)\b/i.test(t)) return 'teammate';
  if (/^agent\b/i.test(t)) return 'agent_tool';
  if (/^task\b/i.test(t)) return 'subagent';
  if (/^subagent\b/i.test(t)) return 'subagent';
  return null;
}

/**
 * Stable child id from a tool call. Prefer explicit agent/teammate name in
 * the title (`Agent "researcher"`, `Teammate builder: …`); else toolCallId.
 */
export function resolveTeammateChildId(args: {
  toolCallId: string;
  title?: string | null;
  rawInput?: unknown;
}): string {
  const fromTitle = extractNamedAgent(args.title);
  if (fromTitle) return `tm:${fromTitle}`;
  const fromInput = extractNamedAgentFromInput(args.rawInput);
  if (fromInput) return `tm:${fromInput}`;
  return `tc:${args.toolCallId}`;
}

function extractNamedAgent(title: string | null | undefined): string | null {
  if (!title) return null;
  const quoted = title.match(
    /\b(?:agent|teammate|subagent|task)\b[^"]*"([^"]{1,64})"/i
  );
  if (quoted?.[1]) return slugId(quoted[1]);
  const bare = title.match(
    /\b(?:agent|teammate|subagent)\s+([a-zA-Z][\w.-]{0,63})\b/i
  );
  if (bare?.[1] && !/^(team|tool|call)$/i.test(bare[1])) return slugId(bare[1]);
  return null;
}

function extractNamedAgentFromInput(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  for (const key of ['name', 'agent', 'teammate', 'subagent_type', 'description']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) {
      // description is often a sentence — only accept short identifiers
      if (key === 'description' && (v.length > 48 || /\s/.test(v.trim()))) continue;
      return slugId(v.trim());
    }
  }
  return null;
}

function slugId(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Parse fill % from teammate-status / idle-notice shaped text.
 * Accepts `context_pct="82"`, `context="82%"`, `context 82%`.
 */
export function parseTeammateContextPct(
  text: string | null | undefined
): { agentId?: string; fillPct: number } | null {
  if (!text || typeof text !== 'string') return null;
  const attr =
    text.match(/\bcontext_(?:pct|percent|fill)\s*=\s*["']?(\d{1,3}(?:\.\d+)?)["']?/i) ||
    text.match(/\bcontext\s*=\s*["']?(\d{1,3}(?:\.\d+)?)%?["']?/i);
  const phrase = text.match(/\bcontext(?:\s+fill)?\s+(\d{1,3}(?:\.\d+)?)%/i);
  const raw = attr?.[1] ?? phrase?.[1];
  if (raw == null) return null;
  const fillPct = Number(raw);
  if (!Number.isFinite(fillPct) || fillPct < 0) return null;
  const agent =
    text.match(/\b(?:agent|teammate|name)\s*=\s*["']([^"']{1,64})["']/i)?.[1] ||
    text.match(/<teammate[-_]?(?:idle|status)[^>]*\bagent\s*=\s*["']([^"']+)["']/i)?.[1];
  return {
    fillPct: Math.min(999, fillPct),
    ...(agent ? { agentId: slugId(agent) } : {})
  };
}

/** Short label for chip / QuickPick from title or id. */
export function teammateChildLabel(args: {
  id: string;
  title?: string | null;
  role: TeammateChildRole;
}): string {
  const named = extractNamedAgent(args.title);
  if (named) return named;
  if (args.title && args.title.trim()) {
    const t = args.title.trim();
    return t.length > 40 ? `${t.slice(0, 37)}…` : t;
  }
  if (args.id.startsWith('tm:')) return args.id.slice(3);
  return args.role === 'unknown' ? args.id : `${args.role}:${args.id.slice(0, 12)}`;
}

/**
 * Summarize primer injected into (or staged for) a child session. Same
 * spirit as host /compact primer but scoped to ONE teammate — recoverable
 * artifact, never a silent wipe.
 */
export function buildTeammateSummarizePrimer(args: {
  child: TeammateChildSnapshot;
  summary: string;
  focus?: string;
  leadSessionId?: string;
}): string {
  const focusLine = args.focus
    ? `\nThe lead asked this compaction to focus on: ${args.focus}`
    : '';
  const leadLine = args.leadSessionId
    ? `\nLead CB session: ${args.leadSessionId}`
    : '';
  const fill = contextFillPct(args.child.usedTokens, args.child.windowTokens);
  const fillLine =
    fill != null
      ? `\nPre-compact fill: ${fmtPct(fill)}% (${args.child.usedTokens}/${args.child.windowTokens} tok)`
      : '';
  return `<teammate-compact-context child="${escapeAttr(args.child.label)}" role="${args.child.role}" source="host-proxy">
This is YOUR OWN teammate/subagent conversation, compacted by the Code Build host because member agents lack vendor auto-compaction (Claude #49786 class). Below is a SUMMARY of your work so far.${focusLine}${leadLine}${fillLine}

Use this context to continue. Do NOT reply to this block directly — wait for the next lead instruction.

== SUMMARY ==
${args.summary.trim()}
</teammate-compact-context>`;
}

/**
 * Park-handoff cartridge: last N tool results as markdown the lead (or KP)
 * can resume from after the child is parked. Always recoverable.
 */
export function buildTeammateParkHandoffCartridge(args: {
  child: TeammateChildSnapshot;
  lastN?: number;
  leadSessionId?: string;
  now?: number;
}): { markdown: string; preview: string; resultCount: number } {
  const n = Math.max(0, args.lastN ?? DEFAULT_TEAMMATE_HANDOFF_LAST_N);
  const results = (args.child.lastToolResults ?? []).slice(-n);
  const fill = contextFillPct(args.child.usedTokens, args.child.windowTokens);
  const ts = args.now ?? Date.now();
  const lines: string[] = [
    `# Teammate park handoff — ${args.child.label}`,
    '',
    `- child_id: \`${args.child.id}\``,
    `- role: ${args.child.role}`,
    `- backend: ${args.child.backend ?? 'unknown'}`,
    `- fill: ${fill != null ? `${fmtPct(fill)}%` : 'n/a'} (${args.child.usedTokens}/${args.child.windowTokens || '?'} tok)`,
    `- parked_at: ${new Date(ts).toISOString()}`,
    ...(args.leadSessionId ? [`- lead_session: \`${args.leadSessionId}\``] : []),
    '',
    'Child parked by Code Build teammate-compact proxy (Claude #49786 class).',
    'Recent tool results below are the recoverable cartridge — not a silent wipe.',
    '',
    `## Last ${results.length} tool result(s)`,
    ''
  ];
  if (results.length === 0) {
    lines.push('_No tool results captured for this child._', '');
  } else {
    results.forEach((r, i) => {
      const title = (r.title ?? `result ${i + 1}`).trim() || `result ${i + 1}`;
      lines.push(`### ${i + 1}. ${title}`, '', clampText(r.text, 4_000), '');
    });
  }
  const markdown = lines.join('\n');
  return {
    markdown,
    preview: markdown.slice(0, 200),
    resultCount: results.length
  };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function clampText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Aggregate chip from evaluations + cumulative outcomes. */
export function evaluateTeammateCompactChip(args: {
  evaluations: TeammateChildEvaluation[];
  compactedCount: number;
  failedCount: number;
  parkedCount: number;
}): TeammateCompactChip | null {
  const childCount = args.evaluations.length;
  if (
    childCount === 0 &&
    args.compactedCount === 0 &&
    args.failedCount === 0 &&
    args.parkedCount === 0
  ) {
    return null;
  }
  const approachingCount = args.evaluations.filter((e) => e.status === 'approaching').length;
  const criticalCount = args.evaluations.filter((e) => e.status === 'critical').length;
  const parts: string[] = [];
  if (approachingCount + criticalCount > 0) {
    parts.push(`near ${approachingCount + criticalCount}`);
  } else if (childCount > 0) {
    parts.push(`${childCount} child${childCount === 1 ? '' : 'ren'}`);
  }
  if (args.compactedCount > 0) parts.push(`compact ${args.compactedCount}`);
  if (args.parkedCount > 0) parts.push(`park ${args.parkedCount}`);
  if (args.failedCount > 0) parts.push(`fail ${args.failedCount}`);
  const label = parts.length > 0 ? `team ${parts.join(' · ')}` : 'team';
  const warn =
    approachingCount + criticalCount > 0 || args.failedCount > 0;
  return {
    childCount,
    approachingCount,
    criticalCount,
    compactedCount: args.compactedCount,
    failedCount: args.failedCount,
    parkedCount: args.parkedCount,
    label,
    warn,
    ...(warn ? { hint: TEAMMATE_COMPACT_HINT } : {})
  };
}

/**
 * Per-lead-session registry. Pure / timer-free — host upserts children when
 * Agent-tool calls start or teammate-status reports context_pct.
 */
export class TeammateCompactProxyTracker {
  private children = new Map<string, TeammateChildSnapshot>();
  private compactedCount = 0;
  private failedCount = 0;
  private parkedCount = 0;
  private warnedIds = new Set<string>();

  upsertChild(snap: TeammateChildSnapshot): void {
    const prev = this.children.get(snap.id);
    const merged: TeammateChildSnapshot = {
      ...(prev ?? snap),
      ...snap,
      lastToolResults:
        snap.lastToolResults ?? prev?.lastToolResults ?? undefined
    };
    // Cap stored tool results so a long-running child cannot unbounded-grow.
    if (merged.lastToolResults && merged.lastToolResults.length > 24) {
      merged.lastToolResults = merged.lastToolResults.slice(-24);
    }
    this.children.set(snap.id, merged);
  }

  /** Append one tool-result snippet onto a child (creates a stub if missing). */
  noteToolResult(
    id: string,
    result: { title?: string; text: string },
    stub?: Partial<TeammateChildSnapshot>
  ): void {
    const prev = this.children.get(id);
    const base: TeammateChildSnapshot = prev ?? {
      id,
      label: stub?.label ?? id,
      role: stub?.role ?? 'unknown',
      usedTokens: stub?.usedTokens ?? 0,
      windowTokens: stub?.windowTokens ?? 0,
      ...stub
    };
    const last = [...(base.lastToolResults ?? []), result].slice(-24);
    this.children.set(id, { ...base, lastToolResults: last });
  }

  /**
   * Apply a reported fill % onto a child (from teammate-status text).
   * Derives usedTokens = fillPct/100 * windowTokens when window known.
   */
  noteFillPct(
    id: string,
    fillPct: number,
    stub?: Partial<TeammateChildSnapshot>
  ): void {
    const prev = this.children.get(id);
    const windowTokens =
      stub?.windowTokens ?? prev?.windowTokens ?? 200_000;
    const usedTokens = Math.round((Math.min(999, Math.max(0, fillPct)) / 100) * windowTokens);
    this.upsertChild({
      id,
      label: stub?.label ?? prev?.label ?? id,
      role: stub?.role ?? prev?.role ?? 'teammate',
      usedTokens,
      windowTokens,
      vendorCompactAvailable:
        stub?.vendorCompactAvailable ?? prev?.vendorCompactAvailable,
      backend: stub?.backend ?? prev?.backend,
      lastToolResults: prev?.lastToolResults
    });
  }

  removeChild(id: string): void {
    this.children.delete(id);
    this.warnedIds.delete(id);
  }

  clear(): void {
    this.children.clear();
    this.warnedIds.clear();
    this.compactedCount = 0;
    this.failedCount = 0;
    this.parkedCount = 0;
  }

  listChildren(): TeammateChildSnapshot[] {
    return [...this.children.values()];
  }

  getChild(id: string): TeammateChildSnapshot | undefined {
    return this.children.get(id);
  }

  recordOutcome(outcome: TeammateCompactOutcome): void {
    if (outcome === 'compacted') this.compactedCount += 1;
    else if (outcome === 'failed') this.failedCount += 1;
    else this.parkedCount += 1;
  }

  evaluateAll(
    cfg: TeammateCompactConfig = DEFAULT_TEAMMATE_COMPACT_CONFIG
  ): TeammateChildEvaluation[] {
    return this.listChildren().map((c) => evaluateTeammateChild(c, cfg));
  }

  chip(
    cfg: TeammateCompactConfig = DEFAULT_TEAMMATE_COMPACT_CONFIG
  ): TeammateCompactChip | null {
    if (cfg.mode === 'off') return null;
    return evaluateTeammateCompactChip({
      evaluations: this.evaluateAll(cfg),
      compactedCount: this.compactedCount,
      failedCount: this.failedCount,
      parkedCount: this.parkedCount
    });
  }

  /**
   * Children that newly crossed the approaching/critical line (fire-once
   * per child id until cleared). Used for one-shot lead notices.
   */
  newlyWarned(
    cfg: TeammateCompactConfig = DEFAULT_TEAMMATE_COMPACT_CONFIG
  ): TeammateChildEvaluation[] {
    if (cfg.mode === 'off') return [];
    const out: TeammateChildEvaluation[] = [];
    for (const ev of this.evaluateAll(cfg)) {
      if (ev.status === 'ok') continue;
      if (this.warnedIds.has(ev.child.id)) continue;
      this.warnedIds.add(ev.child.id);
      out.push(ev);
    }
    return out;
  }

  getOutcomeCounts(): {
    compacted: number;
    failed: number;
    parked: number;
  } {
    return {
      compacted: this.compactedCount,
      failed: this.failedCount,
      parked: this.parkedCount
    };
  }
}

/** Default window guess by backend/model family — shared with idle-notice tax. */
export function guessContextWindowTokens(
  modelOrBackend?: string | null
): number {
  const m = modelOrBackend ?? '';
  if (/claude|opus|sonnet|haiku/i.test(m)) return 200_000;
  if (/grok|gpt-5|o3|o4|codex|gpt-4|o1/i.test(m)) return 128_000;
  return 200_000;
}
