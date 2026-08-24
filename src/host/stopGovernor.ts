/**
 * Host-side stop governor — per-session budgets that catch runaway agent
 * sessions at the ACP host layer, outside every vendor binary.
 *
 * Motivation: without stop conditions agents burn money without shipping —
 * documented failures range from multi-thousand-dollar hobby scans to a ~$47k
 * multi-agent infinite loop. The stall watchdog (turnWatchdog.ts) covers the
 * opposite failure (total SILENCE); this governor covers the busy runaway: a
 * session that keeps emitting tool calls and tokens without converging.
 *
 * Budgets (each `<= 0` disables that budget):
 *   - maxToolCalls: total tool calls across the whole session.
 *   - maxWallMs:    ACTIVE wall-clock — time between prompt-sent and
 *                   result/error, summed across turns. Idle human thinking
 *                   time between turns never counts.
 *   - maxEstUsd:    estimated spend, read from the backend's cumulative
 *                   `usage.costUsd` snapshots (existing pricing plumbing —
 *                   no new pricing tables).
 *
 * Mode: 'off' | 'warn' (default — surface a sticky banner, never interrupt)
 * | 'hard' (cancel the active stream; the session stays resumable). Each
 * budget fires at most ONCE per session so a tripped warn doesn't nag on
 * every subsequent event.
 *
 * `enableDupToolStop` / `enableNoProgressStop` are config surface only:
 * the actual detectors are delegated child items
 * (cb-identical-tool-signature-loop-circuit-breaker etc.) that will reuse
 * this trip/banner/stop-event plumbing.
 *
 * Pure and timer-free: callers pass `now` in and act on the returned trip.
 * Wall-clock trips are therefore detected on the next event — a fully silent
 * session is the stall watchdog's job, not ours.
 */

export type GovernorMode = 'off' | 'warn' | 'hard';

export interface GovernorConfig {
  mode: GovernorMode;
  /** Total tool calls per session. `<= 0` disables. */
  maxToolCalls: number;
  /** Active (in-turn) wall-clock ms per session. `<= 0` disables. */
  maxWallMs: number;
  /** Estimated USD spend per session. `<= 0` disables. */
  maxEstUsd: number;
  /** Reserved for the duplicate-tool-signature detector child item. */
  enableDupToolStop: boolean;
  /** Reserved for the no-progress detector child item. */
  enableNoProgressStop: boolean;
}

export type GovernorBudget = 'toolCalls' | 'wallClock' | 'estUsd';

export interface GovernorTrip {
  budget: GovernorBudget;
  /** 'warn' surfaces a banner; 'stop' means the caller must cancel the stream. */
  action: 'warn' | 'stop';
  /** The configured limit that was crossed (calls, ms, or USD). */
  limit: number;
  toolCalls: number;
  activeMs: number;
  estUsd: number;
  /** Last few tool titles, oldest first — shown on the banner. */
  lastTools: string[];
}

/** How many recent tool titles the banner shows. */
export const GOVERNOR_LAST_TOOLS = 5;

export class StopGovernor {
  private toolCalls = 0;
  private recentTools: string[] = [];
  private estUsd = 0;
  private closedActiveMs = 0;
  private turnStartedAt: number | undefined;
  private fired = new Set<GovernorBudget>();

  constructor(private cfg: GovernorConfig) {}

  /** Swap limits/mode without resetting counters or already-fired budgets —
   * lets a settings edit (e.g. warn → hard mid-runaway) apply on the very
   * next prompt of the SAME session. */
  setConfig(cfg: GovernorConfig): void {
    this.cfg = cfg;
  }

  /** A prompt was sent. Idempotent while a turn is already open. */
  startTurn(now: number): void {
    if (this.turnStartedAt === undefined) this.turnStartedAt = now;
  }

  /** The turn ended (result or error). Folds the open span into the total. */
  endTurn(now: number): void {
    if (this.turnStartedAt === undefined) return;
    this.closedActiveMs += Math.max(0, now - this.turnStartedAt);
    this.turnStartedAt = undefined;
  }

  noteToolCall(title: string): void {
    this.toolCalls += 1;
    this.recentTools.push(title);
    if (this.recentTools.length > GOVERNOR_LAST_TOOLS) this.recentTools.shift();
  }

  /** Backends emit CUMULATIVE cost snapshots; keep the high-water mark so an
   * out-of-order or per-model partial row can never wind the total back. */
  noteUsage(costUsd: number | undefined): void {
    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > this.estUsd) {
      this.estUsd = costUsd;
    }
  }

  /** Active wall-clock including the currently open turn. */
  activeMs(now: number): number {
    return this.closedActiveMs + (this.turnStartedAt !== undefined ? Math.max(0, now - this.turnStartedAt) : 0);
  }

  /**
   * Evaluate budgets. Returns the first newly-crossed budget (tool calls,
   * then wall clock, then spend) or undefined. Each budget fires once per
   * session; mode 'off' never trips.
   */
  check(now: number): GovernorTrip | undefined {
    if (this.cfg.mode === 'off') return undefined;
    const activeMs = this.activeMs(now);
    const candidates: Array<{ budget: GovernorBudget; limit: number; value: number }> = [
      { budget: 'toolCalls', limit: this.cfg.maxToolCalls, value: this.toolCalls },
      { budget: 'wallClock', limit: this.cfg.maxWallMs, value: activeMs },
      { budget: 'estUsd', limit: this.cfg.maxEstUsd, value: this.estUsd }
    ];
    for (const c of candidates) {
      if (c.limit > 0 && c.value >= c.limit && !this.fired.has(c.budget)) {
        this.fired.add(c.budget);
        return {
          budget: c.budget,
          action: this.cfg.mode === 'hard' ? 'stop' : 'warn',
          limit: c.limit,
          toolCalls: this.toolCalls,
          activeMs,
          estUsd: this.estUsd,
          lastTools: [...this.recentTools]
        };
      }
    }
    return undefined;
  }
}
