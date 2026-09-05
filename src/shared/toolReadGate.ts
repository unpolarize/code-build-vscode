/**
 * Host-side big-file Read gate (kp: ideas/cb-big-file-read-hard-block-host-gate-warn-then).
 *
 * Pre-read size policy for ACP `fs/read_text_file` (and future Read/cat/head
 * permission paths). Suite already has post-read inject budgets; this blocks
 * the invoice *before* bytes enter the model context.
 *
 * Defaults: warn at 100 KiB, hard-block at 1 MiB. Night/unattended sessions
 * deny at the block threshold with no interactive grant (timeline event only).
 * Grant leases: allow-once (one subsequent read of that path) or allow-session
 * (all reads for the rest of the session).
 */

export const DEFAULT_TOOL_READ_MAX_BYTES_WARN = 100 * 1024; // 100 KiB
export const DEFAULT_TOOL_READ_MAX_BYTES_BLOCK = 1024 * 1024; // 1 MiB

export type ToolReadDecision = 'allow' | 'warn' | 'block';
export type ToolReadGrantKind = 'once' | 'session';

export interface ToolReadGateConfig {
  /** Soft threshold — read proceeds, warn event fires once per path. `<= 0` disables. */
  maxBytesWarn: number;
  /** Hard threshold — deny unless a grant covers the path. `<= 0` disables. */
  maxBytesBlock: number;
}

export const DEFAULT_TOOL_READ_GATE_CONFIG: ToolReadGateConfig = {
  maxBytesWarn: DEFAULT_TOOL_READ_MAX_BYTES_WARN,
  maxBytesBlock: DEFAULT_TOOL_READ_MAX_BYTES_BLOCK
};

export interface ToolReadEval {
  decision: ToolReadDecision;
  path: string;
  bytes: number;
  /** Present when a grant lease let a block-sized read through. */
  usedGrant?: ToolReadGrantKind;
}

export type ToolReadGateEventType = 'warn' | 'deny' | 'grant' | 'allow_after_grant';

export interface ToolReadGateEvent {
  type: ToolReadGateEventType;
  path: string;
  bytes: number;
  grant?: ToolReadGrantKind;
  message: string;
}

/** Format byte counts for notices (KiB/MiB, one decimal when helpful). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) {
    const kib = n / 1024;
    return `${kib >= 10 ? Math.round(kib) : kib.toFixed(1)} KiB`;
  }
  const mib = n / (1024 * 1024);
  return `${mib >= 10 ? Math.round(mib) : mib.toFixed(1)} MiB`;
}

/**
 * Pure threshold classifier (no grant state). Block wins over warn when both
 * thresholds are crossed. Disabled thresholds (`<= 0`) never fire.
 */
export function classifyReadSize(
  bytes: number,
  cfg: ToolReadGateConfig = DEFAULT_TOOL_READ_GATE_CONFIG
): ToolReadDecision {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (cfg.maxBytesBlock > 0 && size >= cfg.maxBytesBlock) return 'block';
  if (cfg.maxBytesWarn > 0 && size >= cfg.maxBytesWarn) return 'warn';
  return 'allow';
}

/**
 * Detect Read / cat / head style tool calls from title + rawInput.
 * Used to extend the gate beyond ACP fs/read (Claude Read, Bash cat/head).
 * Returns the candidate path when recognizable; null when not a read-ish tool.
 */
export function detectReadToolPath(
  title: string | undefined,
  rawInput?: unknown
): string | null {
  if (!title) return null;
  const t = title.trim();
  const input =
    rawInput && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>)
      : undefined;

  // Native Read / read_file / ReadFile tools — path in common fields.
  if (/^(read|read_file|readfile)$/i.test(t)) {
    const p = pickPathField(input);
    return p;
  }

  // Bash / Shell wrapping cat/head/less/wc -c on a file.
  if (/^(bash|shell|zsh|sh)$/i.test(t)) {
    const cmd = typeof input?.command === 'string' ? input.command : typeof input?.cmd === 'string' ? input.cmd : '';
    return parseBashReadPath(cmd);
  }

  // Title itself is "cat foo" / "head -n 20 bar" (some adapters).
  if (/^(cat|head|less|more)\b/i.test(t)) {
    return parseBashReadPath(t);
  }

  return null;
}

