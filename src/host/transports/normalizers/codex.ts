import type { ContentBlock, SessionUpdate, ToolCall } from '../../../shared/acpTypes';

/**
 * Normalizes OpenAI Codex `codex exec --json` NDJSON events into ACP-shaped
 * SessionUpdates. Codex is spawn-per-prompt: one process per turn, emitting
 * thread.started / turn.started / item.* / turn.completed | turn.failed / error.
 */
export interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  item?: CodexItem;
}

/** Known `item.type` vocabulary (codex exec --json):
 * `assistant_message` (≤0.141) / `agent_message` (≥0.142) — final answer text;
 * `reasoning`, `command_execution`, `file_change`, `patch`;
 * `mcp_tool_call` {server, tool, status, error?} — item.started fires;
 * `web_search` {query} — usually completed-only (no item.started);
 * `todo_list` {items[].text, items[].completed} — started/updated/completed
 * each carry the full snapshot. Kept as `string` — unknown types must fall
 * through to [] rather than fail parsing. */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: { path: string; old?: string; new?: string }[];
  server?: string;
  tool?: string;
  error?: { message?: string } | string;
  query?: string;
  items?: { text?: string; completed?: boolean }[];
}

export class CodexNormalizer {
  /** Native Codex thread id from `thread.started`. Transport also falls back to
   * StartOpts.resumeId for the first-prompt `codex exec resume` argv when this
   * is still unset (session restore) — it does not pre-write this field. */
  threadId?: string;
  private emittedAssistant = new Set<string>();
  /** Tool ids whose opening `tool_call` has been emitted (see openCloseTool). */
  private openedTools = new Set<string>();

