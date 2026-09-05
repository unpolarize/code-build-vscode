// Cross-ACP failover offer (kp: ideas/cb-host-529-overload-cross-acp-failover-on-model).
//
// Pure helpers for the confirm-before-swap banner. Classifier already maps
// stream/RPC errors → overload|unavailable|quota|auth|other; this module
// decides WHETHER to offer a peer backend and WHICH one to suggest.
// Quota/auth never reach here (gated by isFailoverClass).

import type { BackendId } from './acpTypes';
import type { BackendErrorClass } from './backendErrorClass';
import { isFailoverClass } from './backendErrorClass';

/** Preferred peer order when primary is down — multi-vendor first. */
export const FAILOVER_PREFERENCE: readonly BackendId[] = [
  'grok',
  'codex',
  'claude',
  'opencode',
  'cline'
] as const;

/** Default last-N verbatim turns for the auto hybrid primer on Continue. */
export const FAILOVER_DEFAULT_LAST_N = 5;

export interface FailoverTargetInput {
  id: BackendId;
  available: boolean;
  label?: string;
}

export interface FailoverOffer {
  errorClass: 'overload' | 'unavailable';
  fromBackend: BackendId;
  fromLabel: string;
  /** Suggested continue target (preference-ordered first available peer). */
  suggestedBackend: BackendId;
  suggestedLabel: string;
  /** All available peers excluding the failing primary (for a picker). */
  alternatives: Array<{ id: BackendId; label: string }>;
  message: string;
}

export interface BuildFailoverOfferInput {
  errorClass: BackendErrorClass;
  fromBackend: BackendId;
  fromLabel?: string;
  backends: FailoverTargetInput[];
  /** Override preference order (tests). */
  preference?: readonly BackendId[];
}

const DEFAULT_LABELS: Record<BackendId, string> = {
  claude: 'Claude Code',
  grok: 'Grok',
  codex: 'Codex',
  opencode: 'opencode',
  cline: 'Cline'
};

export function backendDisplayLabel(id: BackendId, override?: string): string {
  return override || DEFAULT_LABELS[id] || id;
}

/** Banner copy keyed on error class (v1 always confirms — never silent). */
export function failoverBannerMessage(
  errorClass: 'overload' | 'unavailable',
  suggestedLabel: string
): string {
  if (errorClass === 'unavailable') {
    return `Primary unavailable — continue on ${suggestedLabel}?`;
  }
  return `Primary overloaded — continue on ${suggestedLabel}?`;
}

/**
 * Build a confirm-banner offer, or null when failover is not on the table
 * (wrong error class, or no other installed backend).
 */
export function buildFailoverOffer(input: BuildFailoverOfferInput): FailoverOffer | null {
  if (!isFailoverClass(input.errorClass)) return null;
  const errorClass = input.errorClass as 'overload' | 'unavailable';

  const preference = input.preference ?? FAILOVER_PREFERENCE;
  const byId = new Map(input.backends.map((b) => [b.id, b]));

  const alternatives: Array<{ id: BackendId; label: string }> = [];
  for (const id of preference) {
    if (id === input.fromBackend) continue;
    const b = byId.get(id);
    if (!b?.available) continue;
    alternatives.push({
      id,
      label: backendDisplayLabel(id, b.label)
    });
  }
  // Include any available backends not in the preference list (future ids).
  for (const b of input.backends) {
    if (b.id === input.fromBackend || !b.available) continue;
    if (alternatives.some((a) => a.id === b.id)) continue;
    alternatives.push({ id: b.id, label: backendDisplayLabel(b.id, b.label) });
  }

  if (alternatives.length === 0) return null;

  const suggested = alternatives[0];
  const fromLabel = backendDisplayLabel(input.fromBackend, input.fromLabel);
  return {
    errorClass,
    fromBackend: input.fromBackend,
    fromLabel,
    suggestedBackend: suggested.id,
    suggestedLabel: suggested.label,
    alternatives,
    message: failoverBannerMessage(errorClass, suggested.label)
  };
}
