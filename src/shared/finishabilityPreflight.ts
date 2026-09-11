/**
 * Finishability preflight gate
 * (kp: ideas/cb-finishability-preflight-gate-block-rebind-fir)
 *
 * Before the first Write/Edit in a KP/goal-bound session, estimate whether
 * the task can finish in the remaining 5h (and weekly, when present) usage
 * window. If the effort-table estimate exceeds remaining × safety_factor,
 * block the write and surface Block / Rebind / Shrink / Override.
 *
 * Distinct from mid-flight walkaway quota co-stop and in-flight Write
 * atomic drain — this is a preflight, not a 429 reaction.
 *
 * Heuristic v1: no cloud, no invented remaining %. Unknown window → allow
 * (cannot gate) with `finish n/a`. Override always available for humans.
 *
 * Pure / vscode-free.
 */

import {
  readFiveHourRemainingPercentage,
  readSevenDayRemainingPercentage,
  type SpendLimitStatusFields
} from './spendLimitChip';

/** Fraction of remaining window the estimate may consume. <1 leaves headroom. */
export const DEFAULT_FINISHABILITY_SAFETY_FACTOR = 0.85;

/** KP implement_effort → estimated % of a 5h window the task will burn. */
export const EFFORT_WINDOW_PCT: Record<string, number> = {
  tiny: 8,
  small: 20,
  medium: 45,
  large: 80,
  xlarge: 100,
  huge: 100
};

export const DEFAULT_EFFORT_WHEN_BOUND = 'medium';

export type FinishabilityAction = 'block' | 'override' | 'rebind' | 'shrink';

export type FinishabilityVerdict = 'skip' | 'allow' | 'block';

export type FinishabilityPhase =
  | 'inactive'
  | 'armed'
  | 'gated'
  | 'passed'
  | 'overridden'
  | 'rebound'
  | 'shrunk';

export type FinishabilityWindow = 'five_hour' | 'seven_day' | 'unknown';

export interface FinishabilityChip {
  available: boolean;
  /** e.g. `finish ⚠ large 80%>10%`, `finish ok · small 20%`, `finish n/a`. */
  label: string;
  gated: boolean;
  effort: string;
  estimatePct: number;
  remainingPct: number | null;
  thresholdPct: number | null;
  window: FinishabilityWindow;
  phase: FinishabilityPhase;
  warn: boolean;
  warnReason?: string;
  hint?: string;
}

export interface FinishabilityDecision {
  verdict: FinishabilityVerdict;
  reason: string;
  effort: string;
  estimatePct: number;
  remainingPct: number | null;
  thresholdPct: number | null;
  window: FinishabilityWindow;
  safetyFactor: number;
  chip: FinishabilityChip;
  actions: FinishabilityAction[];
}

export interface FinishabilityEvalInput {
  /** Session is bound to a KP item / goal. */
  kpBound: boolean;
  /** Explicit multi-file intent (plan / multi-path Write). */
  multiFileIntent?: boolean;
  effort?: string | null;
  fiveHourRemainingPct: number | null;
  sevenDayRemainingPct?: number | null;
  safetyFactor?: number;
  /** First Write already allowed this session. */
  firstWriteDone?: boolean;
  overridden?: boolean;
  shrunk?: boolean;
  phase?: FinishabilityPhase;
}

export interface FinishabilityTelemetry {
  hits: number;
  overrides: number;
  rebinds: number;
  shrinks: number;
  postOverride429: number;
}

export interface FinishabilityConfig {
  safetyFactor: number;
}

export const DEFAULT_FINISHABILITY_CONFIG: FinishabilityConfig = {
  safetyFactor: DEFAULT_FINISHABILITY_SAFETY_FACTOR
};

export type FinishabilityEventType =
  | 'arm'
  | 'deny'
  | 'allow'
  | 'override'
  | 'rebind'
  | 'shrink'
  | 'quota';

