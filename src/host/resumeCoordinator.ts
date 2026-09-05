// Resume-after-reset host coordinator
// (kp: ideas/cb-host-resume-after-reset-coordinator-park-goal).
//
// Owns the lifecycle around the pure resumeAfterReset core: caches the
// 5-hour rate window's resets_at from spend_limit_update events, parks the
// session on a classified quota (429) soft-stop, arms ONE wake timer, and
// wakes by re-priming the SAME backend session — never a failover.
//
// Host duties are injected (ResumeCoordinatorHost) so the whole flow is
// integration-testable with a fake clock/timer and a backend stub. Ordering
// contract from the core module: `persist` is ALWAYS called with the closed
// (resumed/cancelled) stamp BEFORE `injectPrimer` — a crash between the two
// loses at most one primer, never double-fires it into a live window.
//
// Auto-wake is gated by canAutoWake (explicit flag AND declared away
// window, evaluated at FIRE time, not park time). Outside the gate the
// timer only notifies — the human presses Resume.

import type { BackendId } from '../shared/acpTypes';
import type { BackendErrorClass } from '../shared/backendErrorClass';
import {
  buildPauseForReset,
  canAutoWake,
  cancelPause,
  resumeChipLabel,
  takeManualResume,
  takeWake,
  type AutoWakeConfig,
  type ResumeAfterResetPause,
  type ResumePrimerOptions
} from '../shared/resumeAfterReset';

export interface ResumeTimerHandle {
  dispose(): void;
}

export interface ResumeCoordinatorHost {
  now(): number;
  /** Arm a one-shot timer; the coordinator holds at most one at a time. */
  setTimer(delayMs: number, fn: () => void): ResumeTimerHandle;
  /** CAS-persist the stamp onto SessionMeta.pausedForReset (and post the
   * refreshed meta). MUST complete before any primer injection. */
  persist(pause: ResumeAfterResetPause): void;
  /** Render/clear the header chip. Null clears. */
  postChip(pause: ResumeAfterResetPause | null): void;
  /** Re-prime the SAME backend session (spawn/resume if the process died). */
  injectPrimer(primer: string): void;
  notify(text: string): void;
  autoWakeConfig(): AutoWakeConfig;
  primerOptions(): ResumePrimerOptions;
}

export interface PauseContext {
  backend: BackendId;
  kpItemId?: string;
  goalSnapshot?: string;
}

export class ResumeCoordinator {
  private current?: ResumeAfterResetPause;
  private timer?: ResumeTimerHandle;
  private fiveHourResetsAt: number | null = null;

  constructor(private readonly host: ResumeCoordinatorHost) {}

  /** Latest 5-HOUR rate window resets_at (epoch sec) seen on the stream.
   * This is the window a 429 park binds to — never spend_limit's.
   * Explicit null CLEARS the cache (payload carried rate_limits but no
   * usable five_hour — a stale value must not bind a later park);
   * undefined is a no-op. A signal arriving while a park sits at
   * "unknown reset" re-binds the live stamp and arms the timer. */
  noteRateWindowReset(resetsAtEpochSec: number | null | undefined): void {
    if (resetsAtEpochSec === null) {
      this.fiveHourResetsAt = null;
      return;
    }
    if (resetsAtEpochSec == null || !Number.isFinite(resetsAtEpochSec)) return;
    this.fiveHourResetsAt = resetsAtEpochSec;
    const pause = this.current;
    if (pause?.state !== 'paused_for_reset' || pause.resumeAt != null) return;
    const resumeAt = resetsAtEpochSec * 1000;
    if (resumeAt <= this.host.now()) return; // stale signal — stay unknown
    this.adopt({ ...pause, resumeAt });
  }

  /** Live park present (key on state, never stamp truthiness). */
  get isPaused(): boolean {
    return this.current?.state === 'paused_for_reset';
  }

  get pause(): ResumeAfterResetPause | undefined {
    return this.current;
  }

  /**
   * Classified backend error reached the host. Quota parks (once — repeat
   * 429s while parked are absorbed); everything else is not ours and
   * returns false so the failover path keeps owning overload/unavailable.
   */
  onBackendError(errorClass: BackendErrorClass, message: string, ctx: PauseContext): boolean {
    if (errorClass !== 'quota') return false;
    if (this.isPaused) return true; // already parked; don't re-stamp or re-arm
    const pause = buildPauseForReset({
      errorClass,
      backend: ctx.backend,
      now: this.host.now(),
      resetsAtEpochSec: this.fiveHourResetsAt,
      ...(ctx.kpItemId ? { kpItemId: ctx.kpItemId } : {}),
      ...(ctx.goalSnapshot ? { goalSnapshot: ctx.goalSnapshot } : {}),
      reason: message.slice(0, 300)
    });
    if (!pause) return false;
    this.adopt(pause);
    this.host.notify(
      pause.resumeAt != null
        ? `Usage limit hit — parked this session. ${resumeChipLabel(pause)}.`
        : 'Usage limit hit — parked this session. Reset time unknown; press Resume when your window is back.'
    );
    return true;
  }

