// Session changes ledger — pure fold over tool-call updates that answers
// "what has this session changed so far" as one row per touched file.
//
// Design rules (locked in kp: tasks/cb-session-changes-ledger-aggregate-per-file-edi):
// - Only status=completed edit-class tool calls mutate the ledger; failed or
//   still-running calls contribute nothing.
// - Baselines come from a store captured at first sight of a path (BEFORE the
//   write lands), never from diff-record oldText — webview text can be
//   truncated, and with claude stream-json the write may precede the record.
//   A second edit to the same path must not overwrite the baseline.
// - +/- counts are always baseline-vs-current-disk line diffs, never a sum of
//   per-record micro-diffs.
// - Rows are keyed by a normalized absolute path so `./x` and `/abs/.../x`
//   collapse to one entry, making replay order-independent by path.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { diffStats } from '../shared/diff';
import type { ContentBlock, SessionUpdate, ToolCall } from '../shared/acpTypes';

export type LedgerFileStatus = 'A' | 'M' | 'D';

export interface LedgerRow {
  /** Normalized absolute path (the map key, repeated for convenience). */
  path: string;
  status: LedgerFileStatus;
  /** Number of completed edit-class tool calls that touched this file. */
  editCount: number;
  /** Line counts of baseline-vs-current-disk, not summed micro-diffs. */
  added: number;
  removed: number;
  /** Set when the file changed on disk outside the agent (OOB edit). */
  stale?: boolean;
}

/** Keyed by normalized absolute path. */
export type SessionLedger = Map<string, LedgerRow>;

/** Filesystem access the fold needs — injectable for tests. */
export interface LedgerFs {
  /** File text, or null when the file does not exist. */
  readFile(absPath: string): string | null;
  /** Resolved real path, or null when the path does not exist (yet). */
  realpath?(absPath: string): string | null;
}

export const nodeLedgerFs: LedgerFs = {
  readFile(absPath) {
    try {
      return fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }
  },
  realpath(absPath) {
    try {
      return fs.realpathSync(absPath);
    } catch {
      return null;
    }
  },
};

/**
 * First-touch baseline store. `content: null` means the file did not exist
 * when first touched (Write-new → status A; restore = delete).
 */
export interface BaselineStore {
  get(pathKey: string): { content: string | null } | undefined;
  /** Records a baseline only if the key has none yet; returns true when captured. */
  captureIfAbsent(pathKey: string, content: string | null): boolean;
}

/** In-memory BaselineStore (sidecar-backed persistence lands in a later slice). */
export function createBaselineStore(): BaselineStore {
  const map = new Map<string, { content: string | null }>();
  return {
    get: (key) => map.get(key),
    captureIfAbsent(key, content) {
      if (map.has(key)) return false;
      map.set(key, { content });
      return true;
    },
  };
}

/** Stable content-address for sidecar baseline filenames. */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * One path, one key: resolve against the session cwd, then collapse through
 * realpath so symlinked spellings match direct ones. The key must be STABLE
 * across the file's lifecycle — first touch may happen before the file exists
 * (Write-new) — so when the file itself can't be realpath'd we realpath the
 * nearest existing ancestor and rejoin the remainder. Otherwise a pre-write
 * key (`/tmp/x`) and post-write key (`/private/tmp/x`) would split one file
 * into two rows and orphan its baseline.
 */
export function normalizePathKey(p: string, cwd: string, ledgerFs?: LedgerFs): string {
  const resolved = path.resolve(cwd, p);
  if (!ledgerFs?.realpath) return resolved;
  let dir = resolved;
  const tail: string[] = [];
  while (true) {
    const real = ledgerFs.realpath(dir);
    if (real !== null && real !== undefined) return path.join(real, ...tail);
    const parent = path.dirname(dir);
    if (parent === dir) return resolved; // hit the root without resolving
    tail.unshift(path.basename(dir));
    dir = parent;
  }
}

/** Beyond this size the O(n·m) LCS would stall the extension host. */
const LCS_MAX_BYTES = 1_000_000;

/**
 * diffStats with a large-file escape hatch: past LCS_MAX_BYTES fall back to a
 * cheap line-count delta (the "line-set count fallback" the design allows) so
 * a multi-megabyte edit can't freeze the host on every fold.
 */
export function ledgerDiffStats(oldText: string, newText: string): { added: number; removed: number } {
  if (oldText.length > LCS_MAX_BYTES || newText.length > LCS_MAX_BYTES) {
    const oldLines = oldText === '' ? 0 : oldText.split('\n').length;
    const newLines = newText === '' ? 0 : newText.split('\n').length;
    return { added: Math.max(0, newLines - oldLines), removed: Math.max(0, oldLines - newLines) };
  }
  return diffStats(oldText, newText);
}

