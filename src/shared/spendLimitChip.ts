/**
 * Spend-limit parity chip — host chrome for Claude Code 2.1.251 `/usage`
 * spend-limit bar semantics, normalized across ACP backends.
 *
 * Source of truth is a status / statusline-shaped payload with
 * `rate_limits.spend_limit.{used_percentage,resets_at}` (Claude apps
 * gateway + Pro/Max statusline). Missing backends must show `n/a` —
 * never invent spend math or fake 100% remaining.
 *
 * Distinct from parked prompt-cache hit meter and dual-window forecast
 * chips (5h/7d). This slice only surfaces the spend_limit window.
 */

/** Claude statusline / gateway warn thresholds (used %). */
export const SPEND_LIMIT_WARN_AT = 75;
export const SPEND_LIMIT_CRITICAL_AT = 95;

export interface SpendLimitChip {
  /** False when the vendor omitted spend_limit — chip shows n/a. */
  available: boolean;
  /** Cap used, 0–100+ (Claude allows >100 once over). Null when n/a. */
  usedPercentage: number | null;
  /** Remaining = max(0, 100 − used). Null when n/a; 0 when over. */
  remainingPercentage: number | null;
  /** Unix epoch seconds when the spend period resets; null when unknown. */
  resetsAt: number | null;
  /** Short chip label, e.g. `spend 37% left`, `spend n/a`, `spend over`. */
  label: string;
  /** Amber when used ≥ 75% or over limit. */
  warn: boolean;
  /** Tooltip reason when warn is true. */
  warnReason?: string;
}

/** Loose status / statusline / ACP _meta shape that may carry rate_limits. */
export interface SpendLimitStatusFields {
  rate_limits?: unknown;
  rateLimits?: unknown;
  _meta?: { rate_limits?: unknown; rateLimits?: unknown };
}

interface LimitWindow {
  used_percentage?: unknown;
  usedPercentage?: unknown;
  resets_at?: unknown;
  resetsAt?: unknown;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asEpochSeconds(v: unknown): number | null {
  const n = asFiniteNumber(v);
  if (n == null || n <= 0) return null;
  // Accept ms accidentally; Claude docs use seconds.
  if (n > 1e12) return Math.floor(n / 1000);
  return Math.floor(n);
}

function pickRateLimits(status: SpendLimitStatusFields | null | undefined): Record<string, unknown> | null {
  if (!status || typeof status !== 'object') return null;
  const top = status.rate_limits ?? status.rateLimits;
  if (top && typeof top === 'object') return top as Record<string, unknown>;
  const meta = status._meta;
  if (meta && typeof meta === 'object') {
    const nested = meta.rate_limits ?? meta.rateLimits;
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }
  return null;
}

function pickSpendWindow(rateLimits: Record<string, unknown> | null): LimitWindow | null {
  if (!rateLimits) return null;
  const raw = rateLimits.spend_limit ?? rateLimits.spendLimit;
  if (!raw || typeof raw !== 'object') return null;
  return raw as LimitWindow;
}

function readUsed(window: LimitWindow): number | null {
  return asFiniteNumber(window.used_percentage ?? window.usedPercentage);
}

function readResetsAt(window: LimitWindow): number | null {
  return asEpochSeconds(window.resets_at ?? window.resetsAt);
}

/** Format resets_at for tooltips; undefined when absent. */
export function formatSpendLimitReset(resetsAt: number | null | undefined): string | undefined {
  if (resetsAt == null || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  try {
    return new Date(resetsAt * 1000).toLocaleString();
  } catch {
    return undefined;
  }
}

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Build the header chip from a Claude statusline / ACP status payload.
 * Never throws — omitted spend_limit → available:false / `spend n/a`.
 */
export function evaluateSpendLimitChip(
  status: SpendLimitStatusFields | null | undefined
): SpendLimitChip {
  const window = pickSpendWindow(pickRateLimits(status));
  if (!window) {
    return {
      available: false,
      usedPercentage: null,
      remainingPercentage: null,
      resetsAt: null,
      label: 'spend n/a',
      warn: false
    };
  }

  const used = readUsed(window);
  const resetsAt = readResetsAt(window);

  // Window object present but no usable percentage → still n/a (never fake 100%).
  if (used == null) {
    return {
      available: false,
      usedPercentage: null,
      remainingPercentage: null,
      resetsAt,
      label: 'spend n/a',
      warn: false
    };
  }

  const remaining = roundPct(Math.max(0, 100 - used));
  const over = used > 100;
  const warn = used >= SPEND_LIMIT_WARN_AT || over;

  let label: string;
  if (over) label = 'spend over';
  else label = `spend ${remaining}% left`;

  let warnReason: string | undefined;
  if (over) {
    warnReason = `Spend limit exceeded (${roundPct(used)}% used).`;
  } else if (used >= SPEND_LIMIT_CRITICAL_AT) {
    warnReason = `Spend limit nearly exhausted (${roundPct(used)}% used).`;
  } else if (used >= SPEND_LIMIT_WARN_AT) {
    warnReason = `Approaching spend limit (${roundPct(used)}% used).`;
  }

  return {
    available: true,
    usedPercentage: roundPct(used),
    remainingPercentage: remaining,
    resetsAt,
    label,
    warn,
    ...(warnReason ? { warnReason } : {})
  };
}

