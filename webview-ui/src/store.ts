import type { SessionUpdate, ToolCall, UsageInfo } from '../../src/shared/acpTypes';
import type { HostToWebview, HydrateState, SessionMeta } from '../../src/shared/protocol';
import { diffStats } from './diff';

/** Image attachment shown alongside a user message — base64 payload so it
 * survives webview reload (no temp files) and can be reused on send. */
export interface ImageAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images?: ImageAttachment[] }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tool'; id: string; tool: ToolCall }
  | { kind: 'plan'; id: string; entries: { content: string; status: string }[] }
  | { kind: 'files'; id: string; files: { path: string; added: number; removed: number }[] }
  | { kind: 'error'; id: string; text: string };

export interface PendingPermission {
  requestId: string;
  tool: ToolCall;
  options: { optionId: string; name: string; kind: string }[];
}

export interface ChatState {
  hydrated: boolean;
  session: SessionMeta | null;
  backends: HydrateState['backends'];
  allowBypass: boolean;
  items: ChatItem[];
  busy: boolean;
  permission: PendingPermission | null;
  usage: UsageInfo | null;
  /** Per-model usage breakdown — populated from `usage_breakdown` updates.
   * Drives the expanded tooltip in the header. */
  usageBreakdown: UsageInfo[];
  commands: { name: string; description?: string }[];
  fileSuggestions: Array<{ path: string; label?: string }>;
  sessions: SessionMeta[];
}

export const initialState: ChatState = {
  hydrated: false,
  session: null,
  backends: [],
  allowBypass: false,
  items: [],
  busy: false,
  permission: null,
  usage: null,
  usageBreakdown: [],
  commands: [],
  fileSuggestions: [],
  sessions: []
};

let seq = 0;
const nextId = () => `i${seq++}`;

/** Pure reducer: (state, host message) -> next state. Streaming chunks patch in place. */
export function reduce(state: ChatState, msg: HostToWebview): ChatState {
  switch (msg.type) {
    case 'hydrate':
      return {
        ...state,
        hydrated: true,
        session: msg.state.session,
        backends: msg.state.backends,
        allowBypass: msg.state.allowBypass,
        sessions: msg.state.sessions ?? []
      };
    case 'sessionsList':
      return { ...state, sessions: msg.sessions };
    case 'sessionMeta':
      return { ...state, session: msg.session };
    case 'busy':
      return { ...state, busy: msg.busy };
    case 'sessionUpdate':
      return applyUpdate(state, msg.update);
    case 'fileSuggestions':
      return { ...state, fileSuggestions: msg.suggestions };
    case 'historyLoaded': {
      // Replay a previous transcript into the local ChatItem list + update
      // meta. Usage events bundled in the records (sent at the end by
      // external transcript loaders) are extracted here so the header's
      // cost display + per-model tooltip reflect the imported session's
      // lifetime spend immediately on open.
      const { usage, usageBreakdown } = extractUsageFromRecords(msg.records);
      return {
        ...state,
        session: msg.meta,
        items: replayRecordsToItems(msg.records),
        usage: usage ?? null,
        usageBreakdown,
        busy: false
      };
    }
    default:
      return state;
  }
}

/** Append a locally-echoed user message immediately on send. Optional
 * attachments render as image tiles below the text body. */
export function appendUser(state: ChatState, text: string, images?: ImageAttachment[]): ChatState {
  return {
    ...state,
    items: [...state.items, { kind: 'user', id: nextId(), text, images }],
    busy: true
  };
}

function applyUpdate(state: ChatState, u: SessionUpdate): ChatState {
  const items = state.items.slice();
  switch (u.kind) {
    case 'agent_message_chunk': {
      const text = blockText(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant') {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: 'assistant', id: nextId(), text });
      }
      return { ...state, items };
    }
    case 'agent_thought_chunk': {
      const text = blockText(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === 'thought') {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: 'thought', id: nextId(), text });
      }
      return { ...state, items };
    }
    case 'tool_call':
      items.push({ kind: 'tool', id: nextId(), tool: u.toolCall });
      return { ...state, items };
    case 'tool_call_update': {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'tool' && it.tool.toolCallId === u.toolCall.toolCallId) {
          items[i] = { ...it, tool: { ...it.tool, ...u.toolCall } };
          break;
        }
      }
      return { ...state, items };
    }
    case 'plan':
      items.push({ kind: 'plan', id: nextId(), entries: u.entries });
      return { ...state, items };
    case 'available_commands_update':
      return { ...state, commands: u.commands };
    case 'usage':
      return { ...state, usage: { ...state.usage, ...u.usage } };
    case 'usage_breakdown':
      // Imported transcript replays send a single breakdown that REPLACES
      // (not patches) state.usageBreakdown — the new array IS the full set.
      // Live sessions don't currently emit this; when they do we'll need to
      // decide whether to accumulate per-turn entries or sum into per-model
      // slots. Replace is the correct semantics for the import case today.
      return { ...state, usageBreakdown: u.entries };
    case 'result': {
      const files = collectModifiedFiles(items);
      if (files.length) {
        items.push({ kind: 'files', id: nextId(), files });
      }
      return {
        ...state,
        items,
        busy: false,
        usage: u.usage ? { ...state.usage, ...u.usage } : state.usage
      };
    }
    case 'error':
      items.push({ kind: 'error', id: nextId(), text: u.message });
      return { ...state, items, busy: false };
    case 'permission_request':
      return {
        ...state,
        permission: { requestId: u.requestId, tool: u.toolCall, options: u.options }
      };
    case 'current_mode_update':
      return state.session
        ? { ...state, session: { ...state.session, mode: u.mode } }
        : state;
    default:
      return state;
  }
}