export interface FinishabilityEvent {
  type: FinishabilityEventType;
  message: string;
  chip: FinishabilityChip | null;
  path?: string;
  log?: string;
}

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampFactor(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_FINISHABILITY_SAFETY_FACTOR;
  if (raw <= 0) return DEFAULT_FINISHABILITY_SAFETY_FACTOR;
  return Math.min(1, raw);
}

/** Normalize KP implement_effort; unknown/empty → medium when bound. */
export function normalizeImplementEffort(effort: string | null | undefined): string {
  const e = (effort ?? '').trim().toLowerCase();
  if (e && Object.prototype.hasOwnProperty.call(EFFORT_WINDOW_PCT, e)) return e;
  return DEFAULT_EFFORT_WHEN_BOUND;
}

export function estimateEffortWindowPct(effort: string | null | undefined): {
  effort: string;
  estimatePct: number;
} {
  const e = normalizeImplementEffort(effort);
  const pct = EFFORT_WINDOW_PCT[e] ?? EFFORT_WINDOW_PCT[DEFAULT_EFFORT_WHEN_BOUND];
  return { effort: e, estimatePct: pct };
}

export function shouldArmFinishability(input: {
  kpBound: boolean;
  multiFileIntent?: boolean;
  force?: boolean;
}): boolean {
  if (input.force) return true;
  return input.kpBound === true || input.multiFileIntent === true;
}

/**
 * Tighter remaining of 5h and weekly. Null when neither window is known —
 * callers must not invent 100%.
 */
export function pickRemainingWindow(
  fiveHourRemainingPct: number | null | undefined,
  sevenDayRemainingPct?: number | null
): { remainingPct: number | null; window: FinishabilityWindow } {
  const five =
    fiveHourRemainingPct != null && Number.isFinite(fiveHourRemainingPct)
      ? roundPct(Math.max(0, fiveHourRemainingPct))
      : null;
  const week =
    sevenDayRemainingPct != null && Number.isFinite(sevenDayRemainingPct)
      ? roundPct(Math.max(0, sevenDayRemainingPct))
      : null;
  if (five == null && week == null) return { remainingPct: null, window: 'unknown' };
  if (five == null) return { remainingPct: week, window: 'seven_day' };
  if (week == null) return { remainingPct: five, window: 'five_hour' };
  if (week < five) return { remainingPct: week, window: 'seven_day' };
  return { remainingPct: five, window: 'five_hour' };
}

export function readRemainingFromStatus(
  status: SpendLimitStatusFields | null | undefined
): { fiveHourRemainingPct: number | null; sevenDayRemainingPct: number | null } {
  return {
    fiveHourRemainingPct: readFiveHourRemainingPercentage(status),
    sevenDayRemainingPct: readSevenDayRemainingPercentage(status)
  };
}

function idleChip(
  phase: FinishabilityPhase,
  effort: string,
  estimatePct: number
): FinishabilityChip {
  return {
    available: false,
    label: 'finish n/a',
    gated: false,
    effort,
    estimatePct,
    remainingPct: null,
    thresholdPct: null,
    window: 'unknown',
    phase,
    warn: false
  };
}

function buildChip(input: {
  phase: FinishabilityPhase;
  effort: string;
  estimatePct: number;
  remainingPct: number | null;
  thresholdPct: number | null;
  window: FinishabilityWindow;
  gated: boolean;
  warnReason?: string;
  hint?: string;
}): FinishabilityChip {
  const { phase, effort, estimatePct, remainingPct, thresholdPct, window, gated } = input;
  let label: string;
  if (phase === 'overridden') label = 'finish override';
  else if (phase === 'shrunk') label = 'finish shrink';
  else if (phase === 'rebound') label = 'finish rebind';
  else if (remainingPct == null) label = 'finish n/a';
  else if (gated) label = `finish ⚠ ${effort} ${estimatePct}%>${remainingPct}%`;
  else if (phase === 'passed') label = `finish ok · ${effort} ${estimatePct}%`;
  else label = `finish ok · ${effort} ${estimatePct}%`;

  const warn = gated || phase === 'rebound';
  return {
    available: phase !== 'inactive',
    label,
    gated,
    effort,
    estimatePct,
    remainingPct,
    thresholdPct,
    window,
    phase,
    warn,
    ...(input.warnReason ? { warnReason: input.warnReason } : {}),
    ...(input.hint ? { hint: input.hint } : {})
  };
}

