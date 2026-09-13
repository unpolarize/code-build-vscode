/**
 * Suppress ACP `session/update` replay during `session/load`.
 *
 * Grok (and other loadSession agents) stream the on-disk transcript as
 * live `session/update` notifications while `session/load` is in flight,
 * and a few more lines can arrive AFTER the RPC result. CB already holds
 * that transcript in the local JSONL — appending the replay flood poisons
 * the tail window (update-only records, no `type:'user'`) and mutes the
 * stall watchdog (`user_message_chunk` → awaitingPermission).
 *
 * Window = load in-flight + a short drain after the RPC settles. Closed
 * immediately when the host sends `session/prompt` so a live turn is
 * never dropped. Notifications after the window persist as usual.
 *
 * Pure: injectable clock for tests. No vscode.
 */

export type SessionLoadReplayPhase = 'idle' | 'loading' | 'draining';

/** Late notifications after session/load's RPC result. Long enough to
 * catch the grok drain, short enough not to eat the first live turn
 * if prompt() is delayed. prompt() also closes the window explicitly. */
export const DEFAULT_SESSION_LOAD_DRAIN_MS = 250;

export type SessionLoadReplayClock = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const realClock: SessionLoadReplayClock = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
};

export class SessionLoadReplayWindow {
  phase: SessionLoadReplayPhase = 'idle';
  private drainHandle: unknown;

  constructor(
    private readonly drainMs: number = DEFAULT_SESSION_LOAD_DRAIN_MS,
    private readonly clock: SessionLoadReplayClock = realClock
  ) {}

  /** Call immediately before `session/load`. */
  beginLoad(): void {
    this.clearDrain();
    this.phase = 'loading';
  }

  /** Call after `session/load` settles (success or reject). Starts drain. */
  markLoadSettled(): void {
    if (this.phase !== 'loading') return;
    this.phase = 'draining';
    this.drainHandle = this.clock.setTimer(() => {
      this.drainHandle = undefined;
      if (this.phase === 'draining') this.phase = 'idle';
    }, this.drainMs);
  }

  /** Live turn starts — stop dropping even if drain is still running. */
  markPromptSent(): void {
    this.clearDrain();
    this.phase = 'idle';
  }

  shouldDropSessionUpdate(): boolean {
    return this.phase === 'loading' || this.phase === 'draining';
  }

  dispose(): void {
    this.clearDrain();
    this.phase = 'idle';
  }

  private clearDrain(): void {
    if (this.drainHandle !== undefined) {
      this.clock.clearTimer(this.drainHandle);
      this.drainHandle = undefined;
    }
  }
}

/** Persist the You-row before `ensureSession` when the session id is
 * already known (idle-resume). Brand-new chats still persist after
 * `openSession` creates meta. */
export function persistUserTurnTiming(hasSessionMeta: boolean): 'before-ensure-session' | 'after-ensure-session' {
  return hasSessionMeta ? 'before-ensure-session' : 'after-ensure-session';
}

/** Kinds that count as "agent woke up" for the Resuming/Restoring nudge. */
export function isFirstEventProgress(kind: string): boolean {
  return (
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'tool_call' ||
    kind === 'available_commands_update' ||
    kind === 'system_init' ||
    kind === 'user_message_chunk'
  );
}
