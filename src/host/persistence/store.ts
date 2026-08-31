import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionUpdate } from '../../shared/acpTypes';
import type { CompactMarker, SessionMeta } from '../../shared/protocol';

/** Bytes from EOF to replay into a restored chat. perf #8 / issue #23. */
export const REPLAY_TAIL_BYTES = 512 * 1024;
export const REPLAY_TAIL_BYTES_CAP = 2 * 1024 * 1024;
/** Grow further so the last user-turn is complete (not a mid-reply fragment). */
export const REPLAY_TURN_BYTES_CAP = 8 * 1024 * 1024;
export const REPLAY_TAIL_MAX_RECORDS = 200;
/** Last complete user turns on first paint / each older page. */
export const REPLAY_TAIL_MAX_TURNS = 8;

export type OffsetRec = { rec: { type: string; [k: string]: unknown }; start: number };

/** Keep records from the Nth-last `user` line so a page never starts mid-turn. */
export function keepLastCompleteTurns(records: OffsetRec[], maxTurns: number): OffsetRec[] {
  if (records.length === 0) return records;
  const userIdx: number[] = [];
  for (let i = 0; i < records.length; i++) {
    if (records[i].rec.type === 'user') userIdx.push(i);
  }
  if (userIdx.length === 0) return [];
  const take = Math.max(1, maxTurns);
  const start = userIdx[Math.max(0, userIdx.length - take)];
  return records.slice(start);
}

export function countUserTurns(records: OffsetRec[]): number {
  let n = 0;
  for (const r of records) if (r.rec.type === 'user') n += 1;
  return n;
}

const INVISIBLE_UPDATE = new Set([
  'system',
  'system_init',
  'available_commands_update',
  'current_mode_update'
]);

/** True if replay would produce a chat bubble (not just session chrome). */
export function hasVisibleReplayRecords(
  records: Array<{ type: string; update?: { kind?: string } }>
): boolean {
  for (const r of records) {
    if (r.type === 'user') return true;
    const k = r.update?.kind;
    if (k && !INVISIBLE_UPDATE.has(k)) return true;
  }
  return false;
}

/**
 * Durable whole-file write: same-directory `.tmp` + fsync + rename.
 * A crash between tmp write and rename leaves the prior target intact.
 * Append-path streaming must NOT use this (see flushOneSync / flushOneAsync).
 */
