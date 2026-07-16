import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionUpdate } from '../../shared/acpTypes';
import type { SessionMeta } from '../../shared/protocol';

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

  constructor(root = path.join(os.homedir(), '.codebuild'), flushMs = 50) {
    this.root = root;
    this.sessionsDir = path.join(root, 'sessions');
    this.indexPath = path.join(root, 'index.json');
    this.flushMs = flushMs;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
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
    fs.writeFileSync(this.transcriptPath(meta.id), JSON.stringify({ type: 'meta', meta }) + '\n');
  }

  /** Promote a session into the history index (idempotent). */
  commitSession(meta: SessionMeta): void {
    this.upsertIndex(meta);
  }

  /** Update the stored meta (e.g. a derived title) both in the index and the transcript header. */
  updateMeta(meta: SessionMeta): void {
    this.flushSync(meta.id);
    if (this.isIndexed(meta.id)) this.upsertIndex(meta);
    const p = this.transcriptPath(meta.id);
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return;
    lines[0] = JSON.stringify({ type: 'meta', meta });
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }

  appendUpdate(id: string, update: SessionUpdate): void {
    this.enqueue(id, JSON.stringify({ type: 'update', update }) + '\n');
  }

  appendUserText(id: string, text: string): void {
    this.enqueue(id, JSON.stringify({ type: 'user', text }) + '\n');
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
    return this.list().some((m) => m.id === id);
  }

  /** Load a transcript back into ordered records for UI rehydration. */
  load(id: string): { meta?: SessionMeta; records: { type: string; [k: string]: unknown }[] } {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    if (!fs.existsSync(p)) return { records: [] };
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const records: { type: string; [k: string]: unknown }[] = [];
    let meta: SessionMeta | undefined;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'meta') meta = rec.meta;
        else records.push(rec);
      } catch {
        /* skip corrupt line */
      }
    }
    return { meta, records };
  }

  list(): SessionMeta[] {
    // Flush everything so hasContent sees latest writes.
    this.flushSync();
    if (!fs.existsSync(this.indexPath)) return [];
    try {
      const all = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionMeta[];
      // Defensively hide sessions whose transcript has no real content.
      return all.filter((m) => this.hasContent(m.id));
    } catch {
      return [];
    }
  }

  /**
   * True if the transcript has real conversation — a user message or substantive
   * agent output — not just connection noise (e.g. available_commands_update that
   * the agent emits on connect before any prompt).
   */
  hasContent(id: string): boolean {
    this.flushSync(id);
    const p = this.transcriptPath(id);
    if (!fs.existsSync(p)) return false;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { type?: string; update?: { kind?: string } };
        if (rec.type === 'user') return true;
        if (rec.type === 'update') {
          const k = rec.update?.kind;
          if (
            k === 'agent_message_chunk' ||
            k === 'agent_thought_chunk' ||
            k === 'tool_call' ||
            k === 'plan'
          ) {
            return true;
          }
        }
      } catch {
        /* skip */
      }
    }
    return false;
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
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return p;
  }

  private upsertIndex(meta: SessionMeta): void {
    // Avoid recursive flushSync from list() while writing — read raw index.
    let all: SessionMeta[] = [];
    if (fs.existsSync(this.indexPath)) {
      try {
        all = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionMeta[];
      } catch {
        all = [];
      }
    }
    all = all.filter((m) => m.id !== meta.id);
    all.unshift(meta);
    fs.writeFileSync(this.indexPath, JSON.stringify(all.slice(0, 500), null, 2));
  }

  dispose(): void {
    this.flushSync();
  }
}
