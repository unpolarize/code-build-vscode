/**
 * Agent-team idle-notice context-tax meter (v1, observe-only).
 *
 * Counts inbound peer-coordination chatter — idle / notify_when_idle-class
 * teammate notifications and task-completion notices — that lands in the
 * lead session's context, and estimates the tokens it consumes. This is the
 * cost practitioners report as "idle notifications fill the lead's context":
 * unique to team messaging, distinct from spawn-rate / nested-depth governors
 * (process shape) and from the media tool-tax (pixel payloads).
 *
 * Token estimate is the chars÷4 heuristic used elsewhere in the host — it is
 * labeled as an estimate everywhere it is surfaced. Observe-only: never
 * refuses or rewrites idle notices.
 */

export type IdleNoticeKind = 'idle' | 'task_notice' | 'none';

export interface ClassifiedIdleNotice {
  kind: IdleNoticeKind;
  /** Raw matched-text length (chars). */
  byteLength: number;
  /** Estimated context tokens for the notice text (chars/4 heuristic). */
  estimatedTokens: number;
  reason: string;
}

export interface IdleNoticeTaxConfig {
  /** 'off' disables metering side-effects; classification still works. */
  mode: 'off' | 'warn';
  /** Soft gate: idle/notify events this session. `<= 0` disables. Default 8. */
  maxNotices: number;
  /**
   * Soft gate: session idle-notice tokens as % of context window.
   * `<= 0` disables. Default 5.
   */
  maxWindowPct: number;
}

export const DEFAULT_IDLE_NOTICE_TAX_CONFIG: IdleNoticeTaxConfig = {
  mode: 'warn',
  maxNotices: 8,
  maxWindowPct: 5
};

export const IDLE_NOTICE_TAX_HINT =
  'Team idle/notify chatter is filling the lead context. Consider fewer teammates, ' +
  'batched check-ins, or notify_when_idle only where the lead must react.';

/**
 * Idle-notice shapes seen in Claude agent-team / multi-agent transcripts.
 * Heuristic by design (labeled as such): matches the wrapper tags and the
 * stock phrasings, not vendor UI pixels. Each pattern gets a stable reason
 * string so fixtures can pin classifications.
 */
const IDLE_PATTERNS: Array<{ re: RegExp; kind: IdleNoticeKind; reason: string }> = [
  { re: /\bnotify_when_idle\b/i, kind: 'idle', reason: 'notify-when-idle-marker' },
  {
    re: /<teammate[-_]?(idle|status)[^>]*>/i,
    kind: 'idle',
    reason: 'teammate-idle-tag'
  },
  {
    re: /\bidle[-_ ]notification\b/i,
    kind: 'idle',
    reason: 'idle-notification-phrase'
  },
  {
    re: /\b(teammate|agent|worker|subagent)\b[^.\n]{0,120}\b(is (now )?idle|went idle|has gone idle|became idle)\b/i,
    kind: 'idle',
    reason: 'peer-went-idle-phrase'
  },
  {
    re: /<task-notification\b[^>]*>/i,
    kind: 'task_notice',
    reason: 'task-notification-tag'
  },
  {
    re: /\b(background\s+)?(task|agent|subagent|teammate)\b[^.\n]{0,120}\b(has (completed|finished)|completed successfully|finished running)\b/i,
    kind: 'task_notice',
    reason: 'task-complete-phrase'
  }
];

export function estimateNoticeTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Classify one inbound text payload. Idle-class matches win over
 * task-notice matches (idle chatter is the tax this meter exists for).
 * Never throws — non-string / unmatched input → kind 'none'.
 */
export function classifyIdleNoticeText(text: unknown): ClassifiedIdleNotice {
  if (typeof text !== 'string' || text.length === 0) {
    return { kind: 'none', byteLength: 0, estimatedTokens: 0, reason: 'empty' };
  }
  let hit: { kind: IdleNoticeKind; reason: string } | undefined;
  for (const p of IDLE_PATTERNS) {
    if (p.re.test(text)) {
      hit = { kind: p.kind, reason: p.reason };
      if (p.kind === 'idle') break;
    }
  }
  if (!hit) {
    return { kind: 'none', byteLength: text.length, estimatedTokens: 0, reason: 'no-match' };
  }
  return {
    kind: hit.kind,
    byteLength: text.length,
    estimatedTokens: estimateNoticeTokens(text),
    reason: hit.reason
  };
}

/** Pull text out of a ContentBlock-shaped part (or plain string). */
export function extractNoticeText(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    const o = part as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.content)) {
      const nested = o.content
        .map((c) => extractNoticeText(c))
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      if (nested.length > 0) return nested.join('\n');
    }
  }
  return undefined;
}

