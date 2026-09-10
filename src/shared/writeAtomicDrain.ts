/**
 * In-flight Write atomic drain on rate-limit
 * (kp: ideas/cb-in-flight-write-atomic-drain-on-rate-limit-fi)
 *
 * Host invariant: when a classified quota (429-class) / window-exhausted
 * signal fires while a Write/Edit tool call is open, finish the file
 * mutation atomically — flush if disk matches the tool-args hash, else
 * roll back to the pre-image (or delete a Write-new). Never leave a
 * truncated file. Then the session parks (resume-after-reset).
 *
 * Distinct from: soft-stop wrap-up primer, walkaway quota co-stop.
 * Must not invent rate-limit signals — callers pass an already-classified
 * BackendErrorClass (quota only).
 *
 * Pure / vscode-free. Filesystem is injected (DrainFs) so tests can use a
 * fake ACP backend without touching disk.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ContentBlock, SessionUpdate, ToolCall, ToolCallStatus } from './acpTypes';
import type { BackendErrorClass } from './backendErrorClass';

/** Exact header-chip copy from the KP acceptance. */
export const WRITE_DRAIN_CHIP_LABEL = 'drained write → paused';

export type DrainAction = 'flush' | 'rollback' | 'skip';

/** Filesystem the tracker needs — injectable for fixture tests. */
export interface DrainFs {
  readFile(absPath: string): string | null;
  writeFile(absPath: string, content: string): void;
  deleteFile(absPath: string): void;
}

export interface InFlightWrite {
  toolCallId: string;
  path: string;
  /** Full intended file body when known (Write content / diff newText). */
  intendedContent: string | null;
  /** SHA-1 of intendedContent; null when we only saw a patch (Edit old/new). */
  intendedHash: string | null;
  /** Disk bytes captured at first PENDING sight, or from fs-bridge pre-write.
   * null + hadPreImage = Write-new (file did not exist). */
  preImage: string | null;
  hadPreImage: boolean;
  status: ToolCallStatus;
}

export interface DrainDecision {
  action: DrainAction;
  reason: string;
}

export interface DrainFileResult {
  path: string;
  action: DrainAction;
  reason: string;
  toolCallId: string;
}

export interface WriteDrainChip {
  available: boolean;
  /** Always `drained write → paused` when available. */
  label: string;
  flushed: number;
  rolledBack: number;
  skipped: number;
  paths: string[];
  warn: boolean;
  hint?: string;
}

export interface DrainResult {
  /** True only on quota with at least one in-flight write that was drained. */
  fired: boolean;
  files: DrainFileResult[];
  flushed: number;
  rolledBack: number;
  skipped: number;
  chip: WriteDrainChip | null;
}

