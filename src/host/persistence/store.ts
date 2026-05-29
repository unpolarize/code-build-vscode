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

  createSession(meta: SessionMeta): void {
    this.upsertIndex(meta);
    // Write a header line so the transcript is self-describing.
    fs.writeFileSync(this.transcriptPath(meta.id), JSON.stringify({ type: 'meta', meta }) + '\n');
  }

  appendUpdate(id: string, update: SessionUpdate): void {
    fs.appendFileSync(this.transcriptPath(id), JSON.stringify({ type: 'update', update }) + '\n');
  }

  appendUserText(id: string, text: string): void {
    fs.appendFileSync(this.transcriptPath(id), JSON.stringify({ type: 'user', text }) + '\n');
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
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as SessionMeta[];
    } catch {
      return [];
    }
  }

  private upsertIndex(meta: SessionMeta): void {
    const all = this.list().filter((m) => m.id !== meta.id);
    all.unshift(meta);
    fs.writeFileSync(this.indexPath, JSON.stringify(all.slice(0, 500), null, 2));
  }
}
