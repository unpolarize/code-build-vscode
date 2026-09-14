/**
 * Selective x.ai ACP extension bridges (v1): compact, rewind, git/worktree.
 *
 * Grok Build's initialize does not always list methods — it stamps
 * `_meta.grokShell: true` and still implements `x.ai/compact_conversation`,
 * `x.ai/rewind/*`, and `x.ai/git/info`. Other ACP agents (Claude/Codex via
 * their own transports, or a mock that omits these) must not see chips or
 * native compact. Capability-gated only; unknown method → one-line notice,
 * never a thrown error.
 *
 * Extension methods are host → agent requests (JsonRpcEndpoint.request).
 * Do not widen the inbound onRequest switch.
 */

export const XAI_COMPACT = 'x.ai/compact_conversation';
export const XAI_REWIND_EXECUTE = 'x.ai/rewind/execute';
export const XAI_REWIND_POINTS = 'x.ai/rewind/points';
export const XAI_GIT_INFO = 'x.ai/git/info';
export const XAI_GIT_STATUS = 'x.ai/git/status';

export type CompactRoute = 'native' | 'fallback';

export interface XaiExtensionCaps {
  compact: boolean;
  rewind: boolean;
  gitInfo: boolean;
}

export const EMPTY_XAI_CAPS: XaiExtensionCaps = {
  compact: false,
  rewind: false,
  gitInfo: false
};

export type XaiExtCallResult =
  | { ok: true; result?: unknown }
  | { ok: false; notice: string };

/** Loose initialize payload — never throws on garbage. */
export interface XaiInitializeFields {
  methods?: unknown;
  capabilities?: unknown;
  agentCapabilities?: {
    methods?: unknown;
    sessionCapabilities?: Record<string, unknown>;
    _meta?: unknown;
    [k: string]: unknown;
  };
  _meta?: {
    grokShell?: unknown;
    cancelRewind?: unknown;
    availableCommands?: unknown;
    [k: string]: unknown;
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pushMethods(into: Set<string>, v: unknown): void {
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === 'string' && x.length > 0) into.add(x.toLowerCase());
    }
    return;
  }
  const rec = asRecord(v);
  if (!rec) return;
  for (const [k, val] of Object.entries(rec)) {
    if (val === false || val === 0 || val === 'false') continue;
    if (typeof k === 'string' && k.length > 0) into.add(k.toLowerCase());
  }
}

function collectMethods(init: XaiInitializeFields): Set<string> {
  const out = new Set<string>();
  pushMethods(out, init.methods);
  const caps = asRecord(init.capabilities);
  if (caps) pushMethods(out, caps.methods);
  const agent = init.agentCapabilities;
  if (agent) {
    pushMethods(out, agent.methods);
    pushMethods(out, agent._meta);
    const sessionCaps = asRecord(agent.sessionCapabilities);
    if (sessionCaps) {
      if (sessionCaps.compact) out.add(XAI_COMPACT);
      if (sessionCaps.rewind) out.add(XAI_REWIND_EXECUTE);
    }
  }
  const meta = init._meta;
  if (meta) {
    pushMethods(out, meta);
    const cmds = meta.availableCommands;
    if (Array.isArray(cmds)) {
      for (const c of cmds) {
        const name =
          typeof c === 'string'
            ? c
            : asRecord(c)?.name;
        if (typeof name === 'string' && name.toLowerCase() === 'compact') {
          out.add(XAI_COMPACT);
        }
        if (typeof name === 'string' && name.toLowerCase() === 'rewind') {
          out.add(XAI_REWIND_EXECUTE);
        }
      }
    }
  }
  return out;
}

function methodMatch(methods: Set<string>, ...needles: string[]): boolean {
  for (const n of needles) {
    const low = n.toLowerCase();
    if (methods.has(low)) return true;
    for (const m of methods) {
      if (m === low || m.startsWith(low + '/') || low.startsWith(m + '/')) return true;
    }
  }
  return false;
}

/**
 * Parse advertised x.ai v1 bridges from an ACP initialize result.
 * Missing/garbage → all false (generic /compact fallback; no chips).
 */
export function parseXaiExtensionCaps(
  agentInitialize: unknown
): XaiExtensionCaps {
  if (!agentInitialize || typeof agentInitialize !== 'object') {
    return { ...EMPTY_XAI_CAPS };
  }
  const init = agentInitialize as XaiInitializeFields;
  const methods = collectMethods(init);
  const grokShell = init._meta?.grokShell === true;

  return {
    compact:
      grokShell ||
      methodMatch(methods, XAI_COMPACT, 'compact_conversation', 'x.ai/compact'),
    rewind:
      grokShell ||
      init._meta?.cancelRewind === true ||
      methodMatch(methods, XAI_REWIND_EXECUTE, XAI_REWIND_POINTS, 'x.ai/rewind'),
    gitInfo:
      grokShell ||
      methodMatch(methods, XAI_GIT_INFO, XAI_GIT_STATUS, 'x.ai/git')
  };
}

