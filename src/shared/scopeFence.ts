/**
 * Small-effort ScopeFence (kp: ideas/cb-small-effort-scope-fence-bind-host-tool-polic).
 *
 * When a session is primed from a KP item with `implement_effort: small|tiny`,
 * bind host write policy: soft path budget + deny-list for CLAUDE.md /
 * AGENTS.md / `.grok/**`, plus a heuristic pause when the assistant proposes
 * architecture digression. Advisory + deny-list only — human override always
 * available; never silently rewrite prompts.
 */

export const DEFAULT_SCOPE_FENCE_MAX_WRITE_PATHS = 5;

export interface ScopeFenceConfig {
  /** Max distinct write paths this session. `<= 0` disables the budget. */
  maxWritePaths: number;
}

export const DEFAULT_SCOPE_FENCE_CONFIG: ScopeFenceConfig = {
  maxWritePaths: DEFAULT_SCOPE_FENCE_MAX_WRITE_PATHS
};

/** KP implement_effort values that arm the fence. */
export function shouldEnableScopeFence(effort: string | null | undefined): boolean {
  const e = (effort ?? '').trim().toLowerCase();
  return e === 'small' || e === 'tiny';
}

/**
 * Extract `implement_effort` from a `kp pack` / show body (frontmatter or
 * inline `implement_effort: small` note). Best-effort — missing → null.
 */
