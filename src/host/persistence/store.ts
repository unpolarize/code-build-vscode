import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionUpdate } from '../../shared/acpTypes';
import type { SessionMeta } from '../../shared/protocol';

/**
 * File-backed session store under ~/.codebuild — not VS Code globalState (which
 * doesn't scale and isn't CLI-shareable). Each session is one JSONL transcript;
 * an index.json lists known sessions.
 */
export class SessionStore {
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;

  constructor(root = path.join(os.homedir(), '.codebuild')) {
    this.root = root;
    this.sessionsDir = path.join(root, 'sessions');
    this.indexPath = path.join(root, 'index.json');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private transcriptPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  /**
   * Begin a transcript file with a self-describing meta header. Does NOT add the
   * session to the index yet — an empty chat that's never used shouldn't clutter
   * history. Call commitSession() once the conversation has real content.
   */
  createSession(meta: SessionMeta): void {
    fs.writeFileSync(this.transcriptPath(meta.id), JSON.stringify({ type: 'meta', meta }) + '\n');
  }

  /** Promote a session into the history index (idempotent). */
  commitSession(meta: SessionMeta): void {
    this.upsertIndex(meta);
  }

  /** Update the stored meta (e.g. a derived title) both in the index and the transcript header. */
  updateMeta(meta: SessionMeta): void {
    if (this.isIndexed(meta.id)) this.upsertIndex(meta);
    const p = this.transcriptPath(meta.id);
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return;
    lines[0] = JSON.stringify({ type: 'meta', meta });
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }

  appendUpdate(id: string, update: SessionUpdate): void {
    fs.appendFileSync(this.transcriptPath(id), JSON.stringify({ type: 'update', update }) + '\n');
  }

  appendUserText(id: string, text: string): void {
    fs.appendFileSync(this.transcriptPath(id), JSON.stringify({ type: 'user', text }) + '\n');
  }

  private isIndexed(id: string): boolean {
    return this.list().some((m) => m.id === id);
  }

  /** Load a transcript back into ordered records for UI rehydration. */
  load(id: string): { meta?: SessionMeta; records: { type: string; [k: string]: unknown }[] } {
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

  private upsertIndex(meta: SessionMeta): void {
    const all = this.list().filter((m) => m.id !== meta.id);
    all.unshift(meta);
    fs.writeFileSync(this.indexPath, JSON.stringify(all.slice(0, 500), null, 2));
  }
}
