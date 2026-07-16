import type { SessionUpdate, ToolCall, UsageInfo } from '../../src/shared/acpTypes';
import type {
  ActivitySegmentMsg,
  HostToWebview,
  HydrateState,
  PerfHudMsg,
  PerfSnapshotMsg,
  SessionMeta
} from '../../src/shared/protocol';
import { diffStats } from './diff';

/** Image attachment shown alongside a user message — base64 payload so it
 * survives webview reload (no temp files) and can be reused on send. */
export interface ImageAttachment {
  mimeType: string;
  data: string;
  name?: string;
}

/** Single option presented inside an AskUserQuestion question card. */
export interface AskUserOption {
  label: string;
  description?: string;
  preview?: string;
}

/** One question card in an AskUserQuestion tool call (the tool can ask
 * several at once — each gets its own card). */
export interface AskUserQuestionEntry {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserOption[];
}

/** One task in a TodoWrite-style task list. */
export interface TaskEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  activeForm?: string;
}

/** Common timestamp fields on every chat item. `createdAt` is stamped when
 * the item first lands in the items list; `updatedAt` (optional) tracks
 * the last streaming patch (assistant/thought chunks merge into existing
 * items — we keep the first-chunk timestamp but bump updatedAt so a
 * hover tooltip can show both). */
type WithTimestamps = { createdAt: number; updatedAt?: number };

export type ChatItem =
  | (WithTimestamps & {
      kind: 'user';
      id: string;
      text: string;
      images?: ImageAttachment[];
      /** True when the user sent this message while the agent was still
       * generating a response — a mid-stream steer. Rendered with a small
       * "mid-turn" badge so the conversation history shows where the user
       * intervened. */
      interjected?: boolean;
      /** Topic labels from the host-side classifier (when
       * `codeBuild.classifyTurns` is on). Rendered as small chips next
       * to the role line. Populated asynchronously after the
       * end-of-turn `result` event — undefined until classification
       * completes. */
      labels?: string[];
    })
  | (WithTimestamps & { kind: 'assistant'; id: string; text: string })
  | (WithTimestamps & { kind: 'thought'; id: string; text: string })
  | (WithTimestamps & { kind: 'tool'; id: string; tool: ToolCall })
  | (WithTimestamps & { kind: 'plan'; id: string; entries: { content: string; status: string }[] })
  | (WithTimestamps & {
      kind: 'files';
      id: string;
      files: {
        path: string;
        added: number;
        removed: number;
        /** Reconstructed before/after blobs for the agent's edit, when
         * the tool emitted a diff content block. Used by the
         * "Open diff" button to launch the host-side
         * `EditorTools.openDiff`. Capped at 10 KB each so a long
         * file doesn't bloat the transcript. Undefined when the
         * tool didn't emit diff content (rawInput-only fallback). */
        oldText?: string;
        newText?: string;
      }[];
    })
  | (WithTimestamps & { kind: 'error'; id: string; text: string })
  | (WithTimestamps & { kind: 'notice'; id: string; text: string; detail?: string; key?: string })
  | (WithTimestamps & {
      kind: 'askUser';
      id: string;
      toolCallId: string;
      questions: AskUserQuestionEntry[];
      answers: Record<string, string> | null;
    })
  | (WithTimestamps & { kind: 'tasks'; id: string; toolCallId: string; tasks: TaskEntry[] })
  | (WithTimestamps & {
      kind: 'context';
      id: string;
      origin: 'prompt' | 'tool_result' | 'system';
      summary: string;
      sections: Array<{
        label: string;
        body: string;
        chars: number;
        kind?: 'primer' | 'mention' | 'user_text' | 'image' | 'tool_result' | 'system';
      }>;
    });

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
  /** Pending cross-backend carry-over prompt (null when not switching). */
  primerPrompt: {
    turnCount: number;
    fromBackend: string;
    toBackend: string;
    sourceBackendId: string;
    llmSummarySupported: boolean;
  } | null;
  /** Memory inventory snapshot piped through `hydrate`. Drives the
   * small Memory chip in the Header (clickable to open Code Sessions
   * Memory tab where available). */
  memoryEntries: number;
  memoryFiles: number;
  memoryByProvider: Record<string, number>;
  /** Active-question banner master switch from
   * `codeBuild.showActiveQuestionBanner`. Default true on first
   * hydrate so users see the banner without opt-in; flipping the
   * setting to false hides it permanently. */
  showActiveQuestionBanner: boolean;
  /** From `codeBuild.perfDebug` via hydrate. */
  perfDebug: 'off' | 'hud' | 'full';
  perfHud: PerfHudMsg | null;
  activitySegments: ActivitySegmentMsg[];
  activityTurnDurationMs: number;
  perfSnapshot: PerfSnapshotMsg | null;
  perfPanelOpen: boolean;
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
  sessions: [],
  primerPrompt: null,
  memoryEntries: 0,
  memoryFiles: 0,
  memoryByProvider: {},
  showActiveQuestionBanner: true,
  perfDebug: 'hud',
  perfHud: null,
  activitySegments: [],
  activityTurnDurationMs: 0,
  perfSnapshot: null,
  perfPanelOpen: false
};

