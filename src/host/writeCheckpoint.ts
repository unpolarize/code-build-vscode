// Write-checkpoint timeline — host-owned pre-image snapshots of every
// edit-class agent tool call, restorable to any prior toolCallId across ALL
// backends (claude stream-json, codex exec-json, grok/opencode ACP). Code-only
// /rewind parity: conversation is never touched.
//
// Design (locked in kp: ideas/cb-host-write-checkpoint-timeline-snapshot-acp-w):
// - Per-toolCallId FULL pre-image blobs + an NDJSON index. NOT a BaselineStore
//   overload (its captureIfAbsent first-touch invariant serves the ledger;
//   checkpoints need a per-tool version chain), NOT shadow-git, NOT the user's
//   `.git`, NOT VS Code Local History.
// - Dual capture, never wait for `completed`:
//   (A) `onFsWrite` from AcpTransport's `fs/write_text_file` handler — the
//       FS-bridge choke point for client-FS backends;
//   (B) first sight of a path on an edit-class `tool_call` /
//       `tool_call_update` (paths may only arrive on the update — merged by
//       toolCallId, upsert-only).
// - Pre-images come from a live disk read at first PENDING/IN_PROGRESS sight,
//   the staged fs-bridge read, or (codex only) a trusted full `changes[].old`
//   diff. A path first seen at `completed` with none of those sources is
//   DEGRADED — the write already landed and inventing a baseline would lie.
// - `preImage: null` marks Write-new → restore deletes the file.
// - Restore-to-tool-X is a timeline union: walking entries from X to newest,
//   the EARLIEST pre-image per path wins (that is the state before X). A
//   degraded earliest capture poisons its path (skip + count) rather than
//   restoring a later, wrong baseline.
// - Bash/external writes are NOT covered (universal prior-art gap — Claude's
//   own /rewind shares it). Blobs live under ~/.codebuild/file-history/<id>/
//   — the session store is FLAT sessions/<uuid>.jsonl, so a nested
//   sessions/<id>/ dir would collide with it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ContentBlock, SessionUpdate, ToolCall } from '../shared/acpTypes';
import { normalizePathKey, type LedgerFs } from './sessionLedger';

/** Filesystem the engine needs — injectable for fixture-stream tests. */
export interface CheckpointFs {
  /** File text, or null when missing/unreadable. */
  readFile(absPath: string): string | null;
  /** Write text, creating parent dirs. */
  writeFile(absPath: string, content: string): void;
  deleteFile(absPath: string): void;
  appendFile(absPath: string, text: string): void;
  /** Regular file / missing / anything else (symlink, dir, fifo — skipped). */
  fileKind(absPath: string): 'file' | 'missing' | 'other';
  /** Resolved real path, or null when the path does not exist (yet). */
  realpath?(absPath: string): string | null;
}

export const nodeCheckpointFs: CheckpointFs = {
  readFile(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  writeFile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  },
  deleteFile(p) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  },
  appendFile(p, text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, text, 'utf8');
  },
  fileKind(p) {
    try {
      const st = fs.lstatSync(p);
      return st.isFile() ? 'file' : 'other';
    } catch {
      return 'missing';
    }
  },
  realpath(p) {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  }
};

/** One captured path inside a finalized checkpoint entry. */
export interface CheckpointFileRef {
  /** Normalized absolute path. */
  path: string;
  /** Content-address of the pre-image blob; null = file did not exist
   * (Write-new → restore deletes). Absent blobId with degraded=true means
   * the pre-image could not be trusted and this path is not restorable. */
  blobId: string | null;
  degraded?: boolean;
}

export interface CheckpointEntry {
  toolCallId: string;
  ts: number;
  /** Monotonic capture order — the timeline axis for restore. */
  seq: number;
  files: CheckpointFileRef[];
  /** Paths whose capture was skipped (binary / oversize / non-regular). */
  skipped: number;
}

export interface RestoreResult {
  /** Files whose pre-image blob was written back. */
  written: number;
  /** Created-by-agent files deleted (null pre-image). */
  deleted: number;
  /** Paths skipped: degraded capture, out-of-root, non-regular, lost blob. */
  skipped: number;
  /** Absolute paths actually touched (written + deleted). */
  paths: string[];
}

