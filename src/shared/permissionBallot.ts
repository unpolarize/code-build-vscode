/**
 * Concurrent-session permission ballot
 * (kp: ideas/cb-concurrent-session-permission-ballot-majority)
 *
 * Group pending ACP permission prompts by a backend-agnostic fingerprint
 * `(method, path|command_norm)` so Claude+Codex+Grok asking the same Write
 * or Bash collapse to one ballot: Approve-all / Deny-any /
 * Approve-this-backend-only.
 *
 * Single-user host only. High-risk classes (force-push, rm -rf, secrets
 * paths) never auto-approve — Deny-any still applies. No network;
 * fingerprinting is local string normalize.
 *
 * Pure / vscode-free.
 */

import type { PermissionOutcome, ToolCall } from './acpTypes';

export type BallotMethod = 'write' | 'execute' | 'read' | 'other';

export type BallotAction = 'approve-all' | 'deny-any' | 'approve-this-backend';

export type HighRiskClass = 'force-push' | 'rm-rf' | 'secrets-path';

export const BALLOT_AUTO_DENY_MS = 30_000;
/** Optional 30s auto-deny is off by default (Acceptance). */
export const BALLOT_AUTO_DENY_DEFAULT = false;

export interface BallotOption {
  optionId: string;
  name?: string;
  kind: string;
}

export interface BallotPending {
  requestId: string;
  sessionId: string;
  backend: string;
  tool: ToolCall;
  options: BallotOption[];
}

export interface PermissionFingerprint {
  method: BallotMethod;
  /** Normalized path or command. Empty when unknown. */
  target: string;
  /** `${method}|${target}` — backend-agnostic. Unique per request when target is empty. */
  key: string;
}

export interface BallotGroup {
  fingerprint: PermissionFingerprint;
  highRisk: HighRiskClass | null;
  members: BallotPending[];
}

export interface BallotDecision {
  requestId: string;
  sessionId: string;
  backend: string;
  /** When false, leave the prompt pending (high-risk approve, missing allow). */
  apply: boolean;
  outcome?: PermissionOutcome;
  skipped?: 'high-risk' | 'no-allow-option';
}

export interface PermissionBallotInfo {
  key: string;
  method: BallotMethod;
  target: string;
  count: number;
  backends: string[];
  highRisk: HighRiskClass | null;
  localIds: string[];
}

const WRITE_KINDS = new Set(['write', 'edit', 'create']);
const EXECUTE_KINDS = new Set(['execute']);
const READ_KINDS = new Set(['read', 'search']);

const WRITE_TITLES = new Set([
  'write',
  'edit',
  'notebookedit',
  'create',
  'strreplace',
  'applypatch'
]);
const EXECUTE_TITLES = new Set(['bash', 'shell', 'run_terminal_command', 'execute_bash']);
const READ_TITLES = new Set(['read', 'grep', 'glob', 'search', 'websearch']);

const SECRETS_PATH_RE = [
  /(?:^|\/)\.env(?:$|\.)/i,
  /(?:^|\/)id_rsa$/i,
  /(?:^|\/)id_ed25519$/i,
  /\.pem$/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)credentials(?:$|\.)/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)secrets?\.(json|ya?ml)$/i,
  /(?:^|\/)\.aws\/credentials$/i
];

export function normalizePath(raw: string): string {
  let s = raw.trim();
  if (s.toLowerCase().startsWith('file://')) {
    s = s.slice(7);
    if (s.toLowerCase().startsWith('localhost')) s = s.slice('localhost'.length);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep raw slice */
    }
  }
  s = s.replace(/\\/g, '/');
  const abs = s.startsWith('/');
  const out: string[] = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  if (abs) return joined ? `/${joined}` : '/';
  return joined;
}