export interface IdleNoticeTaxSnapshot {
  /** Idle-class notices this session. */
  idleCount: number;
  /** Task-completion notices this session. */
  taskNoticeCount: number;
  /** Estimated session tokens consumed by all counted notices. */
  sessionNoticeTokens: number;
  pause: boolean;
  pauseReasons: string[];
}

export interface IdleNoticeTaxChip {
  idleCount: number;
  taskNoticeCount: number;
  sessionNoticeTokens: number;
  /** Short chip label, e.g. `idle 4 · ~1.2k`. */
  label: string;
  warn: boolean;
  pause: boolean;
  hint?: string;
}

function formatTokCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Build the header chip from a snapshot. */
export function evaluateIdleNoticeChip(snap: IdleNoticeTaxSnapshot): IdleNoticeTaxChip {
  const events = snap.idleCount + snap.taskNoticeCount;
  const label =
    snap.sessionNoticeTokens > 0
      ? `idle ${events} · ~${formatTokCount(snap.sessionNoticeTokens)}`
      : `idle ${events}`;
  const warn = snap.pause;
  return {
    idleCount: snap.idleCount,
    taskNoticeCount: snap.taskNoticeCount,
    sessionNoticeTokens: snap.sessionNoticeTokens,
    label,
    warn,
    pause: snap.pause,
    ...(warn ? { hint: IDLE_NOTICE_TAX_HINT } : {})
  };
}

/**
 * Per-session accumulator. Pure / timer-free — callers pass windowTokens for
 * the % gate. Notices carried on a tool call are counted once per toolCallId.
 */
export class IdleNoticeTaxTracker {
  private idleCount = 0;
  private taskNoticeCount = 0;
  private sessionNoticeTokens = 0;
  private seenToolIds = new Set<string>();
  private pauseFired = false;

  /**
   * Ingest one inbound text payload (user-injected chunk or tool-result
   * text). Returns the classification when it contributed tax.
   */
  noteText(text: unknown, opts?: { toolCallId?: string }): ClassifiedIdleNotice | undefined {
    const c = classifyIdleNoticeText(extractNoticeText(text) ?? text);
    if (c.kind === 'none') return undefined;
    const id = opts?.toolCallId;
    if (id) {
      if (this.seenToolIds.has(id)) return undefined;
      this.seenToolIds.add(id);
    }
    if (c.kind === 'idle') this.idleCount += 1;
    else this.taskNoticeCount += 1;
    this.sessionNoticeTokens += c.estimatedTokens;
    return c;
  }

  snapshot(
    cfg: IdleNoticeTaxConfig = DEFAULT_IDLE_NOTICE_TAX_CONFIG,
    windowTokens?: number
  ): IdleNoticeTaxSnapshot {
    const pauseReasons: string[] = [];
    const events = this.idleCount + this.taskNoticeCount;
    if (cfg.mode !== 'off') {
      if (cfg.maxNotices > 0 && events >= cfg.maxNotices) {
        pauseReasons.push(`idle/notify events ${events} ≥ limit ${cfg.maxNotices}`);
      }
      if (
        cfg.maxWindowPct > 0 &&
        typeof windowTokens === 'number' &&
        windowTokens > 0 &&
        (this.sessionNoticeTokens / windowTokens) * 100 >= cfg.maxWindowPct
      ) {
        const pct = ((this.sessionNoticeTokens / windowTokens) * 100).toFixed(1);
        pauseReasons.push(`idle-notice tax ${pct}% of window ≥ ${cfg.maxWindowPct}%`);
      }
    }
    return {
      idleCount: this.idleCount,
      taskNoticeCount: this.taskNoticeCount,
      sessionNoticeTokens: this.sessionNoticeTokens,
      pause: pauseReasons.length > 0,
      pauseReasons
    };
  }

  /**
   * Soft gate: returns chip + whether this is a newly crossed warn (fire once).
   * mode 'off' never warns.
   */
  check(
    cfg: IdleNoticeTaxConfig = DEFAULT_IDLE_NOTICE_TAX_CONFIG,
    windowTokens?: number
  ): { chip: IdleNoticeTaxChip; newlyWarned: boolean; pauseReasons: string[] } {
    const snap = this.snapshot(cfg, windowTokens);
    const chip = evaluateIdleNoticeChip(snap);
    let newlyWarned = false;
    if (cfg.mode !== 'off' && snap.pause && !this.pauseFired) {
      this.pauseFired = true;
      newlyWarned = true;
    }
    return { chip, newlyWarned, pauseReasons: snap.pauseReasons };
  }

  /** Test/helper accessor. */
  getEventCount(): number {
    return this.idleCount + this.taskNoticeCount;
  }
}