/**
 * Pure gate. Does not mutate. Callers apply the verdict to a tracker.
 */
export function evaluateFinishability(input: FinishabilityEvalInput): FinishabilityDecision {
  const factor = clampFactor(input.safetyFactor);
  const { effort, estimatePct } = estimateEffortWindowPct(input.effort);
  const phase: FinishabilityPhase = input.phase ?? 'armed';
  const armed = shouldArmFinishability({
    kpBound: input.kpBound,
    multiFileIntent: input.multiFileIntent
  });

  if (!armed) {
    const chip = idleChip('inactive', effort, estimatePct);
    return {
      verdict: 'skip',
      reason: 'Not KP/goal-bound and no multi-file intent — finishability idle.',
      effort,
      estimatePct,
      remainingPct: null,
      thresholdPct: null,
      window: 'unknown',
      safetyFactor: factor,
      chip,
      actions: []
    };
  }

  if (input.overridden || phase === 'overridden') {
    const { remainingPct, window } = pickRemainingWindow(
      input.fiveHourRemainingPct,
      input.sevenDayRemainingPct
    );
    const thresholdPct = remainingPct == null ? null : roundPct(remainingPct * factor);
    const chip = buildChip({
      phase: 'overridden',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      gated: false,
      hint: 'Override granted — first Write allowed. Distinct from walkaway co-stop.'
    });
    return {
      verdict: 'allow',
      reason: 'Human override — first Write allowed.',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      safetyFactor: factor,
      chip,
      actions: []
    };
  }

  if (input.shrunk || phase === 'shrunk') {
    const { remainingPct, window } = pickRemainingWindow(
      input.fiveHourRemainingPct,
      input.sevenDayRemainingPct
    );
    const thresholdPct = remainingPct == null ? null : roundPct(remainingPct * factor);
    const chip = buildChip({
      phase: 'shrunk',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      gated: false,
      hint: 'Shrunk to investigate-only — finishability no longer blocks writes.'
    });
    return {
      verdict: 'allow',
      reason: 'Shrunk to investigate-only — finishability gate released.',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      safetyFactor: factor,
      chip,
      actions: []
    };
  }

  if (input.firstWriteDone || phase === 'passed') {
    const { remainingPct, window } = pickRemainingWindow(
      input.fiveHourRemainingPct,
      input.sevenDayRemainingPct
    );
    const thresholdPct = remainingPct == null ? null : roundPct(remainingPct * factor);
    const chip = buildChip({
      phase: 'passed',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      gated: false
    });
    return {
      verdict: 'allow',
      reason: 'First Write already allowed this session.',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      safetyFactor: factor,
      chip,
      actions: []
    };
  }

  const { remainingPct, window } = pickRemainingWindow(
    input.fiveHourRemainingPct,
    input.sevenDayRemainingPct
  );

  if (remainingPct == null) {
    const chip = buildChip({
      phase: phase === 'rebound' ? 'rebound' : 'armed',
      effort,
      estimatePct,
      remainingPct: null,
      thresholdPct: null,
      window: 'unknown',
      gated: false,
      hint: '5h remaining unknown — cannot gate (never invents 100%).'
    });
    return {
      verdict: 'allow',
      reason: 'Remaining 5h/weekly window unknown — cannot gate without inventing remaining %.',
      effort,
      estimatePct,
      remainingPct: null,
      thresholdPct: null,
      window: 'unknown',
      safetyFactor: factor,
      chip,
      actions: []
    };
  }

  const thresholdPct = roundPct(remainingPct * factor);
  const gated = estimatePct > thresholdPct;
  const rebound = phase === 'rebound';
  const actions: FinishabilityAction[] = gated || rebound ? ['block', 'override', 'rebind', 'shrink'] : [];

  if (gated || rebound) {
    const warnReason =
      `Estimated ${effort} task burns ~${estimatePct}% of a 5h window; ` +
      `${window} remaining ${remainingPct}% × ${factor} = ${thresholdPct}% threshold.`;
    const chip = buildChip({
      phase: rebound ? 'rebound' : 'gated',
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      gated: true,
      warnReason,
      hint:
        'Click override · alt-click shrink to investigate-only · shift-click rebind backend. ' +
        'Distinct from mid-flight walkaway co-stop.'
    });
    return {
      verdict: 'block',
      reason: warnReason,
      effort,
      estimatePct,
      remainingPct,
      thresholdPct,
      window,
      safetyFactor: factor,
      chip,
      actions
    };
  }

  const chip = buildChip({
    phase: 'armed',
    effort,
    estimatePct,
    remainingPct,
    thresholdPct,
    window,
    gated: false
  });
  return {
    verdict: 'allow',
    reason: `Estimate ${estimatePct}% ≤ remaining ${remainingPct}% × ${factor} (${thresholdPct}%).`,
    effort,
    estimatePct,
    remainingPct,
    thresholdPct,
    window,
    safetyFactor: factor,
    chip,
    actions: []
  };
}