  parseLine(ev: CodexEvent): SessionUpdate[] {
    switch (ev.type) {
      case 'thread.started': {
        // Emit `system_init` once per distinct thread id so the host can
        // persist backendSessionId / native / history (dual-write identity).
        // Later thread.started lines with the same id are no-ops — Codex may
        // re-announce the thread across turns without meaning a new session.
        if (!ev.thread_id) return [];
        const firstForId = ev.thread_id !== this.threadId;
        this.threadId = ev.thread_id;
        return firstForId
          ? [{ kind: 'system_init', backendSessionId: ev.thread_id }]
          : [];
      }
      case 'turn.started':
        return [];
      case 'turn.completed':
        return [
          {
            kind: 'result',
            stopReason: 'end_turn',
            usage: {
              inputTokens: ev.usage?.input_tokens,
              outputTokens: ev.usage?.output_tokens,
              cacheReadTokens: ev.usage?.cached_input_tokens
            }
          }
        ];
      case 'turn.failed':
        return [
          { kind: 'error', message: cleanMsg(ev.error?.message ?? 'turn failed') },
          { kind: 'result', stopReason: 'failed' }
        ];
      case 'error':
        return [{ kind: 'error', message: cleanMsg(ev.message ?? 'error') }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        return this.fromItem(ev.type, ev.item);
      default:
        return [];
    }
  }

  private fromItem(evType: string, item?: CodexItem): SessionUpdate[] {
    if (!item) return [];
    const completed = evType === 'item.completed';
    switch (item.type) {
      // codex-cli ≥0.142 renamed assistant_message → agent_message; without
      // the alias the final Codex answer was silently dropped (tracker #14).
      case 'agent_message':
      case 'assistant_message': {
        // Emit once, on completion, to avoid duplicating partial text.
        if (!completed || !item.text) return [];
        const key = item.id ?? item.text;
        if (this.emittedAssistant.has(key)) return [];
        this.emittedAssistant.add(key);
        return [{ kind: 'agent_message_chunk', content: { type: 'text', text: item.text } }];
      }
      case 'reasoning':
        return item.text
          ? [{ kind: 'agent_thought_chunk', content: { type: 'text', text: item.text } }]
          : [];
      case 'command_execution':
        return [commandToolUpdate(item, completed)];
      case 'file_change':
      case 'patch':
        return [fileChangeTool(item, completed)];
      case 'mcp_tool_call':
        return this.openCloseTool(item, completed, {
          title: [item.server, item.tool].filter(Boolean).join('.') || 'mcp',
          kind: 'other',
          failed: item.status === 'failed' || !!item.error
        });
      case 'web_search':
        return this.openCloseTool(item, completed, {
          title: item.query ?? 'web search',
          kind: 'search',
          failed: item.status === 'failed'
        });
      case 'todo_list': {
        // Mirror to the TodoWrite shape: sessionManager.interceptToolCall
        // posts a `taskList` and the webview suppresses the generic ToolCard
        // for title `todo_write`, replacing the checklist card in place.
        // Every event carries the full snapshot, so emit on each.
        if (!Array.isArray(item.items)) return [];
        const todos = item.items.map((t) => ({
          content: t.text ?? '',
          status: t.completed ? 'completed' : 'pending'
        }));
        return [
          {
            kind: 'tool_call',
            toolCall: {
              toolCallId: item.id ?? 'todo',
              title: 'todo_write',
              kind: 'other',
              status: completed ? 'completed' : 'in_progress',
              rawInput: { todos }
            }
          }
        ];
      }
      default:
        return [];
    }
  }

  /** Codex tools that open with item.started and close with item.completed —
   * except when they arrive completed-only (web_search today). The webview
   * no-ops a tool_call_update for an id it never saw, so a completed item
   * whose open event never fired must emit the opening tool_call first,
   * immediately followed by the terminal update. */
  private openCloseTool(
    item: CodexItem,
    completed: boolean,
    shape: { title: string; kind: string; failed: boolean }
  ): SessionUpdate[] {
    const id = item.id ?? shape.title;
    const open: SessionUpdate = {
      kind: 'tool_call',
      toolCall: { toolCallId: id, title: shape.title, kind: shape.kind, status: 'in_progress' }
    };
    if (!completed) {
      if (this.openedTools.has(id)) return []; // item.updated — nothing new to say
      this.openedTools.add(id);
      return [open];
    }
    const close: SessionUpdate = {
      kind: 'tool_call_update',
      toolCall: { toolCallId: id, status: shape.failed ? 'failed' : 'completed' }
    };
    if (this.openedTools.has(id)) return [close];
    return [open, close];
  }
}

function commandToolUpdate(item: CodexItem, completed: boolean): SessionUpdate {
  const id = item.id ?? item.command ?? 'cmd';
  if (!completed) {
    return {
      kind: 'tool_call',
      toolCall: {
        toolCallId: id,
        title: item.command ?? 'command',
        kind: 'execute',
        status: 'in_progress'
      }
    };
  }
  const content: ContentBlock[] = item.aggregated_output
    ? [{ type: 'text', text: item.aggregated_output }]
    : [];
  return {
    kind: 'tool_call_update',
    toolCall: {
      toolCallId: id,
      status: item.exit_code === 0 || item.status === 'completed' ? 'completed' : 'failed',
      content
    }
  };
}

function fileChangeTool(item: CodexItem, completed: boolean): SessionUpdate {
  const id = item.id ?? 'patch';
  const diffs: ContentBlock[] = (item.changes ?? []).map((c) => ({
    type: 'diff' as const,
    path: c.path,
    oldText: c.old ?? '',
    newText: c.new ?? ''
  }));
  const locations = (item.changes ?? []).map((c) => ({ path: c.path }));
  const toolCall: ToolCall = {
    toolCallId: id,
    title: 'Edit files',
    kind: 'edit',
    status: completed ? 'completed' : 'in_progress',
    content: diffs,
    locations
  };
  return completed ? { kind: 'tool_call_update', toolCall } : { kind: 'tool_call', toolCall };
}

/** Codex wraps upstream API errors as a JSON string; surface the human message. */
function cleanMsg(msg: string): string {
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? msg;
  } catch {
    return msg;
  }
}
