// External session scanners: enumerate sessions produced by upstream CLIs
// (Claude Code under ~/.claude/projects/, Grok Build under ~/.grok/sessions/)
// so they can appear in code-build's history picker alongside our own
// ~/.codebuild sessions. Each scanner returns a SessionMeta-shaped record
// tagged with `source` so the history command can dispatch resume
// correctly: claude sessions resume via `--resume <id>`; grok sessions
// start fresh (no documented external resume flag) but the listing alone
// is useful as a "what was I working on" surface.
//
// Output rules:
//   - Skip ~/.grok summaries whose `session_kind === 'claude_import'` —
//     they're inferior copies of authentic claude sessions, sharing the
//     same UUID, and would create confusing duplicates in the picker.
//   - Decode the urlencoded cwd folder for grok; decode the dash-encoded
//     project dir name for claude (best-effort, lossy on paths containing
//     literal dashes).
//   - Title: first user message text for claude (first JSONL line);
//     `generated_title || session_summary || first user msg` for grok.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { BackendId } from '../../shared/acpTypes';
import type { SessionMeta, SessionSource } from '../../shared/protocol';

const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const GROK_ROOT = path.join(os.homedir(), '.grok', 'sessions');

const TITLE_MAX = 80;

/** Decode the `~/.claude/projects/-Users-...` dir name back to a real path.
 * Lossy when the path itself contains literal `-` but round-trips for
 * typical layouts (`~/docs`, `~/projects/<repo>`). */
function decodeClaudeProjectDir(projectDirName: string): string {
  if (!projectDirName.startsWith('-')) return projectDirName;
  return '/' + projectDirName.slice(1).replace(/-/g, '/');
}

/** URL-decode the grok per-cwd folder name (e.g. `%2FUsers%2Fme%2Fdocs`). */
function decodeGrokCwd(folderName: string): string {
  try {
    return decodeURIComponent(folderName);
  } catch {
    return folderName;
  }
}

function truncateTitle(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > TITLE_MAX ? oneLine.slice(0, TITLE_MAX - 1) + '…' : oneLine;
}

/** Pull the first user message from a Claude Code JSONL file. Reads only
 * up to the first matching line so this is cheap even on multi-MB transcripts. */
function firstClaudeUserText(jsonlPath: string): string {
  try {
    // Stream up to 64KB — enough to capture the first user line in 99% of
    // cases without slurping a multi-MB file just for a title preview.
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytesRead).toString('utf8');
    for (const line of head.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        if (obj.type !== 'user') continue;
        const c = obj.message?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          const text = (c[0] as { type?: string; text?: string } | undefined)?.text;
          if (text) return text;
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* file unreadable */
  }
  return '';
}

/** Enumerate Claude Code sessions on disk. One per `<projectDir>/<uuid>.jsonl`. */
export function listClaudeSessions(): SessionMeta[] {
  if (!fs.existsSync(CLAUDE_ROOT)) return [];
  const out: SessionMeta[] = [];
  for (const projectDir of safeReaddir(CLAUDE_ROOT)) {
    const projectPath = path.join(CLAUDE_ROOT, projectDir);
    if (!isDir(projectPath)) continue;
    const cwd = decodeClaudeProjectDir(projectDir);
    for (const file of safeReaddir(projectPath)) {
      if (!file.endsWith('.jsonl')) continue;
      if (file.startsWith('.')) continue;
      if (file.includes('sessions-index') || file.includes('history')) continue;
      const filePath = path.join(projectPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const sessionId = file.replace(/\.jsonl$/, '');
      const title = truncateTitle(firstClaudeUserText(filePath)) || `claude · ${sessionId.slice(0, 8)}`;
      out.push({
        id: sessionId,
        backend: 'claude',
        title,
        mode: 'default',
        cwd,
        createdAt: stat.mtimeMs,
        source: 'claude',
        externalPath: filePath
      });
    }
  }
  return out;
}

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
  current_model_id?: string;
  session_kind?: string;
}

/** Enumerate Grok Build sessions on disk. One per
 * `<urlencoded-cwd>/<uuid>/summary.json + chat_history.jsonl`. Skips
 * `session_kind === 'claude_import'` to avoid duplicating claude rows.  */
export function listGrokSessions(): SessionMeta[] {
  if (!fs.existsSync(GROK_ROOT)) return [];
  const out: SessionMeta[] = [];
  for (const cwdDir of safeReaddir(GROK_ROOT)) {
    const cwdPath = path.join(GROK_ROOT, cwdDir);
    if (!isDir(cwdPath)) continue;
    const cwd = decodeGrokCwd(cwdDir);
    for (const sessionDir of safeReaddir(cwdPath)) {
      const sessionPath = path.join(cwdPath, sessionDir);
      if (!isDir(sessionPath)) continue;
      const summaryPath = path.join(sessionPath, 'summary.json');
      const chatPath = path.join(sessionPath, 'chat_history.jsonl');
      if (!fs.existsSync(summaryPath) || !fs.existsSync(chatPath)) continue;
      let summary: GrokSummary;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as GrokSummary;
      } catch {
        continue;
      }
      if (summary.session_kind === 'claude_import') continue;
      const id = summary.info?.id || sessionDir;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(chatPath).mtimeMs;
      } catch {
        mtimeMs = Date.parse(summary.last_active_at ?? summary.updated_at ?? summary.created_at ?? '') || Date.now();
      }
      const title =
        truncateTitle(summary.generated_title ?? '') ||
        truncateTitle(summary.session_summary ?? '') ||
        `grok · ${id.slice(0, 8)}`;
      out.push({
        id,
        backend: 'grok',
        title,
        mode: 'default',
        cwd: summary.info?.cwd ?? cwd,
        createdAt: mtimeMs,
        source: 'grok',
        externalPath: chatPath
      });
    }
  }
  return out;
}

/** Merge code-build's local list with external claude + grok lists. Sorted
 * newest-first by createdAt. The caller (history picker) decides how many
 * to show. */
export function listAllSessions(local: SessionMeta[]): SessionMeta[] {
  const claude = listClaudeSessions();
  const grok = listGrokSessions();
  // Dedupe by (source, id) — local sessions never collide with external,
  // and external sources have disjoint UUIDs (modulo grok's claude_import
  // which we filter above).
  const all = [...local.map((m) => ({ ...m, source: m.source ?? ('codebuild' as SessionSource) })), ...claude, ...grok];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

// --- tiny helpers ---

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Re-export the BackendId / SessionSource just so callers don't need a
// separate import when they hold a SessionMeta from this module.
export type { BackendId, SessionSource };
