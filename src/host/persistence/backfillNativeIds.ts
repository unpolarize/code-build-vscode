// Offline backfill for pre-dual-write transcripts: derive backendSessionId /
// backendSessionHistory / native for sessions written before the capture path
// persisted them, by replaying the `system_init` updates already present in
// each ~/.codebuild jsonl. Fixtures-first and fail-closed: dry-run is the
// default everywhere, and writing to the LIVE ~/.codebuild additionally
// requires an explicit allowLive opt-in on top of write.
//
// Hard rules (mirrors the capture path in backendIdentity.ts):
// - Never invent ids: a transcript with zero system_init lines is left alone.
// - Never overwrite: an existing backendSessionId that disagrees with the
//   transcript is reported as a conflict, not clobbered; existing history is
//   never rewritten.
// - History = distinct-id changes only (first id 'initial', later 'respawn' —
//   compaction vs model-change respawns are indistinguishable after the fact).
// - Transition ts uses meta.createdAt: update lines carry no timestamps, and
//   inventing per-transition times would be a lie the join contract could
//   trip over. createdAt is the same "closest honest timestamp" the live
//   seeding path uses for legacy metas.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BackendSessionTransition, SessionMeta } from '../../shared/protocol';
import { nativeFormatFor } from '../backendIdentity';
import { mergeSessionMeta } from './store';

export type BackfillStatus =
  /** system_init found and meta was missing some/all identity fields. */
  | 'fixable'
  /** meta already agrees with the transcript — nothing to do. */
  | 'ok'
  /** no system_init in the transcript — no id to backfill, left alone. */
  | 'no-init'
  /** meta.backendSessionId disagrees with the transcript's last id. */
  | 'conflict'
  /** unreadable / headerless transcript. */
  | 'unreadable';

export interface BackfillSessionResult {
  id: string;
  status: BackfillStatus;
  /** The patch that was (or would be, in dry-run) applied. */
  patch?: Partial<SessionMeta>;
  written: boolean;
}

export interface BackfillReport {
  root: string;
  dryRun: boolean;
  /** Set when a live-root write was requested without allowLive. */
  refused?: string;
  sessions: BackfillSessionResult[];
  /** Deterministic one-line summary for logs / CLI output. */
  summary: string;
}

/** Native-id CHANGE sequence from raw transcript lines: consecutive re-inits
 * with the same id collapse (they're no-ops live too), but a REVISITED id
 * (a → b → a via native resume) stays — mirroring applyBackendSessionId,
 * which appends to history on every change. The last element is therefore
 * always the transcript's true final native id. */
export function nativeIdChanges(lines: string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        update?: { kind?: string; backendSessionId?: string };
      };
      if (rec.type !== 'update' || rec.update?.kind !== 'system_init') continue;
      const id = rec.update.backendSessionId;
      if (id && ids[ids.length - 1] !== id) ids.push(id);
    } catch {
      /* skip corrupt line */
    }
  }
  return ids;
}

/**
 * Decide what (if anything) to patch on one session. Pure — no fs.
 * Only fills ABSENT fields; never rewrites a populated one.
 */
export function planBackfill(
  meta: SessionMeta,
  ids: string[]
): { status: BackfillStatus; patch?: Partial<SessionMeta> } {
  if (ids.length === 0) return { status: 'no-init' };
  const last = ids[ids.length - 1];
  if (meta.backendSessionId && meta.backendSessionId !== last) {
    return { status: 'conflict' };
  }
  const patch: Partial<SessionMeta> = {};
  if (!meta.backendSessionId) patch.backendSessionId = last;
  if (!meta.backendSessionHistory?.length) {
    patch.backendSessionHistory = ids.map(
      (id, i): BackendSessionTransition => ({
        id,
        ts: meta.createdAt,
        reason: i === 0 ? 'initial' : 'respawn'
      })
    );
  }
  const format = nativeFormatFor(meta.backend);
  if (!meta.native && format) patch.native = { format, id: last };
  if (Object.keys(patch).length === 0) return { status: 'ok' };
  return { status: 'fixable', patch };
}

function liveRoot(): string {
  return path.join(os.homedir(), '.codebuild');
}

/** Keep the index.json row (a cache of the meta header) in step with a
 * backfilled header so list() doesn't serve the stale pre-backfill meta. */
function syncIndexRow(root: string, merged: SessionMeta): void {
  const indexPath = path.join(root, 'index.json');
  if (!fs.existsSync(indexPath)) return;
  try {
    const all = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as SessionMeta[];
    const i = all.findIndex((m) => m.id === merged.id);
    if (i === -1) return;
    all[i] = merged;
    fs.writeFileSync(indexPath, JSON.stringify(all, null, 2));
  } catch {
    /* corrupt index — leave it; list() already tolerates that */
  }
}

/**
 * Scan every session transcript under `<root>/sessions` and backfill native
 * identity fields. Dry-run by default; `write: true` applies patches via the
 * same merge used by SessionStore.updateMeta (line-0 rewrite only, body
 * untouched). Writing to the live ~/.codebuild also requires `allowLive`.
 * Throws when root is missing/absent — a bare or misspelled root must fail
 * closed rather than "backfill" nothing and report success.
 */
export function backfillNativeIds(
  root: string,
  opts: { write?: boolean; allowLive?: boolean } = {}
): BackfillReport {
  if (!root) throw new Error('backfillNativeIds: a store root is required');
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    throw new Error(`backfillNativeIds: no sessions dir under ${root}`);
  }
  const write = opts.write === true;
  const isLive = path.resolve(root) === path.resolve(liveRoot());
  if (write && isLive && opts.allowLive !== true) {
    const summary = 'backfill: refused — live ~/.codebuild write requires allowLive opt-in';
    return { root, dryRun: true, refused: summary, sessions: [], summary };
  }

  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  const sessions: BackfillSessionResult[] = [];
  for (const file of files) {
    const p = path.join(sessionsDir, file);
    const id = file.replace(/\.jsonl$/, '');
    let lines: string[];
    try {
      lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    } catch {
      sessions.push({ id, status: 'unreadable', written: false });
      continue;
    }
    let meta: SessionMeta | undefined;
    try {
      const first = JSON.parse(lines[0] ?? '') as { type?: string; meta?: SessionMeta };
      if (first.type === 'meta' && first.meta) meta = first.meta;
    } catch {
      /* headerless */
    }
    if (!meta) {
      sessions.push({ id, status: 'unreadable', written: false });
      continue;
    }
    const plan = planBackfill(meta, nativeIdChanges(lines.slice(1)));
    let written = false;
    if (plan.status === 'fixable' && plan.patch && write) {
      const merged = mergeSessionMeta(meta, plan.patch);
      lines[0] = JSON.stringify({ type: 'meta', meta: merged });
      fs.writeFileSync(p, lines.join('\n') + '\n');
      syncIndexRow(root, merged);
      written = true;
    }
    sessions.push({ id, status: plan.status, patch: plan.patch, written });
  }

  const count = (s: BackfillStatus) => sessions.filter((r) => r.status === s).length;
  const summary =
    `backfill${write ? '' : ' (dry-run)'}: scanned=${sessions.length} ` +
    `fixable=${count('fixable')} written=${sessions.filter((r) => r.written).length} ` +
    `ok=${count('ok')} no-init=${count('no-init')} ` +
    `conflicts=${count('conflict')} unreadable=${count('unreadable')}`;
  return { root, dryRun: !write, sessions, summary };
}