let seq = 0;
const nextId = () => `i${seq++}`;
/** Now-in-ms helper. Centralised so a future test harness can swap in a
 * deterministic clock without sed'ing every call site. */
const now = (): number => Date.now();

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
        sessions: msg.state.sessions ?? [],
        memoryEntries: msg.state.memoryEntries ?? 0,
        memoryFiles: msg.state.memoryFiles ?? 0,
        memoryByProvider: msg.state.memoryByProvider ?? {},
        showActiveQuestionBanner: msg.state.showActiveQuestionBanner ?? true,
        perfDebug: msg.state.perfDebug ?? 'hud'
      };
    case 'sessionsList':
      return { ...state, sessions: msg.sessions };
    case 'perfHud':
      return { ...state, perfHud: msg.hud };
    case 'activityStrip':
      return {
        ...state,
        activitySegments: msg.segments,
        activityTurnDurationMs: msg.turnDurationMs
      };
    case 'perfSnapshot':
      return { ...state, perfSnapshot: msg.snapshot };
    case 'perfPanelOpen':
      return { ...state, perfPanelOpen: msg.open };
    case 'sessionUpdates': {
      let next = state;
      for (const u of msg.updates) {
        next = applyUpdate(next, u);
      }
      return next;
    }
    case 'notice': {
      const items = state.items.slice();
      items.push({
        kind: 'notice',
        id: nextId(), createdAt: now(),
        text: msg.text,
        detail: msg.detail,
        key: msg.key
      });
      return { ...state, items };
    }
    case 'dismissNotice': {
      const items = state.items.filter(
        (it) => !(it.kind === 'notice' && it.key === msg.key)
      );
      return { ...state, items };
    }
    case 'turnLabels': {
      // Decorate the Nth user bubble (0-based) with classifier labels.
      // The host counts user prompts independently; we walk the items
      // list in order and decorate the matching index. If the index
      // is out of range (item was cleared via /new), no-op.
      const items = state.items.slice();
      let userIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind !== 'user') continue;
        userIdx += 1;
        if (userIdx === msg.turnIndex) {
          items[i] = { ...it, labels: msg.labels };
          break;
        }
      }
      return { ...state, items };
    }
    case 'primerPrompt':
      return {
        ...state,
        primerPrompt: {
          turnCount: msg.turnCount,
          fromBackend: msg.fromBackend,
          toBackend: msg.toBackend,
          sourceBackendId: msg.sourceBackendId,
          llmSummarySupported: msg.llmSummarySupported
        }
      };
    case 'askUserQuestion': {
      // Append a new askUser card to the timeline. We don't merge with any
      // earlier card for the same toolCallId — the agent never re-asks an
      // already-answered call within the same turn.
      const items = state.items.slice();
      items.push({
        kind: 'askUser',
        id: nextId(), createdAt: now(),
        toolCallId: msg.toolCallId,
        questions: msg.questions,
        answers: null
      });
      return { ...state, items };
    }
    case 'contextInjected': {
      const items = state.items.slice();
      items.push({
        kind: 'context',
        id: nextId(), createdAt: now(),
        origin: msg.origin,
        summary: msg.summary,
        sections: msg.sections
      });
      return { ...state, items };
    }
    case 'taskList': {
      // Tasks are a stream of snapshots — each TodoWrite call REPLACES the
      // previous one. Find the most-recent tasks card for this toolCallId
      // and rewrite it in place; otherwise append.
      const items = state.items.slice();
      const lastTasksIdx = items
        .map((it, i) => ({ it, i }))
        .reverse()
        .find(({ it }) => it.kind === 'tasks')?.i;
      const existing = lastTasksIdx != null ? items[lastTasksIdx] : null;
      const next: ChatItem = {
        kind: 'tasks',
        id: existing?.id ?? nextId(),
        // Preserve the original card's createdAt across TodoWrite
        // snapshot rewrites so the timestamp reads "when the
        // checklist FIRST appeared", not "when the latest update
        // landed". updatedAt tracks the latest snapshot for hover
        // detail.
        createdAt: existing?.createdAt ?? now(),
        updatedAt: existing ? now() : undefined,
        toolCallId: msg.toolCallId,
        tasks: msg.tasks
      };
      if (lastTasksIdx != null) items[lastTasksIdx] = next;
      else items.push(next);
      return { ...state, items };
    }
    case 'sessionMeta':
      return { ...state, session: msg.session };
    case 'busy':
      return { ...state, busy: msg.busy };
    case 'sessionUpdate':
      return applyUpdate(state, msg.update);
    case 'fileSuggestions':
      return { ...state, fileSuggestions: msg.suggestions };
    // sessionUpdates handled above (batch)
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
export function appendUser(
  state: ChatState,
  text: string,
  images?: ImageAttachment[],
  interjected?: boolean
): ChatState {
  return {
    ...state,
    items: [...state.items, { kind: 'user', id: nextId(), createdAt: now(), text, images, interjected }],
    busy: true
  };
}

/** Mark an AskUserQuestion card as answered after the user clicks an
 * option. Keeps the card in the timeline so the choice stays visible. */