export interface CheckpointEngineOpts {
  /** Blob + index directory, e.g. ~/.codebuild/file-history/<sessionId>. */
  dir: string;
  /** Session cwd — path normalization base. */
  cwd: string;
  fs?: CheckpointFs;
  /** Ring size; oldest entries + orphan blobs are dropped past it. */
  maxEntries?: number;
  /** Pre-images larger than this are skipped (~Claude's own policy). */
  maxFileBytes?: number;
  /** Codex normalizes `changes[].old` into full diff oldText — trust it as
   * the pre-image. NEVER set for claude: its synthesized diffs carry
   * fragment old_string / '' and would fabricate baselines. */
  trustDiffOldText?: boolean;
  /** Restore-side confinement (session PathGuard). Throw to reject a path;
   * out-of-root restores are skipped + counted, never applied. */
  confine?: (p: string) => string;
  now?: () => number;
  /** Fires with the full restorable id list whenever it changes. */
  onCheckpointsChanged?: (toolCallIds: string[]) => void;
}

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_FILE_BYTES = 1_500_000;
const INDEX_FILE = 'index.ndjson';

interface CapturedFile {
  path: string;
  /** null = did not exist. */
  preImage: string | null;
  degraded: boolean;
}

interface OpenEntry {
  merged: ToolCall;
  files: Map<string, CapturedFile>;
  skipped: number;
}

function diffBlocks(content: ContentBlock[] | undefined): Extract<ContentBlock, { type: 'diff' }>[] {
  return (content ?? []).filter((b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff');
}

/** Edit-class for checkpoint purposes: broader than the ledger's — 'write'
 * and 'create' kinds gate the same auto-approve path in handlePermission. */
export function isCheckpointEditClass(tc: ToolCall): boolean {
  return (
    tc.kind === 'edit' ||
    tc.kind === 'write' ||
    tc.kind === 'create' ||
    diffBlocks(tc.content).length > 0
  );
}

/** Raw paths an edit-class tool call names: locations[], diff paths, and
 * rawInput keys (file_path / path / notebook_path — Write, Edit, MultiEdit,
 * NotebookEdit shapes). */
export function extractCheckpointPaths(tc: ToolCall): string[] {
  const out = new Set<string>();
  for (const b of diffBlocks(tc.content)) if (b.path) out.add(b.path);
  for (const l of tc.locations ?? []) if (l.path) out.add(l.path);
  const raw = tc.rawInput as Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object') {
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const v = raw[key];
      if (typeof v === 'string' && v.length > 0) out.add(v);
    }
  }
  return [...out];
}

