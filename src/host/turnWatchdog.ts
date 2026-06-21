/**
 * Per-turn liveness watchdog.
 *
 * Background: the only liveness timer CB used to have was the STARTUP nudge
 * (postStartupNotice), which is cancelled the moment the agent emits its first
 * event and never re-armed for the turn itself. When the underlying CLI stalls
 * mid-turn — e.g. claude's intermittent `error_during_execution` that produces
 * ZERO assistant output and burns ZERO tokens before failing — nothing detected
 * it: the webview sat on "working…" indefinitely with no feedback and no way to
 * recover except a manual Stop that didn't always land.
 *
 * This watchdog watches a turn for *total silence* (no meaningful agent output)
 * and escalates in two stages:
 *   1. `warnMs` of silence  → onWarn(): tell the user it looks stuck and offer
 *      the choice to Stop or keep waiting.
 *   2. `autoCancelMs` of silence → onAutoCancel(): force-recover so the UI never
 *      stays stuck — UNLESS a tool call is in progress, because a legitimate
 *      long-running command (build, test suite, install) is silent for minutes
 *      by design and must not be killed. While a tool is open we keep watching
 *      and re-poll instead of cancelling.
 *
 * Pure and side-effect-free except through the injected callbacks/timers, so it
 * unit-tests without VS Code or real wall-clock time.
 */
export interface TurnWatchdogOptions {
  /** Ms of total silence before warning. `<= 0` disables the watchdog entirely. */
  warnMs: number;
  /**
   * Ms of total silence before auto-cancelling. `<= 0` (or `<= warnMs`) means
   * "warn only, never auto-cancel" — the user stays in control via Stop.
   */
  autoCancelMs: number;
  /** Invoked after `warnMs` of silence. `silentMs` is the elapsed threshold. */
  onWarn: (silentMs: number) => void;
  /**
   * Invoked after `autoCancelMs` of silence when NO tool call is in progress.
   * Should perform the hardened cancel + clear the busy UI so recovery is
   * guaranteed.
   */
  onAutoCancel: (silentMs: number) => void;
  /**
   * True while the agent has an in-progress tool call. Such a turn can be
   * legitimately silent for a long time, so auto-cancel is suppressed while it
   * returns true. Defaults to "never an open tool".
   */
  hasOpenTool?: () => boolean;
  /**
   * True while the turn is legitimately paused waiting for a HUMAN response —
   * an AskUserQuestion answer or a permission decision. That wait is not a
   * stall (it can last minutes by design), so BOTH the warn and the auto-cancel
   * are suppressed and re-polled until the user responds. Defaults to "never
   * awaiting the user".
   */
  isAwaitingUser?: () => boolean;
  /** Injectable timer factory (tests pass a virtual clock). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer canceller. */
  clearTimer?: (handle: unknown) => void;
}

type Stage = 'idle' | 'armed' | 'warned';

export class TurnWatchdog {
  private stage: Stage = 'idle';
  private handle: unknown;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: TurnWatchdogOptions) {
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimer =
      opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** True while a turn is being watched. */
  get active(): boolean {
    return this.stage !== 'idle';
  }

  /** Start (or restart) watching a turn — call when a prompt is sent. */
  arm(): void {
    this.cancelTimer();
    if (this.opts.warnMs <= 0) {
      this.stage = 'idle';
      return;
    }
    this.stage = 'armed';
    this.handle = this.setTimer(() => this.onWarnTick(), this.opts.warnMs);
  }

  /**
   * Meaningful agent output arrived (assistant/thought chunk, tool call/update,
   * usage). The turn is demonstrably alive, so reset the silence clock. No-op
   * when no turn is being watched, and explicitly NOT triggered by `system_init`
   * or `available_commands_update` — claude emits those repeatedly while idle.
   */
  progress(): void {
    if (this.stage === 'idle') return;
    this.arm();
  }

  /** Stop watching — call on `result`/`error` or when the session is torn down. */
  clear(): void {
    this.stage = 'idle';
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.handle !== undefined) {
      this.clearTimer(this.handle);
      this.handle = undefined;
    }
  }

  private onWarnTick(): void {
    this.handle = undefined;
    // Paused on the human (AskUserQuestion / permission), not stuck — keep
    // watching without nagging; re-poll after another warn window.
    if (this.opts.isAwaitingUser?.()) {
      this.stage = 'armed';
      this.handle = this.setTimer(() => this.onWarnTick(), this.opts.warnMs);
      return;
    }
    this.stage = 'warned';
    this.opts.onWarn(this.opts.warnMs);
    const remaining = this.opts.autoCancelMs - this.opts.warnMs;
    if (this.opts.autoCancelMs > 0 && remaining > 0) {
      this.handle = this.setTimer(() => this.onAutoCancelTick(), remaining);
    }
  }

  private onAutoCancelTick(): void {
    this.handle = undefined;
    // A long-running tool call (build/test/install) is silent by design —
    // don't kill it. Keep watching and re-poll after another full window so a
    // tool that NEVER returns still eventually surfaces, while the user retains
    // manual Stop throughout.
    if (this.opts.hasOpenTool?.() || this.opts.isAwaitingUser?.()) {
      this.handle = this.setTimer(() => this.onAutoCancelTick(), this.opts.autoCancelMs);
      return;
    }
    const silentMs = this.opts.autoCancelMs;
    this.clear();
    this.opts.onAutoCancel(silentMs);
  }
}