  /** Rebuild chip + timer from a persisted stamp after a reload. A stamp
   * already past its resumeAt notifies instead of auto-injecting — a
   * reload must never surprise-fire a primer. */
  hydrate(pause: ResumeAfterResetPause | undefined): void {
    this.disarm();
    this.current = pause;
    if (pause?.state !== 'paused_for_reset') return;
    this.host.postChip(pause);
    if (pause.resumeAt != null && pause.resumeAt <= this.host.now()) {
      this.host.notify('Usage window has reset — press Resume to continue this session.');
      return;
    }
    this.arm(pause);
  }

  /** Chip Resume button — the only wake when the reset time is unknown. */
  manualResume(): void {
    if (!this.current) return;
    const taken = takeManualResume(this.current, this.host.now(), this.host.primerOptions());
    if (!taken) return;
    this.finishWake(taken.pause, taken.primer);
  }

  /** Chip Cancel / Switch-backend-now. Closes the stamp; never rewrites a
   * resumed/cancelled one (core guards that). */
  cancel(reason: 'cancel' | 'switch_backend' = 'cancel'): void {
    if (!this.current) return;
    const closed = cancelPause(this.current, this.host.now(), reason);
    if (closed === this.current) return; // wasn't a live park
    this.disarm();
    this.current = closed;
    this.host.persist(closed);
    this.host.postChip(null);
  }

  /** New/loaded session owns a fresh coordinator state. Persisted stamps on
   * the OLD session's meta are left as history, and the cached rate-window
   * reset dies with the session that observed it — a replacement session
   * (possibly a different backend) must re-learn its own window. */
  clear(): void {
    this.disarm();
    this.current = undefined;
    this.fiveHourResetsAt = null;
  }

  /**
   * The primer injection the wake path handed off could not reach the
   * backend (ensureSession failed). The stamp is already closed — re-park
   * at "unknown reset" so the chip's manual Resume can retry, instead of
   * stranding the session with a resumed stamp and no primer delivered.
   */
  notePrimerInjectFailed(): void {
    const p = this.current;
    if (p?.state !== 'resumed') return;
    const reparked: ResumeAfterResetPause = {
      state: 'paused_for_reset',
      backend: p.backend,
      pausedAt: this.host.now(),
      resumeAt: null,
      ...(p.kpItemId ? { kpItemId: p.kpItemId } : {}),
      ...(p.goalSnapshot ? { goalSnapshot: p.goalSnapshot } : {}),
      reason: 'resume primer injection failed'
    };
    this.adopt(reparked);
    this.host.notify('Resume failed to reach the backend — press Resume to retry.');
  }

  private adopt(pause: ResumeAfterResetPause): void {
    this.disarm();
    this.current = pause;
    this.host.persist(pause);
    this.host.postChip(pause);
    this.arm(pause);
  }

  private arm(pause: ResumeAfterResetPause): void {
    if (pause.state !== 'paused_for_reset' || pause.resumeAt == null) return;
    const delay = Math.max(0, pause.resumeAt - this.host.now());
    this.timer = this.host.setTimer(delay, () => this.onTimerFire());
  }

  private onTimerFire(): void {
    this.timer = undefined;
    const pause = this.current;
    if (pause?.state !== 'paused_for_reset') return;
    // Gate evaluated at FIRE time — a flag or away window that changed
    // while parked is honored, and the default stays notify-only.
    if (!canAutoWake(this.host.autoWakeConfig())) {
      this.host.notify('Usage window has reset — press Resume to continue this session.');
      return;
    }
    const taken = takeWake(pause, this.host.now(), this.host.primerOptions());
    if (!taken) return; // not due yet / raced a manual resume — single-fire holds
    this.finishWake(taken.pause, taken.primer);
  }

  private finishWake(closed: ResumeAfterResetPause, primer: string): void {
    this.disarm();
    this.current = closed;
    // Persist BEFORE inject: two holders of the paused snapshot must never
    // both reach the backend, and a crash here drops the primer, not the ledger.
    this.host.persist(closed);
    this.host.postChip(null);
    this.host.injectPrimer(primer);
  }

  private disarm(): void {
    this.timer?.dispose();
    this.timer = undefined;
  }
}
