// Resume-after-reset coordinator core
// (kp: ideas/cb-host-resume-after-reset-coordinator-park-goal).
//
// Pure state machine for the SAME-backend wait+resume path on a classified
// quota (429-class) soft-stop: park the Goal/KP binding, sleep until the
// usage window resets, then re-prime the same ACP session with a structured
// resume pack. Deliberately distinct from cross-ACP failover (529/overload,
// failoverOffer.ts) and limit-aware backend auto-switch — nothing in this
// module ever suggests or selects a different backend.
//
// Contracts that matter:
// - Only 'quota' errors park; overload/unavailable/auth/other return null.
// - Never invent a reset time: no usage signal → resumeAt null → the chip
//   says "unknown reset" and only a manual Resume can wake the session.
// - Wake fires at most once (takeWake consumes the paused state).
// - Auto-wake requires an explicit config flag AND a declared away window;
//   the default is notify-only.

import type { BackendId } from './acpTypes';
import type { BackendErrorClass } from './backendErrorClass';

export type ResumePauseState = 'paused_for_reset' | 'resumed' | 'cancelled';

export interface ResumeAfterResetPause {
  state: ResumePauseState;
  backend: BackendId;
  /** Epoch-ms when the quota stop parked the session. */
  pausedAt: number;
  /** Epoch-ms when the usage window resets; null = unknown (manual resume only). */
  resumeAt: number | null;
  /** KP item bound to the session at park time (mirrors SessionMeta.kpItemId). */
  kpItemId?: string;
  /** Last goal / acceptance snapshot, serialized so intent survives the park. */
  goalSnapshot?: string;
  /** Short classified error text for the chip tooltip / log. */
  reason?: string;
  /** Epoch-ms when takeWake fired (state 'resumed'). */
  resumedAt?: number;
  /** Epoch-ms when the user cancelled or switched away (state 'cancelled'). */
  cancelledAt?: number;
  cancelReason?: 'cancel' | 'switch_backend';
}

export interface BuildPauseInput {
  errorClass: BackendErrorClass;
  backend: BackendId;
  /** Epoch-ms clock at classification time. */
  now: number;
  /** Window reset from the usage signal, epoch SECONDS (Claude statusline
   * convention); ms accepted defensively. Omit/null when the signal is
   * missing — resumeAt stays null, never guessed. */
  resetsAtEpochSec?: number | null;
  kpItemId?: string;
  goalSnapshot?: string;
  reason?: string;
}

function toEpochMs(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  // Values already in ms sneak through some payloads.
  return v > 1e12 ? Math.floor(v) : Math.floor(v * 1000);
}

/**
 * Park the session on a quota soft-stop. Returns null for every other
 * error class — 529/overload stays on the failover path.
 */
export function buildPauseForReset(input: BuildPauseInput): ResumeAfterResetPause | null {
  if (input.errorClass !== 'quota') return null;
  const resumeAt = toEpochMs(input.resetsAtEpochSec);
  return {
    state: 'paused_for_reset',
    backend: input.backend,
    pausedAt: input.now,
    // A reset time in the past is as good as unknown — don't wake instantly
    // off a stale signal.
    resumeAt: resumeAt != null && resumeAt > input.now ? resumeAt : null,
    ...(input.kpItemId ? { kpItemId: input.kpItemId } : {}),
    ...(input.goalSnapshot ? { goalSnapshot: input.goalSnapshot } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  };
}

/** True when the parked session is due to wake (known reset time reached). */
export function shouldWake(pause: ResumeAfterResetPause, nowMs: number): boolean {
  return (
    pause.state === 'paused_for_reset' &&
    pause.resumeAt != null &&
    nowMs >= pause.resumeAt
  );
}

export interface ResumePrimerOptions {
  doneSummary?: string;
  remaining?: string;
  verifyCommand?: string;
}

/**
 * Structured re-prime for the SAME backend session after the window resets.
 * Also used by manual Resume when the reset time was unknown.
 */
export function buildResumePrimer(
  pause: ResumeAfterResetPause,
  opts: ResumePrimerOptions = {}
): string {
  const lines: string[] = [
    'Resuming after a usage-window reset on the same backend. Do not switch backends.'
  ];
  if (pause.kpItemId) lines.push(`KP item: ${pause.kpItemId}`);
  if (pause.goalSnapshot) lines.push(`Goal at park time:\n${pause.goalSnapshot}`);
  if (opts.doneSummary) lines.push(`Done before the stop:\n${opts.doneSummary}`);
  if (opts.remaining) lines.push(`Remaining:\n${opts.remaining}`);
  if (opts.verifyCommand) lines.push(`Verify with: ${opts.verifyCommand}`);
  lines.push('Continue from where the quota stop interrupted the task.');
  return lines.join('\n\n');
}

/**
 * Single-fire wake: consumes the paused state, returning the resumed stamp
 * plus the primer to inject. Null when not due (or already resumed /
 * cancelled), so a second timer tick can never emit a second primer or
 * spawn a concurrent resume.
 */
export function takeWake(
  pause: ResumeAfterResetPause,
  nowMs: number,
  opts: ResumePrimerOptions = {}
): { pause: ResumeAfterResetPause; primer: string } | null {
  if (!shouldWake(pause, nowMs)) return null;
  return {
    pause: { ...pause, state: 'resumed', resumedAt: nowMs },
    primer: buildResumePrimer(pause, opts)
  };
}

/** User pressed Cancel or Switch-backend-now on the chip. */
export function cancelPause(
  pause: ResumeAfterResetPause,
  nowMs: number,
  cancelReason: 'cancel' | 'switch_backend' = 'cancel'
): ResumeAfterResetPause {
  return { ...pause, state: 'cancelled', cancelledAt: nowMs, cancelReason };
}

export interface AutoWakeConfig {
  /** Explicit opt-in flag; default off → notify only. */
  autoWakeEnabled?: boolean;
  /** True only inside a declared walkaway/away window. */
  inAwayWindow?: boolean;
}

/**
 * Auto-wake gate: never auto-wake into the interactive band. Both the
 * config flag and a declared away window are required; anything else means
 * notify the human and wait for a manual Resume.
 */
export function canAutoWake(cfg: AutoWakeConfig | null | undefined): boolean {
  return cfg?.autoWakeEnabled === true && cfg?.inAwayWindow === true;
}

/** Default HH:MM (local, 24h) for the chip; injectable for tests. */
function defaultFormatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Header chip copy. Paused with a known reset → "Resume after reset ·
 * wakes HH:MM"; unknown reset → "· unknown reset" (manual Resume only).
 * Resumed/cancelled stamps render no chip.
 */
export function resumeChipLabel(
  pause: ResumeAfterResetPause,
  formatTime: (epochMs: number) => string = defaultFormatTime
): string | null {
  if (pause.state !== 'paused_for_reset') return null;
  if (pause.resumeAt == null) return 'Resume after reset · unknown reset';
  return `Resume after reset · wakes ${formatTime(pause.resumeAt)}`;
}