export function decideCompactRoute(caps: XaiExtensionCaps | null | undefined): CompactRoute {
  return caps?.compact === true ? 'native' : 'fallback';
}

export function unsupportedNotice(method: string): string {
  return `${method} is not advertised by this agent — no-op.`;
}

export function compactConversationParams(
  sessionId: string,
  focus?: string
): { sessionId: string; userContext?: string } {
  const params: { sessionId: string; userContext?: string } = { sessionId };
  const ctx = focus?.trim();
  if (ctx) params.userContext = ctx;
  return params;
}

export function rewindExecuteParams(
  sessionId: string,
  targetPromptIndex: number,
  force = false
): { sessionId: string; targetPromptIndex: number; force: boolean } {
  return { sessionId, targetPromptIndex, force };
}

export function gitInfoParams(sessionId?: string): { sessionId?: string } {
  return sessionId ? { sessionId } : {};
}

export interface GitBranchBadge {
  branch: string;
  label: string;
  root?: string;
}

function pickString(rec: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function unwrapGitPayload(raw: unknown): Record<string, unknown> | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const inner = rec.result ?? rec.data ?? rec.info;
  const nested = asRecord(inner);
  return nested ?? rec;
}

/** Read-only branch badge from `x.ai/git/info` (or git/status) payload. */
export function parseGitInfoBadge(raw: unknown): GitBranchBadge | null {
  const rec = unwrapGitPayload(raw);
  if (!rec) return null;
  const root = pickString(rec, 'root', 'repoRoot', 'repo_root', 'gitRoot');
  const detached = rec.currentBranch === null || rec.current_branch === null;
  const branch = pickString(rec, 'currentBranch', 'current_branch', 'branch', 'head');
  if (!branch) {
    if (!detached) return null;
    return { branch: 'HEAD', label: 'git HEAD (detached)', ...(root ? { root } : {}) };
  }
  const label =
    detached && (branch === 'HEAD' || /^[0-9a-f]{7,40}$/i.test(branch))
      ? `git HEAD (detached)`
      : `git ${branch}`;
  return { branch, label, ...(root ? { root } : {}) };
}

/** Map a painted (possibly tailed) user-turn index onto the full JSONL. */
export function resolveRewindUserTurnIndex(opts: {
  fullUserCount: number;
  paintedUserCount: number;
  paintedIndex: number;
}): number | null {
  const { fullUserCount, paintedUserCount, paintedIndex } = opts;
  if (!Number.isInteger(paintedIndex) || paintedIndex < 0) return null;
  if (!Number.isInteger(paintedUserCount) || paintedUserCount < 1) return null;
  if (paintedIndex >= paintedUserCount) return null;
  if (!Number.isInteger(fullUserCount) || fullUserCount < paintedUserCount) return null;
  const full = fullUserCount - paintedUserCount + paintedIndex;
  if (full < 0 || full >= fullUserCount) return null;
  return full;
}

export type RewindPlan<T> =
  | { action: 'noop'; notice: string }
  | { action: 'execute'; truncated: T[]; userTurnIndex: number };

/**
 * Capability-gated rewind plan. Missing cap / bad index → no-op notice,
 * never an exception. Caller still confirms before the RPC.
 */
export function planRewindTranscript<T extends { type: string }>(
  records: T[],
  userTurnIndex: number,
  caps: XaiExtensionCaps | null | undefined
): RewindPlan<T> {
  if (caps?.rewind !== true) {
    return { action: 'noop', notice: unsupportedNotice(XAI_REWIND_EXECUTE) };
  }
  if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
    return { action: 'noop', notice: 'Invalid rewind turn — no-op.' };
  }
  const truncated = truncateRecordsToUserTurn(records, userTurnIndex);
  if (truncated === records) {
    return { action: 'noop', notice: 'No matching user turn to rewind to — no-op.' };
  }
  return { action: 'execute', truncated, userTurnIndex };
}

/**
 * Truncate host transcript records to the chosen user turn (0-based).
 * Keeps the target user row and everything before it; drops later turns.
 * Invalid / missing index → original array (no-op).
 */
export function truncateRecordsToUserTurn<T extends { type: string }>(
  records: T[],
  userTurnIndex: number
): T[] {
  if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) return records;
  let seen = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i].type === 'user') {
      seen += 1;
      if (seen === userTurnIndex) return records.slice(0, i + 1);
    }
  }
  return records;
}

export function nativeCompactSummaryPreview(focus?: string): string {
  const base = 'Native x.ai/compact_conversation (agent compacted in place; no host respawn).';
  const ctx = focus?.trim();
  return ctx ? `${base} Focus: ${ctx}` : base;
}