export function formatFinishabilityLog(input: {
  action: FinishabilityAction | 'deny' | 'allow' | 'arm' | 'quota';
  effort: string;
  estimatePct: number;
  remainingPct: number | null;
  factor: number;
  hits: number;
  overrides: number;
  postOverride429: number;
}): string {
  return (
    `finishability action=${input.action} effort=${input.effort}` +
    ` estimate=${input.estimatePct} remaining=${input.remainingPct ?? 'n/a'}` +
    ` factor=${input.factor} hits=${input.hits} overrides=${input.overrides}` +
    ` postOverride429=${input.postOverride429}`
  );
}

export function formatFinishabilityTooltip(
  chip: Pick<
    FinishabilityChip,
    | 'label'
    | 'effort'
    | 'estimatePct'
    | 'remainingPct'
    | 'thresholdPct'
    | 'window'
    | 'gated'
    | 'warnReason'
    | 'hint'
  >
): string {
  const lines: string[] = [chip.label];
  lines.push(`Effort: ${chip.effort} (~${chip.estimatePct}% of 5h window)`);
  if (chip.remainingPct != null) {
    lines.push(`Remaining (${chip.window}): ${chip.remainingPct}%`);
  } else {
    lines.push('Remaining: n/a (vendor omitted five_hour/seven_day used %)');
  }
  if (chip.thresholdPct != null) lines.push(`Gate threshold: ${chip.thresholdPct}%`);
  if (chip.warnReason) lines.push(chip.warnReason);
  if (chip.hint) lines.push(chip.hint);
  if (chip.gated) {
    lines.push('Click: Override  ·  Alt-click: Shrink to investigate-only  ·  Shift-click: Rebind backend');
  }
  lines.push('Preflight before first Write — not a mid-flight walkaway co-stop.');
  return lines.join('\n');
}

/**
 * Per-session tracker. Arms on KP bind; evaluates only the first Write.
 */
export class FinishabilityPreflightTracker {
  private cfg: FinishabilityConfig;
  private onEvent?: (e: FinishabilityEvent) => void;
  private phase: FinishabilityPhase = 'inactive';
  private effort: string | null = null;
  private kpBound = false;
  private multiFileIntent = false;
  private fiveHourRemainingPct: number | null = null;
  private sevenDayRemainingPct: number | null = null;
  private telemetry: FinishabilityTelemetry = {
    hits: 0,
    overrides: 0,
    rebinds: 0,
    shrinks: 0,
    postOverride429: 0
  };
  private lastChip: FinishabilityChip | null = null;

  constructor(cfg: FinishabilityConfig = DEFAULT_FINISHABILITY_CONFIG, onEvent?: (e: FinishabilityEvent) => void) {
    this.cfg = { safetyFactor: clampFactor(cfg.safetyFactor) };
    this.onEvent = onEvent;
  }