function blockText(content: { type: string; text?: string }): string {
  return content.type === 'text' ? content.text ?? '' : '';
}

/** Tools that write to disk across all supported agent CLIs. Keys are
 * matched against `tool.title` (which holds the agent's tool name). The
 * value is the input-property name that carries the file path. */
const EDIT_TOOLS: Record<string, string[]> = {
  // Claude Code
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  // Grok / Codex / ACP-style names
  search_replace: ['file_path'],
  write: ['filePath', 'file_path'],
  str_replace_editor: ['path'],
  edit_file: ['path', 'file_path'],
  apply_patch: ['file_path']
};

function fileFromToolInput(toolName: string, rawInput: unknown): string | null {
  const keys = EDIT_TOOLS[toolName];
  if (!keys || typeof rawInput !== 'object' || rawInput === null) return null;
  for (const k of keys) {
    const v = (rawInput as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Scan the tool items produced in the current turn (back to the last user message)
 * and aggregate the files they edited. Three sources, in priority order:
 *   1. Diff content blocks on the tool call (most precise — has line counts).
 *   2. Tool name + rawInput path lookup (`Edit.file_path`, `write.filePath`,
 *      etc.) — catches edits whose content blocks are text-only tool_results.
 *   3. tool.locations[].path (legacy fallback) for tools that fill it in.
 */
function collectModifiedFiles(items: ChatItem[]): { path: string; added: number; removed: number }[] {
  const map = new Map<string, { path: string; added: number; removed: number }>();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user' || it.kind === 'files') break; // turn boundary
    if (it.kind !== 'tool') continue;
    const diffs = (it.tool.content ?? []).filter(
      (b): b is { type: 'diff'; path: string; oldText: string; newText: string } => b.type === 'diff'
    );
    for (const d of diffs) {
      const { added, removed } = diffStats(d.oldText, d.newText);
      const entry = map.get(d.path) ?? { path: d.path, added: 0, removed: 0 };
      entry.added += added;
      entry.removed += removed;
      map.set(d.path, entry);
    }
    // Edit/write tool whose result was text-only (no diff content block):
    // pull the file path from the tool's name + raw input. Lets the
    // "Modified files" tile appear for grok / claude tools that don't
    // emit diff blocks (Edit, Write, search_replace, etc.).
    if (!diffs.length) {
      const pathFromInput = fileFromToolInput(it.tool.title, it.tool.rawInput);
      if (pathFromInput && !map.has(pathFromInput)) {
        map.set(pathFromInput, { path: pathFromInput, added: 0, removed: 0 });
      } else if (it.tool.kind === 'edit' && it.tool.locations?.length) {
        for (const loc of it.tool.locations) {
          if (!map.has(loc.path)) map.set(loc.path, { path: loc.path, added: 0, removed: 0 });
        }
      }
    }
  }
  return Array.from(map.values());
}

/** Convert stored transcript records (from SessionStore.load) into the UI ChatItem list. */
/** Pull usage info out of a historyLoaded records[] payload. The transcript
 * loader appends a final `usage_breakdown` (per-model array) + `usage`
 * (totals) so this function just looks for the last occurrence of each. */
function extractUsageFromRecords(
  records: Array<{ type: string; text?: string; update?: any }>
): { usage?: UsageInfo; usageBreakdown: UsageInfo[] } {
  let usage: UsageInfo | undefined;
  let usageBreakdown: UsageInfo[] = [];
  for (const rec of records) {
    if (rec.type !== 'update' || !rec.update) continue;
    const u = rec.update;
    if (u.kind === 'usage' && u.usage) usage = u.usage;
    else if (u.kind === 'usage_breakdown' && Array.isArray(u.entries)) usageBreakdown = u.entries;
  }
  return { usage, usageBreakdown };
}

function replayRecordsToItems(records: Array<{ type: string; text?: string; update?: any }>): ChatItem[] {
  const items: ChatItem[] = [];
  for (const rec of records) {
    if (rec.type === 'user' && rec.text) {
      items.push({ kind: 'user', id: nextId(), text: rec.text });
    } else if (rec.type === 'update' && rec.update) {
      const u = rec.update;
      if (u.kind === 'agent_message_chunk' && u.content?.text) {
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          items[items.length - 1] = { ...last, text: last.text + (u.content.text || '') };
        } else {
          items.push({ kind: 'assistant', id: nextId(), text: u.content.text || '' });
        }
      } else if (u.kind === 'tool_call') {
        items.push({ kind: 'tool', id: nextId(), tool: u.toolCall });
      } else if (u.kind === 'plan') {
        items.push({ kind: 'plan', id: nextId(), entries: u.entries || [] });
      } else if (u.kind === 'error') {
        items.push({ kind: 'error', id: nextId(), text: u.message || 'Error' });
      }
    }
  }
  return items;
}