export function contentHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function diffBlocks(
  content: ContentBlock[] | undefined
): Extract<ContentBlock, { type: 'diff' }>[] {
  return (content ?? []).filter(
    (b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff'
  );
}

function pickPathField(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file', 'notebook_path']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function pickFullContentField(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  for (const key of ['content', 'contents', 'new_text', 'newText', 'new_source']) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

const WRITE_TITLE_RE =
  /^(write|write_file|writefile|edit|edit_file|multiedit|notebookedit|apply_patch|applypatch|create|create_file)\b/i;

/** True for Write / Edit / ApplyPatch-class tool calls. */
export function isWriteClassTool(tc: Pick<ToolCall, 'title' | 'kind' | 'content'>): boolean {
  if (tc.kind === 'edit' || tc.kind === 'write' || tc.kind === 'create') return true;
  if (diffBlocks(tc.content).length > 0) return true;
  if (tc.title && WRITE_TITLE_RE.test(tc.title.trim())) return true;
  return false;
}

export interface WriteTarget {
  path: string;
  /** Full intended body when known; null for patch-only Edit. */
  content: string | null;
}

/**
 * Paths + intended full content for a write-class tool. Patch-only Edit
 * (old_string/new_string) yields content: null — drain then prefers rollback.
 */
export function extractWriteTargets(
  tc: Pick<ToolCall, 'title' | 'kind' | 'content' | 'locations' | 'rawInput'>
): WriteTarget[] {
  if (!isWriteClassTool(tc)) return [];
  const diffs = diffBlocks(tc.content);
  if (diffs.length > 0) {
    const out: WriteTarget[] = [];
    for (const d of diffs) {
      if (d.path) out.push({ path: d.path, content: d.newText });
    }
    if (out.length > 0) return out;
  }
  const raw = asRecord(tc.rawInput);
  const p =
    pickPathField(raw) ??
    tc.locations?.find((l) => l.path)?.path ??
    null;
  if (!p) return [];
  return [{ path: p, content: pickFullContentField(raw) }];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/**
 * Flush iff disk SHA-1 matches the tool-args hash. Otherwise rollback
 * (preferred when bytes are incomplete / unverifiable).
 */
export function decideDrainAction(args: {
  intendedHash: string | null;
  diskContent: string | null;
  hadPreImage: boolean;
}): DrainDecision {
  if (args.intendedHash != null) {
    const diskHash = args.diskContent == null ? null : contentHash(args.diskContent);
    if (diskHash === args.intendedHash) {
      return { action: 'flush', reason: 'disk matches tool args hash' };
    }
    if (args.hadPreImage) {
      return { action: 'rollback', reason: 'incomplete relative to tool args hash' };
    }
    // No trustworthy pre-image: completing the known body is the only way
    // to not leave a truncated file without inventing a baseline.
    if (args.diskContent != null) {
      return {
        action: 'flush',
        reason: 'incomplete, no pre-image — write remaining intended content'
      };
    }
    return { action: 'skip', reason: 'incomplete, no pre-image, file missing' };
  }
  if (args.hadPreImage) {
    return { action: 'rollback', reason: 'no verifiable tool args hash' };
  }
  return { action: 'skip', reason: 'no verifiable hash and no pre-image' };
}

export function writeDrainChip(result: {
  flushed: number;
  rolledBack: number;
  skipped: number;
  paths: string[];
}): WriteDrainChip | null {
  if (result.flushed + result.rolledBack + result.skipped === 0) return null;
  const bits: string[] = [];
  if (result.flushed) bits.push(`flush ${result.flushed}`);
  if (result.rolledBack) bits.push(`rollback ${result.rolledBack}`);
  if (result.skipped) bits.push(`skip ${result.skipped}`);
  return {
    available: true,
    label: WRITE_DRAIN_CHIP_LABEL,
    flushed: result.flushed,
    rolledBack: result.rolledBack,
    skipped: result.skipped,
    paths: result.paths,
    warn: result.rolledBack > 0,
    hint: bits.join(' · ')
  };
}

export function formatWriteDrainSummary(chip: WriteDrainChip): string {
  const n = chip.paths.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const hint = chip.hint ? ` (${chip.hint})` : '';
  return `${chip.label} — ${files}${hint}`;
}

function applyAction(
  rec: InFlightWrite,
  decision: DrainDecision,
  disk: string | null,
  fs: DrainFs
): void {
  if (decision.action === 'flush') {
    if (
      rec.intendedHash != null &&
      rec.intendedContent != null &&
      (disk == null || contentHash(disk) !== rec.intendedHash)
    ) {
      fs.writeFile(rec.path, rec.intendedContent);
    }
    return;
  }
  if (decision.action !== 'rollback') return;
  if (rec.preImage === null) fs.deleteFile(rec.path);
  else fs.writeFile(rec.path, rec.preImage);
}

/**
 * Tracks open Write/Edit tool calls and ACP fs/write_text_file intents so a
 * later quota signal can drain them atomically.
 */
export class WriteAtomicDrainTracker {
  private readonly open = new Map<string, InFlightWrite>();
  private readonly merged = new Map<string, ToolCall>();
  /** Paths rolled back during the last drain — commitFsWrite re-applies if
   * a racing writeFile finished after the drain. */
  private readonly rolledBack = new Map<string, { preImage: string | null }>();
  private cwd = '';

  setCwd(cwd: string): void {
    if (cwd) this.cwd = cwd;
  }

  get openCount(): number {
    return this.open.size;
  }

  listOpen(): InFlightWrite[] {
    return [...this.open.values()];
  }

  clear(): void {
    this.open.clear();
    this.merged.clear();
    this.rolledBack.clear();
  }

  /**
   * ACP fs/write_text_file — MUST run before the write lands so the
   * pre-image is the real baseline. Records intended full content.
   */
  noteFsWriteIntent(absPath: string, content: string, fs: DrainFs): void {
    const key = this.normalize(absPath);
    const existing = this.open.get(key);
    if (existing) {
      existing.intendedContent = content;
      existing.intendedHash = contentHash(content);
      if (!existing.hadPreImage) {
        existing.preImage = fs.readFile(key);
        existing.hadPreImage = true;
      }
      return;
    }
    this.open.set(key, {
      toolCallId: `fs:${key}`,
      path: key,
      intendedContent: content,
      intendedHash: contentHash(content),
      preImage: fs.readFile(key),
      hadPreImage: true,
      status: 'in_progress'
    });
  }

  /**
   * ACP fs/write_text_file completed. Drop the in-flight record unless a
   * drain already rolled this path back — then re-apply the rollback so a
   * racing write cannot resurrect a truncated (or just-landed) body.
   */
  commitFsWrite(absPath: string, fs: DrainFs): void {
    const key = this.normalize(absPath);
    const rb = this.rolledBack.get(key);
    if (rb) {
      if (rb.preImage === null) fs.deleteFile(key);
      else fs.writeFile(key, rb.preImage);
      this.open.delete(key);
      return;
    }
    this.open.delete(key);
  }

  observeUpdate(update: SessionUpdate, fs: DrainFs, cwd?: string): void {
    if (cwd) this.cwd = cwd;
    // Successful turn end: drop leftovers so a later quota cannot roll back
    // a previous turn's already-finished writes. Error is NOT cleared here —
    // drain() must still see in-flight records.
    if (update.kind === 'result') {
      this.open.clear();
      this.merged.clear();
      return;
    }
    if (update.kind !== 'tool_call' && update.kind !== 'tool_call_update') return;
    const partial = update.toolCall;
    const id = partial.toolCallId;
    if (!id) return;

    const prev = this.merged.get(id);
    const merged: ToolCall = {
      title: prev?.title ?? '',
      status: prev?.status ?? 'pending',
      ...prev,
      ...partial,
      toolCallId: id
    } as ToolCall;
    this.merged.set(id, merged);

    for (const t of extractWriteTargets(merged)) {
      const key = this.normalize(t.path);
      const existing = this.open.get(key);
      if (!existing) {
        const pending = merged.status === 'pending';
        const disk = pending ? fs.readFile(key) : null;
        this.open.set(key, {
          toolCallId: id,
          path: key,
          intendedContent: t.content,
          intendedHash: t.content != null ? contentHash(t.content) : null,
          preImage: pending ? disk : null,
          hadPreImage: pending,
          status: merged.status
        });
      } else {
        existing.status = merged.status;
        existing.toolCallId = id;
        if (t.content != null && existing.intendedContent == null) {
          existing.intendedContent = t.content;
          existing.intendedHash = contentHash(t.content);
        }
      }
    }

    if (merged.status === 'completed' || merged.status === 'failed') {
      for (const [p, rec] of [...this.open]) {
        if (rec.toolCallId === id) this.open.delete(p);
      }
      this.merged.delete(id);
    }
  }

  /**
   * Quota only. Non-quota returns fired:false and drops in-flight state
   * (the turn is over). Empty in-flight quota is a no-op (park without chip).
   */
  drain(errorClass: BackendErrorClass, fs: DrainFs): DrainResult {
    const empty: DrainResult = {
      fired: false,
      files: [],
      flushed: 0,
      rolledBack: 0,
      skipped: 0,
      chip: null
    };
    if (errorClass !== 'quota') {
      this.open.clear();
      this.merged.clear();
      return empty;
    }
    if (this.open.size === 0) return empty;

    this.rolledBack.clear();
    const files: DrainFileResult[] = [];
    let flushed = 0;
    let rolledBack = 0;
    let skipped = 0;
    const paths: string[] = [];

    for (const rec of [...this.open.values()]) {
      const disk = fs.readFile(rec.path);
      const decision = decideDrainAction({
        intendedHash: rec.intendedHash,
        diskContent: disk,
        hadPreImage: rec.hadPreImage
      });
      applyAction(rec, decision, disk, fs);
      files.push({
        path: rec.path,
        action: decision.action,
        reason: decision.reason,
        toolCallId: rec.toolCallId
      });
      paths.push(rec.path);
      if (decision.action === 'flush') flushed++;
      else if (decision.action === 'rollback') {
        rolledBack++;
        this.rolledBack.set(rec.path, { preImage: rec.preImage });
      } else skipped++;
    }

    this.open.clear();
    this.merged.clear();
    const chip = writeDrainChip({ flushed, rolledBack, skipped, paths });
    return { fired: true, files, flushed, rolledBack, skipped, chip };
  }

  private normalize(raw: string): string {
    if (!raw) return raw;
    if (path.isAbsolute(raw)) return path.normalize(raw);
    return path.resolve(this.cwd || '.', raw);
  }
}