export function normalizeCommand(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function ballotMethodOf(tool: ToolCall): BallotMethod {
  const kind = (tool.kind ?? '').toLowerCase();
  if (WRITE_KINDS.has(kind)) return 'write';
  if (EXECUTE_KINDS.has(kind)) return 'execute';
  if (READ_KINDS.has(kind)) return 'read';
  const title = tool.title.trim().toLowerCase();
  if (WRITE_TITLES.has(title)) return 'write';
  if (EXECUTE_TITLES.has(title)) return 'execute';
  if (READ_TITLES.has(title)) return 'read';
  return 'other';
}

function stringField(raw: unknown, keys: string[]): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

export function extractBallotPath(tool: ToolCall): string | null {
  const loc = tool.locations?.[0]?.path;
  if (typeof loc === 'string' && loc.trim()) return loc;
  const fromRaw = stringField(tool.rawInput, ['path', 'file_path', 'filePath', 'target_file', 'file']);
  if (fromRaw) return fromRaw;
  const diff = (tool.content ?? []).find((b) => b.type === 'diff');
  if (diff && diff.type === 'diff' && diff.path.trim()) return diff.path;
  return null;
}

export function extractBallotCommand(tool: ToolCall): string | null {
  return stringField(tool.rawInput, ['command', 'cmd', 'script']);
}

export function fingerprintToolCall(tool: ToolCall): PermissionFingerprint {
  const method = ballotMethodOf(tool);
  let target = '';
  if (method === 'execute') {
    const cmd = extractBallotCommand(tool);
    if (cmd) target = normalizeCommand(cmd);
  } else {
    const p = extractBallotPath(tool);
    if (p) target = normalizePath(p);
    else if (method === 'other') {
      const cmd = extractBallotCommand(tool);
      if (cmd) target = normalizeCommand(cmd);
    }
  }
  const key = target ? `${method}|${target}` : `${method}|id:${tool.toolCallId}`;
  return { method, target, key };
}

export function classifyHighRisk(tool: ToolCall, fp?: PermissionFingerprint): HighRiskClass | null {
  const print = fp ?? fingerprintToolCall(tool);
  const cmdRaw = extractBallotCommand(tool) ?? (print.method === 'execute' ? print.target : '');
  const cmd = cmdRaw.toLowerCase();
  if (/\bgit\s+push\b/.test(cmd) && /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/.test(cmd)) {
    return 'force-push';
  }
  if (/\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*[rf][a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\b/.test(cmd)) {
    return 'rm-rf';
  }
  const probes = [
    print.method === 'execute' ? '' : print.target,
    extractBallotPath(tool) ?? '',
    cmd
  ];
  for (const probe of probes) {
    if (!probe) continue;
    for (const re of SECRETS_PATH_RE) {
      if (re.test(probe)) return 'secrets-path';
    }
  }
  return null;
}

export function pickAllowOutcome(options: BallotOption[]): PermissionOutcome | null {
  const opt =
    options.find((o) => o.kind === 'allow_always') ?? options.find((o) => o.kind === 'allow_once');
  return opt ? { outcome: 'selected', optionId: opt.optionId } : null;
}

export function pickDenyOutcome(options: BallotOption[]): PermissionOutcome {
  const opt =
    options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
  return opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
}

export function groupPendingBallots(pending: BallotPending[]): BallotGroup[] {
  const byKey = new Map<string, BallotPending[]>();
  const fpByKey = new Map<string, PermissionFingerprint>();
  for (const p of pending) {
    const fp = fingerprintToolCall(p.tool);
    fpByKey.set(fp.key, fp);
    const list = byKey.get(fp.key);
    if (list) list.push(p);
    else byKey.set(fp.key, [p]);
  }
  const groups: BallotGroup[] = [];
  for (const [key, members] of byKey) {
    const fingerprint = fpByKey.get(key)!;
    groups.push({
      fingerprint,
      highRisk: members.map((m) => classifyHighRisk(m.tool, fingerprint)).find((c) => c) ?? null,
      members
    });
  }
  return groups;
}

/**
 * Reduce a ballot action to per-member outcomes. High-risk members are
 * never auto-approved (approve-all / approve-this-backend skip them).
 * Deny-any still denies high-risk — deny is the safe action.
 */
export function reduceBallot(
  pending: BallotPending[],
  action: BallotAction,
  opts: { fingerprintKey: string; backend?: string }
): BallotDecision[] {
  const out: BallotDecision[] = [];
  for (const p of pending) {
    const fp = fingerprintToolCall(p.tool);
    if (fp.key !== opts.fingerprintKey) continue;
    if (action === 'approve-this-backend' && p.backend !== opts.backend) continue;

    const highRisk = classifyHighRisk(p.tool, fp);
    if (action !== 'deny-any' && highRisk) {
      out.push({
        requestId: p.requestId,
        sessionId: p.sessionId,
        backend: p.backend,
        apply: false,
        skipped: 'high-risk'
      });
      continue;
    }
    if (action === 'deny-any') {
      out.push({
        requestId: p.requestId,
        sessionId: p.sessionId,
        backend: p.backend,
        apply: true,
        outcome: pickDenyOutcome(p.options)
      });
      continue;
    }
    const allow = pickAllowOutcome(p.options);
    if (!allow) {
      out.push({
        requestId: p.requestId,
        sessionId: p.sessionId,
        backend: p.backend,
        apply: false,
        skipped: 'no-allow-option'
      });
      continue;
    }
    out.push({
      requestId: p.requestId,
      sessionId: p.sessionId,
      backend: p.backend,
      apply: true,
      outcome: allow
    });
  }
  return out;
}

export function isAutoDenyDue(
  enqueuedAt: number,
  now: number,
  enabled: boolean,
  ms = BALLOT_AUTO_DENY_MS
): boolean {
  if (!enabled) return false;
  return now - enqueuedAt >= ms;
}

export function formatBallotLog(input: {
  action: BallotAction;
  fingerprintKey: string;
  members: number;
  applied: number;
  skipped: number;
  highRisk: HighRiskClass | null;
}): string {
  return (
    `permission-ballot action=${input.action} key=${input.fingerprintKey}` +
    ` members=${input.members} applied=${input.applied} skipped=${input.skipped}` +
    ` highRisk=${input.highRisk ?? 'none'}`
  );
}

/** UI helper: ballot chrome for the head of a permission queue. */
export function ballotInfoForHead(
  queue: { requestId: string; tool: ToolCall }[],
  hostBallot?: { key: string; count: number; backends: string[]; highRisk: HighRiskClass | null } | null,
  sessionBackend?: string
): PermissionBallotInfo | null {
  const head = queue[0];
  if (!head) return null;
  const fp = fingerprintToolCall(head.tool);
  const localIds = queue.filter((p) => fingerprintToolCall(p.tool).key === fp.key).map((p) => p.requestId);
  const hostCount = hostBallot?.key === fp.key ? hostBallot.count : 0;
  const count = Math.max(localIds.length, hostCount);
  if (count <= 1) return null;
  const backends = new Set<string>();
  if (sessionBackend) backends.add(sessionBackend);
  if (hostBallot?.key === fp.key) for (const b of hostBallot.backends) backends.add(b);
  return {
    key: fp.key,
    method: fp.method,
    target: fp.target,
    count,
    backends: [...backends],
    highRisk: (hostBallot?.key === fp.key ? hostBallot.highRisk : null) ?? classifyHighRisk(head.tool, fp),
    localIds
  };
}

export interface BallotMember extends BallotPending {
  /** Resolve the underlying ACP request. Returns false if already settled. */
  resolve: (outcome: PermissionOutcome) => boolean;
  /** Drop this request from the member's webview queue. */
  notifyResolved?: (requestId: string) => void;
  /** Live sibling-count chip for this fingerprint (null when count <= 1). */
  notifyBallot?: (info: { key: string; count: number; backends: string[]; highRisk: HighRiskClass | null } | null) => void;
}

export interface BallotApplyResult {
  log: string;
  decisions: BallotDecision[];
  applied: BallotDecision[];
}

/**
 * Process-level registry so identical pending prompts across open sessions
 * (multiple CB panels) share one ballot.
 */
export class PermissionBallotHub {
  private pending = new Map<string, BallotMember>();

  get size(): number {
    return this.pending.size;
  }

  register(member: BallotMember): void {
    this.pending.set(member.requestId, member);
    this.emitBallot(fingerprintToolCall(member.tool).key);
  }

  unregister(requestId: string): void {
    const prev = this.pending.get(requestId);
    if (!prev) return;
    this.pending.delete(requestId);
    this.emitBallot(fingerprintToolCall(prev.tool).key);
  }

  unregisterSession(sessionId: string): void {
    const keys = new Set<string>();
    for (const [id, m] of this.pending) {
      if (m.sessionId !== sessionId) continue;
      keys.add(fingerprintToolCall(m.tool).key);
      this.pending.delete(id);
    }
    for (const key of keys) this.emitBallot(key);
  }

  apply(action: BallotAction, fingerprintKey: string, backend?: string): BallotApplyResult {
    const members = [...this.pending.values()];
    const decisions = reduceBallot(members, action, { fingerprintKey, backend });
    const applied: BallotDecision[] = [];
    for (const d of decisions) {
      if (!d.apply || !d.outcome) continue;
      const m = this.pending.get(d.requestId);
      if (!m) continue;
      const ok = m.resolve(d.outcome);
      this.pending.delete(d.requestId);
      if (ok) {
        applied.push(d);
        m.notifyResolved?.(d.requestId);
      }
    }
    const highRisk =
      groupPendingBallots(members).find((g) => g.fingerprint.key === fingerprintKey)?.highRisk ?? null;
    this.emitBallot(fingerprintKey);
    return {
      decisions,
      applied,
      log: formatBallotLog({
        action,
        fingerprintKey,
        members: decisions.length,
        applied: applied.length,
        skipped: decisions.filter((d) => !d.apply).length,
        highRisk
      })
    };
  }

  groups(): BallotGroup[] {
    return groupPendingBallots([...this.pending.values()]);
  }

  private emitBallot(fingerprintKey: string): void {
    const members = [...this.pending.values()].filter(
      (m) => fingerprintToolCall(m.tool).key === fingerprintKey
    );
    const group = groupPendingBallots(members).find((g) => g.fingerprint.key === fingerprintKey);
    const info =
      group && group.members.length > 1
        ? {
            key: group.fingerprint.key,
            count: group.members.length,
            backends: [...new Set(group.members.map((m) => m.backend))],
            highRisk: group.highRisk
          }
        : null;
    for (const m of members) m.notifyBallot?.(info);
  }
}

let defaultHub: PermissionBallotHub | undefined;

export function getPermissionBallotHub(): PermissionBallotHub {
  if (!defaultHub) defaultHub = new PermissionBallotHub();
  return defaultHub;
}

/** Test hook — never call from production paths. */
export function resetPermissionBallotHubForTests(): void {
  defaultHub = new PermissionBallotHub();
}
