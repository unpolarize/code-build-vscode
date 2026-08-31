// Progressive tool-activity "now line" — a one-line `verb target · Ns`
// narration for quiet backends (Codex/Grok compress activity into a
// spinner; Claude already streams verbose text). Shared between host
// (NowLineTracker drives posts off the SessionUpdate stream) and the
// webview (renders the strip and owns the 1 Hz elapsed tick). Pure —
// no vscode or webview-ui imports (the host must not reach into
// webview-ui/src/toolPreview.ts, so the thin command/target helpers
// are duplicated here).
import type { SessionUpdate, ToolCall } from './acpTypes';

/** Verb taxonomy v1. `working`/`waiting` are deliberately absent — the
 * tracker only posts on tool open/close transitions, so there is never
 * a moment it narrates without a concrete tool. */
export type NowVerb = 'run' | 'edit' | 'read' | 'search' | 'mcp' | 'plan';

export interface NowLineInfo {
  verb: NowVerb;
  target: string;
  /** Wall-clock open time — the webview derives elapsed locally
   * (`Date.now() - startedAtMs`); the host never ticks per second. */
  startedAtMs: number;
}

/** Middle-ellipsis so both the head (command/binary) and the tail
 * (file/arg) stay readable on one ~72–80 char line. Never wraps. */
export function middleEllipsis(text: string, max = 72): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function rawString(raw: unknown, ...keys: string[]): string | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of keys) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Map an ACP tool_call to `{verb, target}`. Kind wins (normalizers set
 * it for all three backends); title patterns fill the gaps (`server.tool`
 * mcp titles, `todo_write` plan mirror). */
export function describeToolCall(tc: ToolCall): { verb: NowVerb; target: string } {
  const title = (tc.title ?? '').trim();
  const loc = tc.locations?.[0]?.path;
  const command = rawString(tc.rawInput, 'command', 'cmd');
  switch (tc.kind) {
    case 'execute':
      return { verb: 'run', target: command ? command.replace(/\s+/g, ' ') : title || 'command' };
    case 'edit':
      return { verb: 'edit', target: loc ? basename(loc) : title || 'file' };
    case 'read':
      return { verb: 'read', target: loc ? basename(loc) : title || 'file' };
    case 'search':
    case 'fetch':
      return {
        verb: 'search',
        target: rawString(tc.rawInput, 'query', 'pattern', 'url') ?? title ?? ''
      };
    default:
      break;
  }
  if (title === 'todo_write' || title === 'plan' || tc.kind === 'think') {
    return { verb: 'plan', target: 'task list' };
  }
  // Codex mcp_tool_call normalizes to kind 'other' with a `server.tool` title.
  if (/^[\w-]+\.[\w.-]+$/.test(title)) return { verb: 'mcp', target: title };
  if (command) return { verb: 'run', target: command.replace(/\s+/g, ' ') };
  return { verb: 'run', target: title || 'tool' };
}

/** The rendered line (webview appends ` · Ns` itself off startedAtMs).
 * Loose verb type — the wire format carries plain strings. */
export function formatNowLine(now: { verb: string; target: string }, max = 72): string {
  return middleEllipsis(`${now.verb} ${now.target}`.trim(), max);
}

/** Tracks open tool calls off the live SessionUpdate stream and posts the
 * now-line ONLY on open/close transitions — zero posts while a long tool
 * runs (the acceptance bar: no host traffic during a quiet in_progress
 * window). Display rule: most recently opened still-open tool wins;
 * closing it falls back to the previous one; closing the last posts null.
 *
 * `isEnabled` is re-read at every transition (perfDebug pattern) so a
 * live `codeBuild.progressiveActivity` change applies without reload —
 * including posting one clearing null when the user turns it off
 * mid-turn. Cancel paths must call `clear()` explicitly: a soft ACP
 * cancel may never emit result/error. */
export class NowLineTracker {
  private readonly open = new Map<string, NowLineInfo>();
  private postedId: string | null | undefined = undefined;

  constructor(
    private readonly opts: {
      post: (now: NowLineInfo | null) => void;
      isEnabled: () => boolean;
    }
  ) {}

  onUpdate(update: SessionUpdate, nowMs: number): void {
    switch (update.kind) {
      case 'tool_call': {
        const tc = update.toolCall;
        if (tc.status === 'completed' || tc.status === 'failed') {
          // Completed-only arrival (Codex web_search): the card pair is a
          // tool_call followed by a completed update — never narrate it.
          break;
        }
        if (!this.open.has(tc.toolCallId)) {
          this.open.set(tc.toolCallId, { ...describeToolCall(tc), startedAtMs: nowMs });
        }
        this.sync();
        break;
      }
      case 'tool_call_update': {
        const status = update.toolCall.status;
        if (status === 'completed' || status === 'failed') {
          if (this.open.delete(update.toolCall.toolCallId)) this.sync();
        }
        break;
      }
      case 'result':
      case 'error':
        this.clear();
        break;
      default:
        break;
    }
  }

  /** Turn teardown that may never see result/error (Stop button, governor
   * hard-stop, session teardown, new prompt arming). Always leaves the
   * webview cleared. */
  clear(): void {
    this.open.clear();
    this.sync();
  }

  /** Post iff the displayed entry changed since the last post. */
  private sync(): void {
    if (!this.opts.isEnabled()) {
      // Disabled (or auto→Claude): never post — except one null to take
      // down a line that was visible before a live setting change.
      if (this.postedId !== undefined && this.postedId !== null) {
        this.opts.post(null);
        this.postedId = null;
      }
      return;
    }
    let topId: string | null = null;
    let top: NowLineInfo | null = null;
    for (const [id, info] of this.open) {
      topId = id;
      top = info;
    }
    if (topId === this.postedId) return;
    // First-ever sync with nothing open: stay silent (undefined ≠ null).
    if (topId === null && this.postedId === undefined) return;
    this.opts.post(top);
    this.postedId = topId;
  }
}