export function parseImplementEffortFromText(text: string): string | null {
  if (!text) return null;
  const m = text.match(/implement_effort\s*:\s*['"]?([A-Za-z0-9_-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Normalize for set membership (posix slashes, trim). */
export function normalizeFencePath(p: string): string {
  return p.trim().replace(/\\/g, '/');
}

/**
 * Protected write targets — agent must not rewrite host/agent instruction
 * files or `.grok/**` under a small-effort fence without human override.
 */
export function isProtectedWritePath(path: string): boolean {
  const n = normalizeFencePath(path);
  if (!n) return false;
  const parts = n.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  if (/^CLAUDE\.md$/i.test(base)) return true;
  if (/^AGENTS\.md$/i.test(base)) return true;
  if (parts.some((seg) => seg === '.grok')) return true;
  return false;
}

/**
 * Detect Write / Edit / ApplyPatch style tool calls from title + rawInput.
 * Returns the candidate path when recognizable; null when not a write-ish tool.
 */
export function detectWriteToolPath(
  title: string | undefined,
  rawInput?: unknown
): string | null {
  if (!title) return null;
  const t = title.trim();
  const input =
    rawInput && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>)
      : undefined;

  if (/^(write|write_file|writefile|edit|edit_file|apply_patch|applypatch|create|create_file)$/i.test(t)) {
    return pickPathField(input);
  }

  // Bash wrapping a redirect write (simple forms only).
  if (/^(bash|shell|zsh|sh)$/i.test(t)) {
    const cmd =
      typeof input?.command === 'string'
        ? input.command
        : typeof input?.cmd === 'string'
          ? input.cmd
          : '';
    return parseBashWritePath(cmd);
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
 * Best-effort extract of a write target from a simple redirect command.
 * Rejects pipes / compounds (too ambiguous for a gate).
 */
export function parseBashWritePath(cmd: string): string | null {
  const s = cmd.trim();
  if (!s) return null;
  if (/[|;&\n]/.test(s)) return null;
  // `echo … > path` / `cat … > path` / `tee path`
  const redir = s.match(/>{1,2}\s*(\S+)\s*$/);
  if (redir && !redir[1].startsWith('&')) return redir[1];
  const tee = s.match(/^(?:sudo\s+)?tee\b(?:\s+-[a-zA-Z]+)*\s+(\S+)\s*$/);
  if (tee && !tee[1].startsWith('-')) return tee[1];
  return null;
}

/** Phrases that signal an out-of-scope architecture digression under small effort. */
const ARCH_DIGRESSION_PATTERNS: RegExp[] = [
  /\brefactor(?:ing)?\s+(?:the\s+)?architecture\b/i,
  /\bredesign(?:ing)?\s+(?:the\s+)?(?:module\s+)?boundaries\b/i,
  /\brestructure(?:ing)?\s+(?:the\s+)?(?:whole\s+|entire\s+)?codebase\b/i,
  /\boverhaul(?:ing)?\s+(?:the\s+)?architecture\b/i,
  /\bbig[-\s]?bang\s+refactor\b/i,
  /\brewrite\s+(?:the\s+)?(?:entire\s+|whole\s+)?(?:module|subsystem|architecture)\b/i,
  /\brearchitect(?:ing|ure)?\b/i
];

export function detectArchitectureDigression(text: string): boolean {
  if (!text || text.length < 12) return false;
  return ARCH_DIGRESSION_PATTERNS.some((p) => p.test(text));
}

export type ScopeFenceWriteDecision =
  | 'allow'
  | 'deny_protected'
  | 'deny_budget'
  | 'deny_digression';

export interface ScopeFenceWriteEval {
  decision: ScopeFenceWriteDecision;
  path: string;
  /** Distinct write paths after this eval (budget accounting). */
  usedPaths: number;
  remainingPaths: number | null;
  message: string;
}

export type ScopeFenceEventType =
  | 'enabled'
  | 'disabled'
  | 'deny'
  | 'grant_override'
  | 'expand_effort'
  | 'digression'
  | 'write';

export interface ScopeFenceEvent {
  type: ScopeFenceEventType;
  path?: string;
  message: string;
  remainingPaths?: number | null;
}

/**
 * Session-scoped fence. Pure aside from the optional event callback —
 * callers perform fs I/O and act on `allowWrite` / `evaluateWrite`.
 */
export class ScopeFence {
  private cfg: ScopeFenceConfig;
  private active = false;
  /** Distinct normalized paths already written under the fence. */
  private written = new Set<string>();
  /** Human overrides for specific protected paths. */
  private overrides = new Set<string>();
  /** Global override — all protected paths allowed this session. */
  private overrideAllProtected = false;
  /** Digression pause latched until expand-effort. */
  private digressionPaused = false;
  private onEvent?: (e: ScopeFenceEvent) => void;

  constructor(
    cfg: ScopeFenceConfig = DEFAULT_SCOPE_FENCE_CONFIG,
    onEvent?: (e: ScopeFenceEvent) => void
  ) {
    this.cfg = { ...cfg };
    this.onEvent = onEvent;
  }

  setConfig(cfg: ScopeFenceConfig): void {
    this.cfg = { ...cfg };
  }

  setOnEvent(onEvent?: (e: ScopeFenceEvent) => void): void {
    this.onEvent = onEvent;
  }

  getConfig(): ScopeFenceConfig {
    return { ...this.cfg };
  }

  enable(reason = 'KP implement_effort small|tiny'): void {
    if (this.active) return;
    this.active = true;
    this.emit({
      type: 'enabled',
      message: `ScopeFence on (${reason}) — write budget ${this.budgetLabel()}`,
      remainingPaths: this.remainingPaths()
    });
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.emit({ type: 'disabled', message: 'ScopeFence off', remainingPaths: null });
  }

  isActive(): boolean {
    return this.active;
  }

  isDigressionPaused(): boolean {
    return this.digressionPaused;
  }

  usedPathCount(): number {
    return this.written.size;
  }

  remainingPaths(): number | null {
    if (!this.active) return null;
    if (this.cfg.maxWritePaths <= 0) return null;
    return Math.max(0, this.cfg.maxWritePaths - this.written.size);
  }

  statusChip(): string {
    if (!this.active) return 'ScopeFence off';
    const rem = this.remainingPaths();
    const budget =
      rem === null ? 'budget off' : `${rem} path${rem === 1 ? '' : 's'} left`;
    const pause = this.digressionPaused ? '; expand-effort required' : '';
    return `ScopeFence · ${budget}${pause}`;
  }

  /** Allow writes to a protected path (or all protected when path is '*'). */
  grantOverride(path: string): void {
    const p = normalizeFencePath(path);
    if (!p) return;
    if (p === '*') {
      this.overrideAllProtected = true;
      this.emit({
        type: 'grant_override',
        path: '*',
        message: 'ScopeFence: protected-path override granted for session',
        remainingPaths: this.remainingPaths()
      });
      return;
    }
    this.overrides.add(p);
    this.emit({
      type: 'grant_override',
      path: p,
      message: `ScopeFence: override granted for ${p}`,
      remainingPaths: this.remainingPaths()
    });
  }

  /** Clear digression pause (Require expand-effort chip). */
  expandEffort(): void {
    this.digressionPaused = false;
    this.emit({
      type: 'expand_effort',
      message: 'ScopeFence: expand-effort granted — digression pause cleared',
      remainingPaths: this.remainingPaths()
    });
  }

  /**
   * Scan assistant text for architecture-digression heuristics.
   * When matched under an active fence, latches a write pause until
   * `expandEffort()`.
   */
  noteAssistantText(text: string): boolean {
    if (!this.active || this.digressionPaused) return this.digressionPaused;
    if (!detectArchitectureDigression(text)) return false;
    this.digressionPaused = true;
    this.emit({
      type: 'digression',
      message:
        'ScopeFence paused writes — assistant proposed an architecture digression. ' +
        'Require expand-effort to continue, or keep the change small.',
      remainingPaths: this.remainingPaths()
    });
    return true;
  }

  /**
   * Classify a prospective write. New paths consume budget only when allowed.
   * Re-writes of an already-counted path do not consume extra budget.
   */
  evaluateWrite(path: string): ScopeFenceWriteEval {
    const p = normalizeFencePath(path);
    const used = this.written.size;
    const rem = this.remainingPaths();

    if (!this.active) {
      return {
        decision: 'allow',
        path: p,
        usedPaths: used,
        remainingPaths: null,
        message: 'ScopeFence inactive'
      };
    }

    if (this.digressionPaused) {
      const message =
        `Write blocked by ScopeFence digression pause (${p}). Expand effort to continue.`;
      this.emit({ type: 'deny', path: p, message, remainingPaths: rem });
      return {
        decision: 'deny_digression',
        path: p,
        usedPaths: used,
        remainingPaths: rem,
        message
      };
    }

    if (isProtectedWritePath(p) && !this.overrideAllProtected && !this.overrides.has(p)) {
      const message =
        `Write blocked by ScopeFence protected path (${p}). ` +
        `Override once, or expand effort. Denied: CLAUDE.md / AGENTS.md / .grok/**.`;
      this.emit({ type: 'deny', path: p, message, remainingPaths: rem });
      return {
        decision: 'deny_protected',
        path: p,
        usedPaths: used,
        remainingPaths: rem,
        message
      };
    }

    const already = this.written.has(p);
    if (
      !already &&
      this.cfg.maxWritePaths > 0 &&
      this.written.size >= this.cfg.maxWritePaths
    ) {
      const message =
        `Write blocked by ScopeFence path budget (${this.written.size}/` +
        `${this.cfg.maxWritePaths}): ${p}. Expand effort or finish within budget.`;
      this.emit({ type: 'deny', path: p, message, remainingPaths: 0 });
      return {
        decision: 'deny_budget',
        path: p,
        usedPaths: this.written.size,
        remainingPaths: 0,
        message
      };
    }

    if (!already) this.written.add(p);
    const remaining = this.remainingPaths();
    const message = already
      ? `ScopeFence: re-write allowed (${p}); budget unchanged`
      : `ScopeFence: write allowed (${p}); ${this.budgetLabel()}`;
    this.emit({ type: 'write', path: p, message, remainingPaths: remaining });
    return {
      decision: 'allow',
      path: p,
      usedPaths: this.written.size,
      remainingPaths: remaining,
      message
    };
  }

  /** Convenience: true when the write should proceed. */
  allowWrite(path: string): boolean {
    return this.evaluateWrite(path).decision === 'allow';
  }

  private budgetLabel(): string {
    if (this.cfg.maxWritePaths <= 0) return 'unlimited paths';
    return `${this.written.size}/${this.cfg.maxWritePaths} paths used`;
  }

  private emit(e: ScopeFenceEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      /* event listeners must never break the fence */
    }
  }
}
