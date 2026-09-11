/**
 * Pre/Post model-switch host hook bus
 * (kp: ideas/cb-pre-post-model-switch-host-hook-bus-block-con)
 *
 * Host gate for ACP model-identity changes (composer picker / explicit
 * override). Default policy confirms with estimated re-cache tokens (or
 * "unknown") before the switch commits. Block keeps the prior model.
 *
 * Distinct from overload/unavailable failover (529) and rate-limit
 * handoff — those are backend swaps, not a model-identity change.
 * Must not invent cache economics: tokens come from existing session
 * cache/input telemetry; dollars stay "unknown" unless a caller already
 * has a cost figure (this module never derives $/token).
 *
 * Pure / vscode-free so unit tests can mock ACP initialize + override.
 */

import { formatCacheTokens } from './cacheMissChip';

export type ModelSwitchPolicy = 'allow' | 'confirm' | 'block';

/** Who asked for the model change. Failover is never gated here. */
export type ModelSwitchSource = 'picker' | 'override' | 'failover';

export type ModelSwitchAction = 'allow' | 'confirm' | 'block' | 'noop';

export interface RecacheEstimate {
  /** Warm-cache / prompt tokens expected to miss. Null = unknown. */
  tokens: number | null;
  /** USD figure. Always null here — never invented. */
  dollars: number | null;
}

export interface ModelSwitchChip {
  available: boolean;
  /** e.g. `switch · ~4.2k re-cache`, `switch · unknown re-cache`. */
  label: string;
  fromModel: string | null;
  toModel: string;
  estimatedTokens: number | null;
  measuredMissTokens: number | null;
  warn: boolean;
  warnReason?: string;
}

export interface ModelSwitchRecord {
  from?: string;
  to: string;
  at: number;
  estimatedTokens: number | null;
  measuredMissTokens: number | null;
}

export interface ModelSwitchDialog {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

export interface ModelSwitchDecision {
  action: ModelSwitchAction;
  fromModel: string | undefined;
  toModel: string;
  estimate: RecacheEstimate;
  reason?: string;
  notice?: string;
  dialog?: ModelSwitchDialog;
}

export interface ModelSwitchApplyInput {
  policy: ModelSwitchPolicy | unknown;
  fromModel: string | undefined;
  toModel: string;
  source: ModelSwitchSource;
  /** Last observed cache-read tokens (warm prefix). */
  cacheReadTokens?: number | null;
  lastMissTokens?: number | null;
  inputTokens?: number | null;
  /** User approved the confirm dialog. Ignored unless policy is confirm. */
  confirmed?: boolean;
  now?: number;
}

export interface ModelSwitchApplyResult extends ModelSwitchDecision {
  /** True only when the new model should be committed on session meta. */
  applied: boolean;
  /** Alias of `applied` — confirm path must stay false until approved. */
  sent: boolean;
  chip: ModelSwitchChip | null;
  record: ModelSwitchRecord | null;
}

export interface CacheTelemetry {
  cacheReadTokens?: number | null;
  lastMissTokens?: number | null;
  inputTokens?: number | null;
}

const DEFAULT_POLICY: ModelSwitchPolicy = 'confirm';
const SWITCH_LABEL = 'Switch';
const CANCEL_LABEL = 'Cancel';

export function parseModelSwitchPolicy(raw: unknown): ModelSwitchPolicy {
  if (raw === 'allow' || raw === 'confirm' || raw === 'block') return raw;
  return DEFAULT_POLICY;
}

/** Collapse empty / default / auto to a comparable id. */
export function normalizeModelId(model: string | undefined | null): string {
  if (model == null) return '';
  const t = String(model).trim();
  if (!t || t === 'default' || t === 'auto') return '';
  return t;
}

export function estimateRecache(tel: CacheTelemetry | null | undefined): RecacheEstimate {
  if (!tel) return { tokens: null, dollars: null };
  const cacheRead = asNonNeg(tel.cacheReadTokens);
  const input = asNonNeg(tel.inputTokens);
  const miss = asNonNeg(tel.lastMissTokens);
  // Prefer the warm cache that a model change would invalidate. Fall
  // back to last prompt size. Never invent a dollar figure.
  const tokens = cacheRead ?? input ?? miss;
  return { tokens, dollars: null };
}

export function formatRecacheTokens(tokens: number | null): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return 'unknown';
  return `~${formatCacheTokens(tokens)}`;
}

