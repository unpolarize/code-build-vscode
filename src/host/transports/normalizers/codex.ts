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

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: { path: string; old?: string; new?: string }[];
}

export class CodexNormalizer {
  threadId?: string;
  private emittedAssistant = new Set<string>();

  parseLine(ev: CodexEvent): SessionUpdate[] {
    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) this.threadId = ev.thread_id;
        return [];
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
      default:
        return [];
    }
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
