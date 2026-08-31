// Pure /compact building blocks — idle guard, marker, primer, lineage,
// respawn resume-id rule. Kept free of vscode/store imports so the compact
// contract is unit-testable outside SessionManager (same pattern as
// backendIdentity.ts).

import type { CompactMarker, SessionMeta } from '../shared/protocol';
import { extractTurns } from './persistence/conversationSerializer';

type Record_ = { type: string; text?: string; update?: any };

/** Everything the idle guard needs, snapshotted from SessionManager state.
 * /compact kills the backend process — any in-flight work would be lost, so
 * the guard must stay strict (a marker landing mid-turn would also corrupt
 * the files-card turn grouping). */
export interface CompactIdleFlags {
  /** Stall watchdog is watching a turn (armed at prompt, cleared on result/error). */
  turnActive: boolean;
  openToolCalls: number;
  awaitingPermission: boolean;
  pendingQuestions: number;
  primerPending: boolean;
  queuedPrompt: boolean;
}

/** Why /compact must refuse right now, or undefined when the session is idle. */
export function compactBlockReason(f: CompactIdleFlags): string | undefined {
  if (f.turnActive) return 'a turn is still running';
  if (f.openToolCalls > 0) return 'a tool call is still running';
  if (f.awaitingPermission) return 'a permission prompt is waiting for your decision';
  if (f.pendingQuestions > 0) return 'the agent is waiting on your answer to a question';
  if (f.primerPending) return 'a handoff primer is still being prepared';
  if (f.queuedPrompt) return 'a queued message is still waiting to go out';
  return undefined;
}

/** Notices-only sessions count as empty: only a real user turn makes a
 * conversation worth summarizing (matches store.hasContent semantics). */
export function hasCompactableTurns(records: Record_[]): boolean {
  return records.some((r) => r.type === 'user');
}

/** The persisted divider record. summaryPreview is capped — the full summary
 * travels as the next-prompt primer and is auditable there, not here. */
export function buildCompactMarker(args: {
  now: number;
  preTokens?: number;
  summary: string;
  focus?: string;
}): CompactMarker {
  const marker: CompactMarker = {
    at: args.now,
    summaryPreview: args.summary.trim().slice(0, 200)
  };
  if (typeof args.preTokens === 'number') marker.preTokens = args.preTokens;
  if (args.focus) marker.instructions = args.focus;
  return marker;
}

/** One-shot primer for the first prompt after the respawn: structured
 * summary + last N verbatim turns + a breadcrumb to the full host-side
 * transcript. Tone differs from the cross-backend handoff primer — this is
 * the SAME assistant continuing ITS OWN conversation after a context
 * compaction, not a handoff to a stranger. */
export function buildCompactPrimer(args: {
  records: Record_[];
  summary: string;
  backendLabel: string;
  lastNTurns?: number;
  focus?: string;
  transcriptPath?: string;
}): string {
  const turns = extractTurns(args.records);
  const n = Math.max(0, Math.min(turns.length, args.lastNTurns ?? 5));
  const recent = n > 0 ? turns.slice(-n) : [];
  const verbatimSection = recent.length
    ? `\n\n== LAST ${recent.length} TURN${recent.length === 1 ? '' : 'S'} (verbatim) ==\n` +
      recent
        .map((t) => (t.role === 'user' ? `**User:**\n${t.text}` : `**Assistant:**\n${t.text}`))
        .join('\n\n')
    : '';
  const focusLine = args.focus
    ? `\nThe user asked this compaction to focus on: ${args.focus}`
    : '';
  const breadcrumb = args.transcriptPath
    ? `\nFull pre-compact transcript (host JSONL): ${args.transcriptPath}`
    : '';
  return `<conversation-context source="${args.backendLabel}" mode="compact">
This is YOUR OWN conversation, compacted in place to reclaim context: the transcript was summarized and your process restarted at the same session. Below is:
1. A SUMMARY of the conversation so far.
${recent.length ? `2. THE LAST ${recent.length} TURN${recent.length === 1 ? '' : 'S'} verbatim, so you have fresh detail.
3. The user's next message follows immediately after this block.` : `2. The user's next message follows immediately after this block.`}${focusLine}${breadcrumb}

Use this context to inform your response. Do NOT respond to this context block directly — just answer the user's upcoming message naturally, as if nothing was interrupted.

== SUMMARY ==
${args.summary.trim()}${verbatimSection}
</conversation-context>`;
}

/** Pre-respawn lineage bookkeeping, order pinned by the KP task: make sure
 * the OLD native id is in backendSessionHistory, THEN clear
 * backendSessionId — never clear-first (a reload in the gap would mint a
 * #29 shell / lose the lineage join). The NEW id lands later via
 * applyBackendSessionId when the respawned backend announces system_init
 * (stamped reason 'compact' by the armed pendingBackendIdReason).
 * Returns true when meta changed and needs persisting. */
export function prepareCompactLineage(meta: SessionMeta): boolean {
  const old = meta.backendSessionId;
  if (!old) return false;
  if (!meta.backendSessionHistory?.some((h) => h.id === old)) {
    meta.backendSessionHistory = [
      ...(meta.backendSessionHistory ?? []),
      { id: old, ts: meta.createdAt, reason: 'initial' }
    ];
  }
  meta.backendSessionId = undefined;
  return true;
}

/** Resume id for (re)connecting to an existing session. A compact respawn
 * must NEVER receive a pre-compact resume id — not the captured
 * backendSessionId and not the imported-session fallback (where the local
 * id IS the old native id) — or the agent reloads the history we just
 * compacted away and the meter stays hot. */
export function resolveRespawnResumeId(
  meta: Pick<SessionMeta, 'id' | 'backendSessionId' | 'source'>,
  compactRespawn: boolean
): string | undefined {
  if (compactRespawn) return undefined;
  return (
    meta.backendSessionId ??
    (meta.source === 'claude' || meta.source === 'grok' ? meta.id : undefined)
  );
}