export function formatRecacheCost(dollars: number | null): string {
  if (dollars == null || !Number.isFinite(dollars) || dollars < 0) return 'unknown';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

export function formatModelSwitchChipLabel(
  estimate: RecacheEstimate,
  measuredMissTokens?: number | null
): string {
  const n = measuredMissTokens != null ? measuredMissTokens : estimate.tokens;
  const tok = formatRecacheTokens(n);
  return tok === 'unknown' ? 'switch · unknown re-cache' : `switch · ${tok} re-cache`;
}

export function modelSwitchChip(
  record: Pick<ModelSwitchRecord, 'from' | 'to' | 'estimatedTokens' | 'measuredMissTokens'>
): ModelSwitchChip {
  const estimate: RecacheEstimate = {
    tokens: record.estimatedTokens,
    dollars: null
  };
  const measured = record.measuredMissTokens ?? null;
  const label = formatModelSwitchChipLabel(estimate, measured);
  const warn = (measured ?? record.estimatedTokens ?? 0) >= 10_000;
  const chip: ModelSwitchChip = {
    available: true,
    label,
    fromModel: record.from ?? null,
    toModel: record.to,
    estimatedTokens: record.estimatedTokens,
    measuredMissTokens: measured,
    warn
  };
  if (warn) {
    chip.warnReason =
      measured != null
        ? `Measured cache miss after switch: ${formatRecacheTokens(measured)} tokens.`
        : `Estimated re-cache on switch: ${formatRecacheTokens(record.estimatedTokens)} tokens.`;
  }
  return chip;
}

export function formatModelSwitchDialog(
  fromModel: string | undefined,
  toModel: string,
  estimate: RecacheEstimate
): ModelSwitchDialog {
  const from = normalizeModelId(fromModel) || 'current model';
  const to = normalizeModelId(toModel) || toModel || 'new model';
  const tok = formatRecacheTokens(estimate.tokens);
  const usd = formatRecacheCost(estimate.dollars);
  return {
    title: `Switch model from ${from} to ${to}?`,
    detail:
      `Estimated re-cache: ${tok} tokens · $ ${usd}. ` +
      'Prompt cache for the current model will miss. ' +
      'Distinct from overload failover. codeBuild.modelSwitchPolicy',
    confirmLabel: SWITCH_LABEL,
    cancelLabel: CANCEL_LABEL
  };
}

export function formatModelSwitchTooltip(chip: ModelSwitchChip): string {
  const lines: string[] = [chip.label];
  if (chip.fromModel || chip.toModel) {
    lines.push(`From: ${chip.fromModel || 'default'} → ${chip.toModel}`);
  }
  if (chip.estimatedTokens != null) {
    lines.push(`Estimated re-cache: ${formatRecacheTokens(chip.estimatedTokens)} tokens`);
  }
  if (chip.measuredMissTokens != null) {
    lines.push(`Measured miss: ${formatRecacheTokens(chip.measuredMissTokens)} tokens`);
  }
  if (chip.estimatedTokens == null && chip.measuredMissTokens == null) {
    lines.push('Re-cache estimate unknown — backend did not expose cache/input telemetry.');
  }
  if (chip.warnReason) lines.push(chip.warnReason);
  lines.push(
    'Host Pre/Post model-switch gate. Does not invent cache economics. ' +
      'Distinct from 529/overload failover. codeBuild.modelSwitchPolicy'
  );
  return lines.join('\n');
}

export function evaluatePreModelSwitch(input: {
  policy: ModelSwitchPolicy | unknown;
  fromModel: string | undefined;
  toModel: string;
  source: ModelSwitchSource;
  estimate: RecacheEstimate;
  hasTelemetry?: boolean;
}): ModelSwitchDecision {
  const policy = parseModelSwitchPolicy(input.policy);
  const from = normalizeModelId(input.fromModel);
  const to = normalizeModelId(input.toModel) || String(input.toModel ?? '').trim();
  const estimate = input.estimate;

  if (!to || from === to) {
    return {
      action: 'noop',
      fromModel: input.fromModel,
      toModel: input.toModel,
      estimate,
      reason: 'same model'
    };
  }

  // Failover (529/overload) is a backend swap — never this gate.
  if (input.source === 'failover') {
    return {
      action: 'allow',
      fromModel: input.fromModel,
      toModel: input.toModel,
      estimate,
      reason: 'failover source skipped'
    };
  }

  // First pick before any turns: nothing warm to lose.
  if (!from && input.hasTelemetry !== true) {
    return {
      action: 'noop',
      fromModel: input.fromModel,
      toModel: input.toModel,
      estimate,
      reason: 'initial model pick'
    };
  }

  if (policy === 'allow') {
    return {
      action: 'allow',
      fromModel: input.fromModel,
      toModel: input.toModel,
      estimate
    };
  }

  if (policy === 'block') {
    const kept = from || 'prior model';
    const notice =
      `Model switch blocked — codeBuild.modelSwitchPolicy=block (kept ${kept})`;
    return {
      action: 'block',
      fromModel: input.fromModel,
      toModel: input.toModel,
      estimate,
      reason: 'policy=block',
      notice
    };
  }

  return {
    action: 'confirm',
    fromModel: input.fromModel,
    toModel: input.toModel,
    estimate,
    dialog: formatModelSwitchDialog(input.fromModel, to, estimate)
  };
}

/**
 * Decide + optionally commit a model switch. Confirm without `confirmed`
 * does not apply (sent=false). Block never applies.
 */
export function applyModelSwitch(input: ModelSwitchApplyInput): ModelSwitchApplyResult {
  const estimate = estimateRecache({
    cacheReadTokens: input.cacheReadTokens,
    lastMissTokens: input.lastMissTokens,
    inputTokens: input.inputTokens
  });
  const hasTelemetry =
    estimate.tokens != null ||
    asNonNeg(input.cacheReadTokens) != null ||
    asNonNeg(input.inputTokens) != null ||
    asNonNeg(input.lastMissTokens) != null;
  const decision = evaluatePreModelSwitch({
    policy: input.policy,
    fromModel: input.fromModel,
    toModel: input.toModel,
    source: input.source,
    estimate,
    hasTelemetry
  });

  if (decision.action === 'noop' || decision.action === 'block') {
    return { ...decision, applied: false, sent: false, chip: null, record: null };
  }
  if (decision.action === 'confirm' && input.confirmed !== true) {
    return { ...decision, applied: false, sent: false, chip: null, record: null };
  }

  const record: ModelSwitchRecord = {
    ...(normalizeModelId(input.fromModel)
      ? { from: normalizeModelId(input.fromModel) }
      : {}),
    to: normalizeModelId(input.toModel) || input.toModel,
    at: input.now ?? Date.now(),
    estimatedTokens: estimate.tokens,
    measuredMissTokens: null
  };
  return {
    ...decision,
    applied: true,
    sent: true,
    chip: modelSwitchChip(record),
    record
  };
}

/** Fold the next turn's cache miss into a pending switch record. */
export function measurePostSwitchMiss(
  pending: ModelSwitchRecord,
  next: CacheTelemetry
): ModelSwitchRecord {
  const measured =
    asNonNeg(next.lastMissTokens) ??
    asNonNeg(next.inputTokens) ??
    pending.estimatedTokens;
  return {
    ...pending,
    measuredMissTokens: measured ?? null
  };
}

/**
 * Session-scoped latch: last cache telemetry, pending post-hook, last chip.
 * Host observes cache_miss_update / usage then calls apply() on setModel.
 */
export class ModelSwitchTracker {
  lastCacheReadTokens: number | null = null;
  lastMissTokens: number | null = null;
  lastInputTokens: number | null = null;
  pending: ModelSwitchRecord | null = null;
  lastChip: ModelSwitchChip | null = null;
  lastRecord: ModelSwitchRecord | null = null;

  /** Latch last cache/input telemetry without consuming a pending switch. */
  noteTelemetry(tel: CacheTelemetry): void {
    const cr = asNonNeg(tel.cacheReadTokens);
    const miss = asNonNeg(tel.lastMissTokens);
    const input = asNonNeg(tel.inputTokens);
    if (cr != null) this.lastCacheReadTokens = cr;
    if (miss != null) this.lastMissTokens = miss;
    if (input != null) this.lastInputTokens = input;
  }

  /** Latch telemetry and, if a switch is pending, fold the measured miss. */
  observeCache(tel: CacheTelemetry): ModelSwitchChip | null {
    this.noteTelemetry(tel);
    if (!this.pending) return null;
    const updated = measurePostSwitchMiss(this.pending, {
      cacheReadTokens: this.lastCacheReadTokens,
      lastMissTokens: this.lastMissTokens,
      inputTokens: this.lastInputTokens
    });
    this.pending = null;
    this.lastRecord = updated;
    this.lastChip = modelSwitchChip(updated);
    return this.lastChip;
  }

  apply(input: Omit<ModelSwitchApplyInput, 'cacheReadTokens' | 'lastMissTokens' | 'inputTokens'> & {
    cacheReadTokens?: number | null;
    lastMissTokens?: number | null;
    inputTokens?: number | null;
  }): ModelSwitchApplyResult {
    const result = applyModelSwitch({
      ...input,
      cacheReadTokens: input.cacheReadTokens ?? this.lastCacheReadTokens,
      lastMissTokens: input.lastMissTokens ?? this.lastMissTokens,
      inputTokens: input.inputTokens ?? this.lastInputTokens
    });
    if (result.applied && result.record) {
      this.pending = result.record;
      this.lastRecord = result.record;
      this.lastChip = result.chip;
    }
    return result;
  }

  clear(): void {
    this.lastCacheReadTokens = null;
    this.lastMissTokens = null;
    this.lastInputTokens = null;
    this.pending = null;
    this.lastChip = null;
    this.lastRecord = null;
  }
}

function asNonNeg(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return n;
}