export function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export class WriteCheckpointEngine {
  private readonly dir: string;
  private readonly cwd: string;
  private readonly fs: CheckpointFs;
  private readonly ledgerFs: LedgerFs;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly trustDiffOldText: boolean;
  private readonly confine?: (p: string) => string;
  private readonly now: () => number;
  private readonly onCheckpointsChanged?: (ids: string[]) => void;

  private readonly open = new Map<string, OpenEntry>();
  /** fs-bridge pre-images awaiting a tool_call that names the path.
   * First-wins per path; cleared on consumption and at turn end. */
  private readonly staged = new Map<string, string | null>();
  private finalized: CheckpointEntry[] = [];
  private nextSeq = 1;

  constructor(opts: CheckpointEngineOpts) {
    this.dir = opts.dir;
    this.cwd = opts.cwd;
    this.fs = opts.fs ?? nodeCheckpointFs;
    this.ledgerFs = { readFile: (p) => this.fs.readFile(p), realpath: this.fs.realpath?.bind(this.fs) };
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.trustDiffOldText = opts.trustDiffOldText === true;
    this.confine = opts.confine;
    this.now = opts.now ?? Date.now;
    this.onCheckpointsChanged = opts.onCheckpointsChanged;
    this.loadIndex();
  }

  /** Restorable checkpoint ids, oldest → newest. */
  listCheckpointIds(): string[] {
    return this.finalized.filter((e) => this.isRestorable(e)).map((e) => e.toolCallId);
  }

  /** Absolute paths a restore-to-this-tool would actually touch (for the
   * confirm modal) — pre-filtered through the same confinement restore
   * applies, so the modal never overlists files that would be skipped. */
  planRestorePaths(toolCallId: string): string[] | null {
    const built = this.buildPlan(toolCallId);
    if (!built) return null;
    const out: string[] = [];
    for (const p of built.plan.keys()) {
      try {
        out.push(this.confine ? this.confine(p) : p);
      } catch {
        /* out-of-root — restore will skip it too */
      }
    }
    return out;
  }

  /** AcpTransport fs/write_text_file hook — MUST run before the write lands. */
  onFsWrite(absPath: string): void {
    const key = this.normalize(absPath);
    // A pending tool already captured this path from disk (announce-then-write
    // order) — staging now would go stale the moment the write lands.
    for (const entry of this.open.values()) {
      if (entry.files.has(key)) return;
    }
    if (this.staged.has(key)) return; // first write's pre-image wins
    const kind = this.fs.fileKind(key);
    if (kind === 'other') return;
    if (kind === 'missing') {
      this.staged.set(key, null);
      return;
    }
    // Existing file: stage only a read that passes the same policy as live
    // captures. An unreadable/oversize/binary pre-image must NOT stage null —
    // null means Write-new and restore would DELETE the file. Not staging
    // leaves the path to the degraded-at-completed rule (skip, never lie).
    const content = this.fs.readFile(key);
    if (content === null || content.length > this.maxFileBytes || content.includes('\0')) return;
    this.staged.set(key, content);
  }

  observeUpdate(update: SessionUpdate): void {
    if (update.kind === 'result' || update.kind === 'error') {
      // Turn over: tools that never completed are not restore targets, and
      // any unconsumed fs-bridge pre-image is stale.
      this.open.clear();
      this.staged.clear();
      return;
    }
    if (update.kind !== 'tool_call' && update.kind !== 'tool_call_update') return;
    const partial = update.toolCall;
    const id = partial.toolCallId;
    if (!id || this.finalized.some((e) => e.toolCallId === id)) return;

    let entry = this.open.get(id);
    if (!entry) {
      entry = {
        merged: { title: '', status: 'pending', ...partial, toolCallId: id } as ToolCall,
        files: new Map(),
        skipped: 0
      };
      this.open.set(id, entry);
    } else {
      entry.merged = { ...entry.merged, ...partial } as ToolCall;
    }

    if (isCheckpointEditClass(entry.merged)) {
      for (const raw of extractCheckpointPaths(entry.merged)) {
        this.capturePath(entry, raw);
      }
    }

    if (entry.merged.status === 'completed') {
      this.open.delete(id);
      this.finalize(id, entry);
    } else if (entry.merged.status === 'failed') {
      this.open.delete(id);
    }
  }

  restore(toolCallId: string): RestoreResult | null {
    const built = this.buildPlan(toolCallId);
    if (!built) return null;
    const result: RestoreResult = { written: 0, deleted: 0, skipped: built.poisoned, paths: [] };
    for (const [p, ref] of built.plan) {
      let target: string;
      try {
        target = this.confine ? this.confine(p) : p;
      } catch {
        result.skipped++;
        continue;
      }
      const kind = this.fs.fileKind(target);
      if (kind === 'other') {
        result.skipped++;
        continue;
      }
      if (ref.blobId !== null && !/^[0-9a-f]{40}$/.test(ref.blobId)) {
        result.skipped++; // tampered/corrupt index line must not traverse paths
        continue;
      }
      if (ref.blobId === null) {
        if (kind !== 'missing') {
          this.fs.deleteFile(target);
          result.deleted++;
          result.paths.push(target);
        }
        continue;
      }
      const content = this.fs.readFile(this.blobPath(ref.blobId));
      if (content === null) {
        result.skipped++; // blob lost (external cleanup) — never write garbage
        continue;
      }
      this.fs.writeFile(target, content);
      result.written++;
      result.paths.push(target);
    }
    return result;
  }

  // ---- capture ----

  private normalize(raw: string): string {
    return normalizePathKey(raw, this.cwd, this.ledgerFs);
  }

  private capturePath(entry: OpenEntry, raw: string): void {
    const key = this.normalize(raw);
    if (entry.files.has(key)) return;

    // Source 1: fs-bridge staged pre-image (write-then-announce backends).
    if (this.staged.has(key)) {
      const pre = this.staged.get(key) ?? null;
      this.staged.delete(key);
      this.record(entry, key, pre);
      return;
    }

    // Source 2 (codex): full changes[].old normalized into diff oldText —
    // trusted only WHEN PRESENT (non-empty). The normalizer collapses
    // `old: undefined` (new file) and `old: ''` (empty file) into '' — an
    // ambiguity we must not resolve by guessing "delete on restore"; empty
    // falls through to disk-at-pending / degraded like any other path.
    if (this.trustDiffOldText) {
      const diff = diffBlocks(entry.merged.content).find((b) => this.normalize(b.path) === key);
      if (diff && diff.oldText !== '') {
        if (diff.oldText.length > this.maxFileBytes || diff.oldText.includes('\0')) {
          entry.skipped++;
          return;
        }
        this.record(entry, key, diff.oldText);
        return;
      }
    }

    // Source 3: live disk read — only trustworthy BEFORE the write lands.
    const kind = this.fs.fileKind(key);
    if (kind === 'other') {
      entry.skipped++;
      return;
    }
    if (kind === 'missing') {
      this.record(entry, key, null);
      return;
    }
    const content = this.fs.readFile(key);
    if (content === null || content.length > this.maxFileBytes || content.includes('\0')) {
      entry.skipped++;
      return;
    }
    if (entry.merged.status === 'completed') {
      // First sight at completed (claude stream-json race): the write already
      // landed — disk holds the POST-image. Mark degraded, don't invent one.
      entry.files.set(key, { path: key, preImage: null, degraded: true });
      return;
    }
    this.record(entry, key, content);
  }

  private record(entry: OpenEntry, key: string, preImage: string | null): void {
    entry.files.set(key, { path: key, preImage, degraded: false });
  }

  // ---- finalize / ring / persistence ----

  private finalize(toolCallId: string, entry: OpenEntry): void {
    const captured = [...entry.files.values()];
    // No trustworthy capture → no false restore target.
    if (!captured.some((f) => !f.degraded)) return;
    const refs: CheckpointFileRef[] = captured.map((f) => {
      if (f.degraded) return { path: f.path, blobId: null, degraded: true };
      if (f.preImage === null) return { path: f.path, blobId: null };
      const blobId = sha1Hex(f.preImage);
      const blobPath = this.blobPath(blobId);
      if (this.fs.readFile(blobPath) === null) this.fs.writeFile(blobPath, f.preImage);
      return { path: f.path, blobId };
    });
    const rec: CheckpointEntry = {
      toolCallId,
      ts: this.now(),
      seq: this.nextSeq++,
      files: refs,
      skipped: entry.skipped
    };
    this.finalized.push(rec);
    this.fs.appendFile(this.indexPath(), JSON.stringify(rec) + '\n');
    this.enforceRing();
    this.onCheckpointsChanged?.(this.listCheckpointIds());
  }

  private enforceRing(): void {
    if (this.finalized.length <= this.maxEntries) return;
    const dropped = this.finalized.splice(0, this.finalized.length - this.maxEntries);
    const live = new Set<string>();
    for (const e of this.finalized) for (const f of e.files) if (f.blobId) live.add(f.blobId);
    for (const e of dropped) {
      for (const f of e.files) {
        if (f.blobId && !live.has(f.blobId)) this.fs.deleteFile(this.blobPath(f.blobId));
      }
    }
    this.rewriteIndex();
  }

  private rewriteIndex(): void {
    this.fs.writeFile(
      this.indexPath(),
      this.finalized.map((e) => JSON.stringify(e)).join('\n') + (this.finalized.length ? '\n' : '')
    );
  }

  private loadIndex(): void {
    const text = this.fs.readFile(this.indexPath());
    if (!text) return;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as CheckpointEntry;
        if (typeof rec.toolCallId === 'string' && Array.isArray(rec.files)) {
          this.finalized.push(rec);
        }
      } catch {
        /* tolerate a torn tail line */
      }
    }
    this.finalized.sort((a, b) => a.seq - b.seq);
    this.nextSeq = (this.finalized[this.finalized.length - 1]?.seq ?? 0) + 1;
  }

  private indexPath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  private blobPath(blobId: string): string {
    return path.join(this.dir, blobId);
  }

  private isRestorable(e: CheckpointEntry): boolean {
    return e.files.some((f) => !f.degraded);
  }

  /** Timeline union from entry X to newest: earliest pre-image per path is
   * the state before X. Degraded earliest captures poison their path. */
  private buildPlan(
    toolCallId: string
  ): { plan: Map<string, CheckpointFileRef>; poisoned: number } | null {
    const idx = this.finalized.findIndex((e) => e.toolCallId === toolCallId);
    if (idx === -1 || !this.isRestorable(this.finalized[idx])) return null;
    const plan = new Map<string, CheckpointFileRef>();
    const poisoned = new Set<string>();
    for (const e of this.finalized.slice(idx)) {
      for (const f of e.files) {
        if (plan.has(f.path) || poisoned.has(f.path)) continue;
        if (f.degraded) poisoned.add(f.path);
        else plan.set(f.path, f);
      }
    }
    return { plan, poisoned: poisoned.size };
  }
}