export function markAskUserAnswered(
  state: ChatState,
  toolCallId: string,
  answers: Record<string, string>
): ChatState {
  const items = state.items.map((it) =>
    it.kind === 'askUser' && it.toolCallId === toolCallId ? { ...it, answers } : it
  );
  return { ...state, items };
}

function applyUpdate(state: ChatState, u: SessionUpdate): ChatState {
  const items = state.items.slice();
  switch (u.kind) {
    case 'agent_message_chunk': {
      const text = blockText(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant') {
        // Preserve createdAt across chunk merges so the bubble's
        // stamp reads "when the assistant STARTED replying", not
        // "when the last token landed". updatedAt carries the
        // latest-chunk time for hover detail.
        items[items.length - 1] = { ...last, text: last.text + text, updatedAt: now() };
      } else {
        items.push({ kind: 'assistant', id: nextId(), createdAt: now(), text });
      }
      return { ...state, items };
    }
    case 'agent_thought_chunk': {
      const text = blockText(u.content);
      // Defense-in-depth: never create a thought item from an empty
      // chunk. Claude occasionally streams a signature-only thinking
      // block whose visible text is empty; the normalizer filters
      // these too but this guards against any future provider that
      // emits the same shape. Without it, the user saw stranded
      // "▶ Thinking…" rows that opened to an empty body.
      if (!text) return state;
      const last = items[items.length - 1];
      if (last && last.kind === 'thought') {
        items[items.length - 1] = { ...last, text: last.text + text, updatedAt: now() };
      } else {
        items.push({ kind: 'thought', id: nextId(), createdAt: now(), text });
      }
      return { ...state, items };
    }
    case 'tool_call': {
      // Suppress the generic ToolCard for tools that have a dedicated
      // purpose-built card (AskUserQuestion, TodoWrite). Rendering both
      // produced the confusing "× AskUserQuestion" red row above the
      // interactive picker — the ToolCard showed the tool_use's
      // pending/failed state while the AskUserQuestionCard rendered
      // the picker below it. The structured card already conveys the
      // semantic state ("answered" / "awaiting answer") so the ToolCard
      // is pure noise.
      const name = u.toolCall.title;
      if (name === 'AskUserQuestion' || name === 'TodoWrite' || name === 'todo_write') {
        return state;
      }
      items.push({ kind: 'tool', id: nextId(), createdAt: now(), tool: u.toolCall });
      return { ...state, items };
    }
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
      items.push({ kind: 'plan', id: nextId(), createdAt: now(), entries: u.entries });
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
        items.push({ kind: 'files', id: nextId(), createdAt: now(), files });
      }
      return {
        ...state,
        items,
        busy: false,
        usage: u.usage ? { ...state.usage, ...u.usage } : state.usage
      };
    }
    case 'error':
      items.push({ kind: 'error', id: nextId(), createdAt: now(), text: u.message });
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
/** Cap each before/after blob at 10 KB so a 5MB-file edit doesn't
 * inflate the transcript. The "Open diff" UI is still useful for
 * larger files via the host-side diff view; the inline blobs here are
 * the fallback when the user wants a quick mini-diff in the card. */
const DIFF_BLOB_CAP = 10_240;
function clipBlob(s: string): string {
  return s.length > DIFF_BLOB_CAP ? s.slice(0, DIFF_BLOB_CAP) + '\n…(truncated)' : s;
}

interface FileChange {
  path: string;
  added: number;
  removed: number;
  oldText?: string;
  newText?: string;
}

function collectModifiedFiles(items: ChatItem[]): FileChange[] {
  const map = new Map<string, FileChange>();
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
      // Capture the before/after blobs so the "Open diff" button can
      // ship them to the host (EditorTools.openDiff). When multiple
      // tool calls touch the same file in one turn, KEEP THE FIRST
      // oldText (earliest snapshot) and the LATEST newText (final
      // state). This is the diff a user actually wants to see — the
      // full delta for that turn, not the per-step micro-diffs.
      if (entry.oldText == null) entry.oldText = clipBlob(d.oldText);
      entry.newText = clipBlob(d.newText);
      map.set(d.path, entry);
    }
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
      items.push({ kind: 'user', id: nextId(), createdAt: now(), text: rec.text });
    } else if (rec.type === 'update' && rec.update) {
      const u = rec.update;
      if (u.kind === 'agent_message_chunk' && u.content?.text) {
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          items[items.length - 1] = { ...last, text: last.text + (u.content.text || ''), updatedAt: now() };
        } else {
          items.push({ kind: 'assistant', id: nextId(), createdAt: now(), text: u.content.text || '' });
        }
      } else if (u.kind === 'tool_call') {
        items.push({ kind: 'tool', id: nextId(), createdAt: now(), tool: u.toolCall });
      } else if (u.kind === 'plan') {
        items.push({ kind: 'plan', id: nextId(), createdAt: now(), entries: u.entries || [] });
      } else if (u.kind === 'error') {
        items.push({ kind: 'error', id: nextId(), createdAt: now(), text: u.message || 'Error' });
      }
    }
  }
  return items;
}