  setConfig(cfg: FinishabilityConfig): void {
    this.cfg = { safetyFactor: clampFactor(cfg.safetyFactor) };
  }

  setOnEvent(onEvent?: (e: FinishabilityEvent) => void): void {
    this.onEvent = onEvent;
  }

  clear(): void {
    this.phase = 'inactive';
    this.effort = null;
    this.kpBound = false;
    this.multiFileIntent = false;
    this.fiveHourRemainingPct = null;
    this.sevenDayRemainingPct = null;
    this.telemetry = { hits: 0, overrides: 0, rebinds: 0, shrinks: 0, postOverride429: 0 };
    this.lastChip = null;
  }

  isActive(): boolean {
    return this.phase !== 'inactive';
  }

  getPhase(): FinishabilityPhase {
    return this.phase;
  }

  getTelemetry(): FinishabilityTelemetry {
    return { ...this.telemetry };
  }

  lastPostedChip(): FinishabilityChip | null {
    return this.lastChip;
  }

  arm(input: { effort?: string | null; kpBound?: boolean; multiFileIntent?: boolean; reason?: string }): void {
    this.kpBound = input.kpBound === true;
    this.multiFileIntent = input.multiFileIntent === true;
    this.effort = input.effort ?? null;
    if (
      !shouldArmFinishability({
        kpBound: this.kpBound,
        multiFileIntent: this.multiFileIntent
      })
    ) {
      this.phase = 'inactive';
      this.lastChip = null;
      return;
    }
    this.phase = 'armed';
    const d = this.snapshot();
    this.lastChip = d.chip;
    this.emit({
      type: 'arm',
      message: input.reason ?? `Finishability armed (effort=${d.effort})`,
      chip: d.chip,
      log: formatFinishabilityLog({
        action: 'arm',
        effort: d.effort,
        estimatePct: d.estimatePct,
        remainingPct: d.remainingPct,
        factor: this.cfg.safetyFactor,
        hits: this.telemetry.hits,
        overrides: this.telemetry.overrides,
        postOverride429: this.telemetry.postOverride429
      })
    });
  }

  noteRateWindow(input: {
    fiveHourRemainingPct?: number | null;
    sevenDayRemainingPct?: number | null;
  }): void {
    if (input.fiveHourRemainingPct !== undefined) {
      this.fiveHourRemainingPct = input.fiveHourRemainingPct;
    }
    if (input.sevenDayRemainingPct !== undefined) {
      this.sevenDayRemainingPct = input.sevenDayRemainingPct;
    }
    if (this.phase === 'inactive') return;
    const d = this.snapshot();
    this.lastChip = d.chip;
  }

  noteQuotaError(): void {
    if (this.phase !== 'overridden') return;
    this.telemetry.postOverride429 += 1;
    const d = this.snapshot();
    this.emit({
      type: 'quota',
      message: `Quota/429 after finishability override (${this.telemetry.postOverride429})`,
      chip: d.chip,
      log: formatFinishabilityLog({
        action: 'quota',
        effort: d.effort,
        estimatePct: d.estimatePct,
        remainingPct: d.remainingPct,
        factor: this.cfg.safetyFactor,
        hits: this.telemetry.hits,
        overrides: this.telemetry.overrides,
        postOverride429: this.telemetry.postOverride429
      })
    });
  }

