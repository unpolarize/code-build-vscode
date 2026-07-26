// Native session identity bookkeeping: keeps SessionMeta.backendSessionId,
// backendSessionHistory and native in sync when the backend announces its id
// via system_init. Pure (no store/panel side effects) so the transition rules
// are unit-testable outside SessionManager.

import type {
  BackendSessionTransitionReason,
  NativeTranscriptFormat,
  SessionMeta
} from '../shared/protocol';
import type { BackendId } from '../shared/acpTypes';

/** Backends whose native transcript store we know how to locate. Backends
 * absent here (opencode, cline) still get id/history tracking but no
 * `native` pointer — we won't guess at a path format we haven't verified. */
const NATIVE_FORMATS: Partial<Record<BackendId, NativeTranscriptFormat>> = {
  claude: 'claude-jsonl',
  grok: 'grok-jsonl',
  codex: 'codex-rollout'
};

/**
 * Apply a `system_init` native id to the session meta. Returns true when the
 * meta changed (caller should persist + broadcast), false when the id matched
 * the current one (re-inits are frequent and must stay no-ops).
 *
 * On a change: reassigns `backendSessionId`, keeps `native.id` identical to it
 * (single source of truth), and appends `{id, ts, reason}` to
 * `backendSessionHistory`. Metas that pre-date history tracking but already
 * hold a backendSessionId get that id seeded as the 'initial' entry (stamped
 * with createdAt — the closest honest timestamp we have) so the old native
 * transcript is never orphaned from the lineage.
 */
export function applyBackendSessionId(
  meta: SessionMeta,
  newId: string,
  reason: BackendSessionTransitionReason,
  ts: number
): boolean {
  if (meta.backendSessionId === newId) return false;
  if (meta.backendSessionId && !meta.backendSessionHistory?.length) {
    meta.backendSessionHistory = [
      { id: meta.backendSessionId, ts: meta.createdAt, reason: 'initial' }
    ];
  }
  meta.backendSessionId = newId;
  meta.backendSessionHistory = [...(meta.backendSessionHistory ?? []), { id: newId, ts, reason }];
  const format = NATIVE_FORMATS[meta.backend];
  if (format) {
    meta.native = { format, id: newId };
  }
  return true;
}