function isCompleted(tc: Pick<ToolCall, 'status'>): boolean {
  return tc.status === 'completed';
}

function diffBlocks(content: ContentBlock[] | undefined): Extract<ContentBlock, { type: 'diff' }>[] {
  return (content ?? []).filter((b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff');
}

/** Edit-class = classified kind 'edit' or carrying diff content blocks. */
export function isEditToolCall(tc: ToolCall): boolean {
  return tc.kind === 'edit' || diffBlocks(tc.content).length > 0;
}

/** Raw (un-normalized) file paths an edit-class tool call touched. */
export function editedPaths(tc: ToolCall): string[] {
  const fromDiffs = diffBlocks(tc.content).map((b) => b.path);
  const fromLocations = tc.kind === 'edit' ? (tc.locations ?? []).map((l) => l.path) : [];
  return [...new Set([...fromDiffs, ...fromLocations])];
}

export interface FoldOptions {
  cwd: string;
  fs: LedgerFs;
  baselines: BaselineStore;
}

/**
 * Fold one tool call into the ledger. Mutates `ledger` in place and returns
 * true when anything changed. Non-completed / failed / non-edit calls are a
 * strict no-op.
 */
export function foldToolCall(ledger: SessionLedger, tc: ToolCall, opts: FoldOptions): boolean {
  if (!isCompleted(tc) || !isEditToolCall(tc)) return false;
  let mutated = false;
  // Dedupe AFTER normalization: `./a.ts` from a diff block and `/abs/a.ts`
  // from locations are one file and must count as one edit.
  const keys = new Set(editedPaths(tc).map((raw) => normalizePathKey(raw, opts.cwd, opts.fs)));
  for (const key of keys) {
    const current = opts.fs.readFile(key);
    let baseline = opts.baselines.get(key);
    if (!baseline) {
      // Degraded fallback: capture was supposed to happen at first *pending*
      // sight of the path (before the write). If it didn't, adopt the current
      // disk state as baseline (0/0, status M) rather than inventing an "A
      // with the whole file added" lie.
      opts.baselines.captureIfAbsent(key, current);
      baseline = opts.baselines.get(key);
    }
    const baselineContent = baseline ? baseline.content : null;
    if (baselineContent === null && current === null) {
      // Created then deleted within the session (or never materialized):
      // net-zero — drop any existing row instead of pinning a stale 'A'.
      if (ledger.delete(key)) mutated = true;
      continue;
    }
    const status: LedgerFileStatus = baselineContent === null ? 'A' : current === null ? 'D' : 'M';
    const { added, removed } = ledgerDiffStats(baselineContent ?? '', current ?? '');
    const prev = ledger.get(key);
    ledger.set(key, {
      path: key,
      status,
      editCount: (prev?.editCount ?? 0) + 1,
      added,
      removed,
      ...(prev?.stale ? { stale: true } : {}),
    });
    mutated = true;
  }
  return mutated;
}

/**
 * Rebuild the ledger from a stored transcript (historyLoaded replay). Coalesces
 * tool_call + tool_call_update records by toolCallId — only the merged final
 * state is folded, so partial updates and out-of-order chunks cannot
 * double-count. Baselines still come only from the store, never the records.
 */
export function replayLedger(updates: SessionUpdate[], opts: FoldOptions): SessionLedger {
  // Bases and overrides are collected separately and merged base-first, so a
  // tool_call_update that happens to precede its tool_call record in the
  // stored array still lands on top of it (order-independent replay).
  const bases = new Map<string, ToolCall>();
  const overrides = new Map<string, Partial<ToolCall>[]>();
  for (const u of updates) {
    if (u.kind === 'tool_call') {
      bases.set(u.toolCall.toolCallId, u.toolCall);
    } else if (u.kind === 'tool_call_update') {
      const list = overrides.get(u.toolCall.toolCallId) ?? [];
      list.push(u.toolCall);
      overrides.set(u.toolCall.toolCallId, list);
    }
  }
  const ledger: SessionLedger = new Map();
  const ids = new Set([...bases.keys(), ...overrides.keys()]);
  for (const id of ids) {
    const base = bases.get(id) ?? ({ toolCallId: id, title: '', status: 'pending' } as ToolCall);
    const merged = (overrides.get(id) ?? []).reduce<ToolCall>((acc, o) => ({ ...acc, ...o }), base);
    foldToolCall(ledger, merged, opts);
  }
  return ledger;
}