  /**
   * First-Write gate. Subsequent writes after allow/override/shrink pass.
   * Rebound stays blocked until override or shrink.
   */
  allowWrite(path: string): boolean {
    if (this.phase === 'inactive') return true;
    const d = this.snapshot();
    if (d.verdict === 'allow') {
      if (this.phase === 'armed') {
        this.phase = 'passed';
        const passed = this.snapshot();
        this.lastChip = passed.chip;
        this.emit({
          type: 'allow',
          message: passed.reason,
          chip: passed.chip,
          path,
          log: formatFinishabilityLog({
            action: 'allow',
            effort: passed.effort,
            estimatePct: passed.estimatePct,
            remainingPct: passed.remainingPct,
            factor: this.cfg.safetyFactor,
            hits: this.telemetry.hits,
            overrides: this.telemetry.overrides,
            postOverride429: this.telemetry.postOverride429
          })
        });
      }
      return true;
    }
    if (this.phase !== 'gated' && this.phase !== 'rebound') {
      this.phase = 'gated';
      this.telemetry.hits += 1;
    }
    this.lastChip = d.chip;
    this.emit({
      type: 'deny',
      message: `Write blocked by finishability preflight (${path}): ${d.reason}`,
      chip: d.chip,
      path,
      log: formatFinishabilityLog({
        action: 'deny',
        effort: d.effort,
        estimatePct: d.estimatePct,
        remainingPct: d.remainingPct,
        factor: this.cfg.safetyFactor,
        hits: this.telemetry.hits,
        overrides: this.telemetry.overrides,
        postOverride429: this.telemetry.postOverride429
      })
    });
    return false;
  }

  applyDecision(action: FinishabilityAction): FinishabilityChip | null {
    if (action === 'block') {
      this.phase = 'gated';
      const d = this.snapshot();
      this.lastChip = d.chip;
      return d.chip;
    }
    if (action === 'override') {
      this.phase = 'overridden';
      this.telemetry.overrides += 1;
      const d = this.snapshot();
      this.lastChip = d.chip;
      this.emit({
        type: 'override',
        message: 'Finishability override — first Write allowed for this session.',
        chip: d.chip,
        log: formatFinishabilityLog({
          action: 'override',
          effort: d.effort,
          estimatePct: d.estimatePct,
          remainingPct: d.remainingPct,
          factor: this.cfg.safetyFactor,
          hits: this.telemetry.hits,
          overrides: this.telemetry.overrides,
          postOverride429: this.telemetry.postOverride429
        })
      });
      return d.chip;
    }
    if (action === 'rebind') {
      this.phase = 'rebound';
      this.telemetry.rebinds += 1;
      const d = this.snapshot();
      this.lastChip = d.chip;
      this.emit({
        type: 'rebind',
        message:
          'Finishability rebind — pick another backend from the header. Writes stay blocked until override or shrink.',
        chip: d.chip,
        log: formatFinishabilityLog({
          action: 'rebind',
          effort: d.effort,
          estimatePct: d.estimatePct,
          remainingPct: d.remainingPct,
          factor: this.cfg.safetyFactor,
          hits: this.telemetry.hits,
          overrides: this.telemetry.overrides,
          postOverride429: this.telemetry.postOverride429
        })
      });
      return d.chip;
    }
    this.phase = 'shrunk';
    this.telemetry.shrinks += 1;
    const d = this.snapshot();
    this.lastChip = d.chip;
    this.emit({
      type: 'shrink',
      message: 'Finishability shrink — investigate-only; this gate no longer blocks writes.',
      chip: d.chip,
      log: formatFinishabilityLog({
        action: 'shrink',
        effort: d.effort,
        estimatePct: d.estimatePct,
        remainingPct: d.remainingPct,
        factor: this.cfg.safetyFactor,
        hits: this.telemetry.hits,
        overrides: this.telemetry.overrides,
        postOverride429: this.telemetry.postOverride429
      })
    });
    return d.chip;
  }

  snapshot(): FinishabilityDecision {
    return evaluateFinishability({
      kpBound: this.kpBound,
      multiFileIntent: this.multiFileIntent,
      effort: this.effort,
      fiveHourRemainingPct: this.fiveHourRemainingPct,
      sevenDayRemainingPct: this.sevenDayRemainingPct,
      safetyFactor: this.cfg.safetyFactor,
      firstWriteDone: this.phase === 'passed',
      overridden: this.phase === 'overridden',
      shrunk: this.phase === 'shrunk',
      phase: this.phase
    });
  }

  private emit(e: FinishabilityEvent): void {
    this.onEvent?.(e);
  }
}
