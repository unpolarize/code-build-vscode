import type { ContentBlock, SessionUpdate } from '../../../shared/acpTypes';

/**
 * Normalizes Claude Code `--output-format stream-json` NDJSON lines into ACP-shaped
 * SessionUpdates. Each line is a complete JSON object with a `type` discriminator.
 * See Claude Code headless docs for the message schema.
 */
export interface ClaudeMessage {
  type: string;
  // assistant/user messages
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  // result message
  subtype?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  // system init
  session_id?: string;
}

export class ClaudeNormalizer {
  /** Returns the backend session id once the init message is seen. */
  sessionId?: string;

  parseLine(obj: ClaudeMessage): SessionUpdate[] {
    switch (obj.type) {
      case 'system':
        if (obj.session_id) this.sessionId = obj.session_id;
        return [];
      case 'assistant':
        return this.fromAssistant(obj);
      case 'user':
        return this.fromUser(obj);
      case 'result':
        return [
          {
            kind: 'result',
            stopReason: obj.subtype ?? 'end_turn',
            usage: {
              inputTokens: obj.usage?.input_tokens,
              outputTokens: obj.usage?.output_tokens,
              cacheReadTokens: obj.usage?.cache_read_input_tokens,
              costUsd: obj.total_cost_usd
            }
          }
        ];
      default:
        return [];
    }
  }

  private fromAssistant(obj: ClaudeMessage): SessionUpdate[] {
    const out: SessionUpdate[] = [];
    for (const block of obj.message?.content ?? []) {
      const t = block.type as string;
      if (t === 'text') {
        out.push({ kind: 'agent_message_chunk', content: { type: 'text', text: String(block.text ?? '') } });
      } else if (t === 'thinking') {
        out.push({
          kind: 'agent_thought_chunk',
          content: { type: 'text', text: String(block.thinking ?? '') }
        });
      } else if (t === 'tool_use') {
        out.push({
          kind: 'tool_call',
          toolCall: {
            toolCallId: String(block.id),
            title: String(block.name ?? 'tool'),
            kind: classifyTool(String(block.name ?? '')),
            status: 'in_progress',
            rawInput: block.input
          }
        });
      }
    }
    if (obj.message?.usage) {
      out.push({
        kind: 'usage',
        usage: {
          inputTokens: obj.message.usage.input_tokens,
          outputTokens: obj.message.usage.output_tokens,
          cacheReadTokens: obj.message.usage.cache_read_input_tokens
        }
      });
    }
    return out;
  }

  private fromUser(obj: ClaudeMessage): SessionUpdate[] {
    const out: SessionUpdate[] = [];
    for (const block of obj.message?.content ?? []) {
      if ((block.type as string) === 'tool_result') {
        const content: ContentBlock[] = [];
        const raw = block.content;
        if (typeof raw === 'string') {
          content.push({ type: 'text', text: raw });
        } else if (Array.isArray(raw)) {
          for (const c of raw) {
            if (c && (c as Record<string, unknown>).type === 'text') {
              content.push({ type: 'text', text: String((c as Record<string, unknown>).text ?? '') });
            }
          }
        }
        out.push({
          kind: 'tool_call_update',
          toolCall: {
            toolCallId: String(block.tool_use_id),
            status: block.is_error ? 'failed' : 'completed',
            content
          }
        });
      }
    }
    return out;
  }

  /** Encode a user prompt as a stream-json input line for the CLI stdin. */
  encodeUserMessage(blocks: ContentBlock[]): string {
    const content = blocks.map((b) =>
      b.type === 'text' ? { type: 'text', text: b.text } : b
    );
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
  }
}

function classifyTool(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('glob') || n.includes('grep') || n.includes('search')) return 'read';
  if (n.includes('edit') || n.includes('write') || n.includes('patch')) return 'edit';
  if (n.includes('bash') || n.includes('exec') || n.includes('run')) return 'execute';
  return 'other';
}