export function writeFileAtomic(filePath: string, data: string | NodeJS.ArrayBufferView): void {
  const tmpPath = `${filePath}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * File-backed session store under ~/.codebuild — not VS Code globalState (which
 * doesn't scale and isn't CLI-shareable). Each session is one JSONL transcript;
 * an index.json lists known sessions.
 *
 * Hot-path writes (`appendUpdate` / `appendUserText`) are **queued and flushed
 * asynchronously** (default ~50ms) so streaming no longer blocks the Extension
 * Host event loop on `appendFileSync` per chunk. Readers (`load`, `list`,
 * `hasContent`, `updateMeta`) flush pending lines for the affected session
 * first so tests and rehydrate never miss data.
 *
 * Whole-file rewrites (index.json, transcript meta header, perf export) go
 * through {@link writeFileAtomic} so a mid-write crash cannot truncate them.
 */
export class SessionStore {
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  /** Pending lines keyed by session id. */
  private readonly pending = new Map<string, string[]>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInFlight: Promise<void> = Promise.resolve();
  /** Last measured disk write latency (ms) for perf collector. */
  lastDiskMs = 0;
  /** Coalesce window for async appends. */
  private readonly flushMs: number;
  /** In-memory index.json; invalidated when the file's mtime+size change. */
  private indexCache: SessionMeta[] | null = null;
  private indexStat: { mtimeMs: number; size: number } | null = null;

  constructor(root = path.join(os.homedir(), '.codebuild'), flushMs = 50) {
    this.root = root;
    this.sessionsDir = path.join(root, 'sessions');
    this.indexPath = path.join(root, 'index.json');
    this.flushMs = flushMs;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.cleanupOrphanTmp();
  }

  /** Remove leftover `*.tmp` from a prior crash window (same-dir atomic writes). */
  private cleanupOrphanTmp(): void {
    const unlinkQuiet = (p: string) => {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    };
    unlinkQuiet(`${this.indexPath}.tmp`);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.endsWith('.tmp')) unlinkQuiet(path.join(this.sessionsDir, name));
    }
  }

  getRoot(): string {
    return this.root;
  }

  transcriptPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  /**
   * Begin a transcript file with a self-describing meta header. Does NOT add the
   * session to the index yet — an empty chat that's never used shouldn't clutter
   * history. Call commitSession() once the conversation has real content.
   */
  createSession(meta: SessionMeta): void {
    this.flushSync(meta.id);
    writeFileAtomic(this.transcriptPath(meta.id), JSON.stringify({ type: 'meta', meta }) + '\n');
  }

  /** Promote a session into the history index (idempotent). Empty chats stay
   * `hasContent: false` until the first user/assistant/tool record. */
  commitSession(meta: SessionMeta): void {
    this.upsertIndex({ ...meta, hasContent: meta.hasContent === true });
  }

  /**
   * Read-modify-write the session meta header (and index row when present).
   *
   * Two call shapes:
   * - `updateMeta(meta)` — full in-memory meta (legacy callers). Still RMW-merges
   *   onto the on-disk header so fields only present on disk (e.g. a concurrent
   *   `backendSessionId` patch) are not clobbered by a stale full object that
   *   omits them. `undefined` optional fields on the argument do not erase disk
   *   values.
   * - `updateMeta(id, patch)` — partial patch. Only defined keys in `patch` are
   *   applied; `id` is never rewritten. Returns the merged meta, or `undefined`
   *   when no transcript exists.
   *
   * Always flushes pending body lines first so interleaved `append*` + meta
   * rewrites never drop transcript rows.
   */
  updateMeta(meta: SessionMeta): SessionMeta | undefined;
  updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined;
  updateMeta(
    metaOrId: SessionMeta | string,
    patch?: Partial<SessionMeta>
  ): SessionMeta | undefined {
    if (typeof metaOrId === 'string') {
      return this.patchMeta(metaOrId, patch ?? {});
    }
    return this.patchMeta(metaOrId.id, metaOrId);
  }

  /**
   * Merge `patch` onto index.json (SoT for list/title/model). Does **not**
   * rewrite the JSONL transcript — that was a ~1 s fsync of a 96 MB file.
   * `load()` prefers the index row over JSONL line 0.
   */
  private patchMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | undefined {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    if (!fs.existsSync(p)) return undefined;
    const current = this.findIndexRow(id) ?? readJsonlMetaHead(p);
    if (!current) return undefined;
    const merged = mergeSessionMeta(current, patch);
    this.upsertIndex(merged);
    return merged;
  }

  appendUpdate(id: string, update: SessionUpdate, ts: number = Date.now()): void {
    this.enqueue(id, JSON.stringify({ type: 'update', ts, update }) + '\n');
    if (isSubstantiveUpdate(update.kind)) this.markHasContent(id);
  }

  appendUserText(
    id: string,
    text: string,
    ts: number = Date.now(),
    images?: Array<{ mimeType: string; data: string; name?: string }>
  ): void {
    const rec: { type: 'user'; ts: number; text: string; images?: typeof images } = {
      type: 'user',
      ts,
      text
    };
    if (images && images.length > 0) rec.images = images;
    this.enqueue(id, JSON.stringify(rec) + '\n');
    this.markHasContent(id);
  }

  /** Persist a /compact boundary. Replays through `load()` like any other
   * body record so `historyLoaded` reconstructs both segments around the
   * divider. Not "content" for hasContent() — a compact can only follow
   * real turns, so it never has to rescue an otherwise-empty session. */
  appendCompactMarker(id: string, marker: CompactMarker): void {
    this.enqueue(id, JSON.stringify({ type: 'compact', marker }) + '\n');
  }

  private enqueue(id: string, line: string): void {
    const t0 = performance.now();
    let buf = this.pending.get(id);
    if (!buf) {
      buf = [];
      this.pending.set(id, buf);
    }
    buf.push(line);
    // Attribute enqueue cost as near-zero; real disk cost is measured on flush.
    this.lastDiskMs = Math.max(0, performance.now() - t0);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushAsync();
    }, this.flushMs);
  }

  /** Async flush of all pending session buffers. */
  async flushAsync(): Promise<void> {
    // Serialize flushes so concurrent timers don't interleave writes.
    this.flushInFlight = this.flushInFlight.then(() => this.flushAllPending());
    await this.flushInFlight;
  }

  /**
   * Synchronous flush — used before load/list/meta rewrite/dispose and by unit tests.
   * If `id` is set, only that session is flushed; otherwise all pending.
   */
  flushSync(id?: string): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const ids = id ? [id] : [...this.pending.keys()];
    for (const sid of ids) {
      this.flushOneSync(sid);
    }
  }

  private async flushAllPending(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      await this.flushOneAsync(id);
    }
  }

  private flushOneSync(id: string): void {
    const lines = this.pending.get(id);
    if (!lines || lines.length === 0) {
      this.pending.delete(id);
      return;
    }
    this.pending.delete(id);
    const payload = lines.join('');
    const t0 = performance.now();
    try {
      fs.appendFileSync(this.transcriptPath(id), payload);
    } finally {
      this.lastDiskMs = performance.now() - t0;
    }
  }

  private async flushOneAsync(id: string): Promise<void> {
    const lines = this.pending.get(id);
    if (!lines || lines.length === 0) {
      this.pending.delete(id);
      return;
    }
    this.pending.delete(id);
    const payload = lines.join('');
    const t0 = performance.now();
    try {
      await fsp.appendFile(this.transcriptPath(id), payload);
    } finally {
      this.lastDiskMs = performance.now() - t0;
    }
  }

  private isIndexed(id: string): boolean {
    return this.findIndexRow(id) !== undefined;
  }

  /** Index.json (or JSONL line-0). Never reads the transcript body. */
  loadMeta(id: string): SessionMeta | undefined {
    this.flushSync(id);
    return this.findIndexRow(id) ?? readJsonlMetaHead(this.transcriptPath(id));
  }

  /** Load a transcript back into ordered records for UI rehydration. */
  load(id: string): { meta?: SessionMeta; records: { type: string; [k: string]: unknown }[] } {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    if (!fs.existsSync(p)) return { records: [] };
    const parsed = parseJsonlText(fs.readFileSync(p, 'utf8'));
    const indexMeta = this.findIndexRow(id);
    const meta = indexMeta ? { ...parsed.jsonlMeta, ...indexMeta, id } : parsed.jsonlMeta;
    return { meta, records: parsed.records };
  }

  /**
   * Last N complete JSONL records, reading at most `maxBytes` from EOF.
   * `olderFromByte` is the file offset of the first returned record (0 = none older).
   */
  loadTail(
    id: string,
    opts?: { maxBytes?: number; maxRecords?: number; maxTurns?: number }
  ): {
    meta?: SessionMeta;
    records: { type: string; [k: string]: unknown }[];
    truncated: boolean;
    fileBytes: number;
    olderFromByte: number;
  } {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    const maxBytes = opts?.maxBytes ?? REPLAY_TAIL_BYTES;
    const maxRecords = opts?.maxRecords ?? REPLAY_TAIL_MAX_RECORDS;
    const maxTurns = opts?.maxTurns ?? REPLAY_TAIL_MAX_TURNS;
    if (!fs.existsSync(p)) {
      return { records: [], truncated: false, fileBytes: 0, olderFromByte: 0 };
    }
    const fileBytes = fs.statSync(p).size;
    if (fileBytes === 0) {
      return { records: [], truncated: false, fileBytes: 0, olderFromByte: 0 };
    }
    return this.pageWindow(id, p, fileBytes, fileBytes, maxBytes, maxRecords, maxTurns);
  }

  /**
   * Records immediately before `beforeByte` (exclusive). Same byte-window
   * + last-N rule as loadTail, so scroll-up paging does not skip a gap.
   */
  loadBefore(
    id: string,
    beforeByte: number,
    opts?: { maxBytes?: number; maxRecords?: number; maxTurns?: number }
  ): {
    meta?: SessionMeta;
    records: { type: string; [k: string]: unknown }[];
    truncated: boolean;
    fileBytes: number;
    olderFromByte: number;
  } {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    if (!fs.existsSync(p) || beforeByte <= 0) {
      return { records: [], truncated: false, fileBytes: 0, olderFromByte: 0 };
    }
    const fileBytes = fs.statSync(p).size;
    const maxBytes = opts?.maxBytes ?? REPLAY_TAIL_BYTES;
    const maxRecords = opts?.maxRecords ?? REPLAY_TAIL_MAX_RECORDS;
    const maxTurns = opts?.maxTurns ?? REPLAY_TAIL_MAX_TURNS;
    return this.pageWindow(id, p, fileBytes, beforeByte, maxBytes, maxRecords, maxTurns);
  }

  private pageWindow(
    id: string,
    p: string,
    fileBytes: number,
    endByte: number,
    maxBytes: number,
    maxRecords: number,
    maxTurns: number
  ): {
    meta?: SessionMeta;
    records: { type: string; [k: string]: unknown }[];
    truncated: boolean;
    fileBytes: number;
    olderFromByte: number;
  } {
    const end = Math.min(fileBytes, Math.max(0, endByte));
    let window = Math.min(maxBytes, end);
    let from = Math.max(0, end - window);
    let page = readJsonlWindow(p, from, end);
    let kept = keepLastCompleteTurns(page.records, maxTurns);
    while (kept.length === 0 && from > 0 && window < REPLAY_TURN_BYTES_CAP) {
      window = Math.min(REPLAY_TURN_BYTES_CAP, window * 4, end);
      from = Math.max(0, end - window);
      page = readJsonlWindow(p, from, end);
      kept = keepLastCompleteTurns(page.records, maxTurns);
    }
    if (kept.length === 0) kept = page.records;
    while (kept.length > maxRecords && countUserTurns(kept) > 1) {
      const next = keepLastCompleteTurns(kept, countUserTurns(kept) - 1);
      if (next.length === 0 || next.length === kept.length) break;
      kept = next;
    }
    if (kept.length > maxRecords) kept = kept.slice(-maxRecords);
    const droppedLeading =
      kept.length > 0 &&
      page.records.length > 0 &&
      kept[0].start > page.records[0].start;
    const olderFromByte =
      kept.length > 0 && (from > 0 || droppedLeading) ? kept[0].start : 0;
    const records = kept.map((r) => r.rec);
    const indexMeta = this.findIndexRow(id);
    const meta = indexMeta ? { ...page.jsonlMeta, ...indexMeta, id } : page.jsonlMeta;
    return {
      meta,
      records,
      truncated: olderFromByte > 0,
      fileBytes,
      olderFromByte
    };
  }

  list(): SessionMeta[] {
    return this.readIndexRaw().filter((m) => m.hasContent === true);
  }

  /**
   * True if the transcript has real conversation — a user message or substantive
   * agent output — not just connection noise (e.g. available_commands_update).
   * Prefers the index sidecar; scans a 64 KB head only for unstamped legacy rows.
   */
  hasContent(id: string): boolean {
    const row = this.findIndexRow(id);
    if (row?.hasContent === true) return true;
    if (row?.hasContent === false) return false;
    this.flushSync(id);
    return headHasContent(this.transcriptPath(id));
  }

  /** Stat helper for dual-store perf panel. */
  statTranscript(id: string): { path: string; bytes: number; mtimeMs: number } | undefined {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    try {
      const st = fs.statSync(p);
      return { path: p, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /** Write a perf export next to the session transcript. */
  writePerfExport(id: string, data: unknown): string {
    const p = path.join(this.sessionsDir, `${id}.perf.json`);
    writeFileAtomic(p, JSON.stringify(data, null, 2));
    return p;
  }

  private findIndexRow(id: string): SessionMeta | undefined {
    return this.readIndexRaw().find((m) => m.id === id);
  }

  private markHasContent(id: string): void {
    const row = this.findIndexRow(id);
    if (!row || row.hasContent === true) return;
    this.upsertIndex({ ...row, hasContent: true });
  }

  private readIndexRaw(): SessionMeta[] {
    if (!fs.existsSync(this.indexPath)) {
      this.indexCache = [];
      this.indexStat = null;
      return this.indexCache;
    }
    let st: { mtimeMs: number; size: number };
    try {
      const s = fs.statSync(this.indexPath);
      st = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
    } catch {
      return this.indexCache ?? [];
    }
    if (
      this.indexCache &&
      this.indexStat &&
      this.indexStat.mtimeMs === st.mtimeMs &&
      this.indexStat.size === st.size
    ) {
      return this.indexCache;
    }
    let all: SessionMeta[] = [];
    try {
      all = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionMeta[];
    } catch {
      all = [];
    }
    if (all.some((m) => m.hasContent === undefined)) {
      all = migrateHasContent(all, (id) => this.transcriptPath(id));
      writeFileAtomic(this.indexPath, JSON.stringify(all.slice(0, 500), null, 2));
      try {
        const s = fs.statSync(this.indexPath);
        st = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
      } catch {
        /* keep prior st */
      }
    }
    this.indexCache = all;
    this.indexStat = st;
    return all;
  }

  private upsertIndex(meta: SessionMeta): void {
    const all = this.readIndexRaw().filter((m) => m.id !== meta.id);
    all.unshift(meta);
    writeFileAtomic(this.indexPath, JSON.stringify(all.slice(0, 500), null, 2));
    this.indexCache = all.slice(0, 500);
    try {
      const s = fs.statSync(this.indexPath);
      this.indexStat = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
    } catch {
      this.indexCache = null;
      this.indexStat = null;
    }
  }

  dispose(): void {
    this.flushSync();
  }
}

/**
 * Patch-merge session meta: defined keys in `patch` win; `id` is always the
 * on-disk identity; `undefined` values in the patch are skipped so a stale
 * full-meta write cannot erase optional fields (backendSessionId, native, …)
 * that only exist on disk.
 */
export function mergeSessionMeta(
  current: SessionMeta,
  patch: Partial<SessionMeta>
): SessionMeta {
  const merged: SessionMeta = { ...current, id: current.id };
  for (const key of Object.keys(patch) as (keyof SessionMeta)[]) {
    if (key === 'id') continue;
    const value = patch[key];
    if (value !== undefined) {
      // Assignment is per-key; cast keeps Partial optional fields workable.
      (merged as unknown as Record<string, unknown>)[key] = value as unknown;
    }
  }
  return merged;
}

const HEAD_BYTES = 64 * 1024;

function isSubstantiveUpdate(kind: string | undefined): boolean {
  return (
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'tool_call' ||
    kind === 'plan'
  );
}

function recordHasContent(rec: { type?: string; update?: { kind?: string } }): boolean {
  if (rec.type === 'user') return true;
  if (rec.type === 'update') return isSubstantiveUpdate(rec.update?.kind);
  return false;
}

function parseJsonlText(text: string): {
  records: { type: string; [k: string]: unknown }[];
  jsonlMeta?: SessionMeta;
} {
  const records: { type: string; [k: string]: unknown }[] = [];
  let jsonlMeta: SessionMeta | undefined;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; meta?: SessionMeta };
      if (rec.type === 'meta') jsonlMeta = rec.meta;
      else if (rec.type) records.push(rec as { type: string; [k: string]: unknown });
    } catch {
      /* skip incomplete / corrupt line */
    }
  }
  return { records, jsonlMeta };
}

type JsonlBodyRec = { type: string; [k: string]: unknown };

/** Read [fromByte, toByte). Skip a partial first line when fromByte > 0. */
function readJsonlWindow(
  p: string,
  fromByte: number,
  toByte: number
): {
  records: { rec: JsonlBodyRec; start: number }[];
  jsonlMeta?: SessionMeta;
} {
  const start = Math.max(0, fromByte);
  const end = Math.max(start, toByte);
  const len = end - start;
  if (len === 0) return { records: [] };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, 'r');
  try {
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    fs.closeSync(fd);
  }
  let text = buf.toString('utf8');
  let skip = 0;
  if (start > 0) {
    const nl = text.indexOf('\n');
    if (nl < 0) return { records: [] };
    skip = nl + 1;
    text = text.slice(skip);
  }
  let offset = start + skip;
  const records: { rec: JsonlBodyRec; start: number }[] = [];
  let jsonlMeta: SessionMeta | undefined;
  const lines = text.split('\n');
  for (const line of lines) {
    const adv = Buffer.byteLength(line, 'utf8') + 1;
    if (line) {
      try {
        const rec = JSON.parse(line) as { type?: string; meta?: SessionMeta };
        if (rec.type === 'meta') jsonlMeta = rec.meta;
        else if (rec.type) records.push({ rec: rec as JsonlBodyRec, start: offset });
      } catch {
        /* incomplete / corrupt */
      }
    }
    offset += adv;
  }
  return { records, jsonlMeta };
}

/** First-line meta only — never the body. */
function readJsonlMetaHead(p: string): SessionMeta | undefined {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const nl = buf.indexOf(0x0a);
      const line = buf.slice(0, nl >= 0 ? nl : n).toString('utf8');
      const rec = JSON.parse(line) as { type?: string; meta?: SessionMeta };
      if (rec.type === 'meta' && rec.meta) return rec.meta;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* missing / corrupt */
  }
  return undefined;
}

export function headHasContent(p: string): boolean {
  if (!fs.existsSync(p)) return false;
  try {
    const st = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf8');
      const lines = text.split('\n');
      if (st.size > n && lines.length > 0) lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          if (recordHasContent(JSON.parse(line))) return true;
        } catch {
          /* skip */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return false;
}

function migrateHasContent(all: SessionMeta[], pathFor: (id: string) => string): SessionMeta[] {
  return all.map((m) => {
    if (m.hasContent === true || m.hasContent === false) return m;
    return { ...m, hasContent: headHasContent(pathFor(m.id)) };
  });
}