function pickPathField(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Best-effort extract of a file path from a simple `cat`/`head`/`less` command.
 * Skips pipes, redirects, and multi-command lines (too ambiguous for a gate).
 */
export function parseBashReadPath(cmd: string): string | null {
  const s = cmd.trim();
  if (!s) return null;
  // Reject compound commands — host should not guess which file is the invoice.
  if (/[|;&><]/.test(s) || /\n/.test(s)) return null;
  const m = s.match(
    /^(?:sudo\s+)?(cat|head|less|more|wc)\b(?:\s+-[a-zA-Z0-9]+|\s+-[ncl]\s+\d+)*\s+(\S+)\s*$/
  );
  if (!m) return null;
  const arg = m[2];
  // Flags mistaken as paths (e.g. `head -n`).
  if (arg.startsWith('-')) return null;
  return arg;
}

/**
 * Session-scoped gate. Pure aside from the optional event callback — callers
 * perform fs.stat and act on `allowRead` / `evaluate`.
 */
export class ToolReadGate {
  private cfg: ToolReadGateConfig;
  private sessionAllow = false;
  /** Paths with a single remaining allow-once lease. */
  private oncePaths = new Set<string>();
  /** Paths that already emitted a warn this session (avoid spam). */
  private warnedPaths = new Set<string>();
  private onEvent?: (e: ToolReadGateEvent) => void;

  constructor(
    cfg: ToolReadGateConfig = DEFAULT_TOOL_READ_GATE_CONFIG,
    onEvent?: (e: ToolReadGateEvent) => void
  ) {
    this.cfg = { ...cfg };
    this.onEvent = onEvent;
  }

  setConfig(cfg: ToolReadGateConfig): void {
    this.cfg = { ...cfg };
  }

  setOnEvent(onEvent?: (e: ToolReadGateEvent) => void): void {
    this.onEvent = onEvent;
  }

  getConfig(): ToolReadGateConfig {
    return { ...this.cfg };
  }

  /** One subsequent read of `path` may pass the block threshold. */
  grantOnce(path: string): void {
    const p = path.trim();
    if (!p) return;
    this.oncePaths.add(p);
    this.emit({
      type: 'grant',
      path: p,
      bytes: 0,
      grant: 'once',
      message: `Allow once granted for ${p}`
    });
  }

  /** All reads this session may pass the block threshold. */
  grantSession(): void {
    this.sessionAllow = true;
    this.emit({
      type: 'grant',
      path: '*',
      bytes: 0,
      grant: 'session',
      message: 'Allow session granted for oversized reads'
    });
  }

  /** Explicit deny is a no-op on leases (default posture is already deny). */
  deny(_path?: string): void {
    // Reserved for UI symmetry — denial is the default without a grant.
  }

  clearGrants(): void {
    this.sessionAllow = false;
    this.oncePaths.clear();
  }

  hasSessionAllow(): boolean {
    return this.sessionAllow;
  }

  hasOnceGrant(path: string): boolean {
    return this.oncePaths.has(path);
  }

  /**
   * Classify + apply grant consumption. Does not I/O.
   * - allow / warn → proceed (warn emits once per path)
   * - block without grant → deny
   * - block with session grant → proceed (grant not consumed)
   * - block with once grant → proceed and consume that path's lease
   */
  evaluate(path: string, bytes: number): ToolReadEval {
    const decision = classifyReadSize(bytes, this.cfg);
    if (decision !== 'block') {
      if (decision === 'warn' && !this.warnedPaths.has(path)) {
        this.warnedPaths.add(path);
        this.emit({
          type: 'warn',
          path,
          bytes,
          message: `Large read: ${formatBytes(bytes)} (${path}) — warn threshold ${formatBytes(this.cfg.maxBytesWarn)}`
        });
      }
      return { decision, path, bytes };
    }

    if (this.sessionAllow) {
      this.emit({
        type: 'allow_after_grant',
        path,
        bytes,
        grant: 'session',
        message: `Oversized read allowed (session grant): ${formatBytes(bytes)} (${path})`
      });
      return { decision: 'allow', path, bytes, usedGrant: 'session' };
    }

    if (this.oncePaths.has(path)) {
      this.oncePaths.delete(path);
      this.emit({
        type: 'allow_after_grant',
        path,
        bytes,
        grant: 'once',
        message: `Oversized read allowed once: ${formatBytes(bytes)} (${path})`
      });
      return { decision: 'allow', path, bytes, usedGrant: 'once' };
    }

    this.emit({
      type: 'deny',
      path,
      bytes,
      message:
        `Read blocked: ${path} is ${formatBytes(bytes)} ` +
        `(limit ${formatBytes(this.cfg.maxBytesBlock)}). ` +
        `Allow once / Allow session to proceed.`
    });
    return { decision: 'block', path, bytes };
  }

  /** Convenience: true when the read should proceed. */
  allowRead(path: string, bytes: number): boolean {
    return this.evaluate(path, bytes).decision !== 'block';
  }

  private emit(e: ToolReadGateEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      /* event listeners must never break the gate */
    }
  }
}
