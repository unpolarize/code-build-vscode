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
  is_error?: boolean;
  error?: string;
  result?: string;
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
      case 'system': {
        if (!obj.session_id) return [];
        // Capture the native session id for `--resume` regardless of how
        // many system lines claude emits.
        const firstForId = obj.session_id !== this.sessionId;
        this.sessionId = obj.session_id;
        // Emit the `system_init` UPDATE only ONCE per backend session id.
        // Claude re-emits `system` lines throughout a turn (subtype
        // 'thinking_tokens', status pings, etc.), each carrying the SAME
        // session_id. The previous code surfaced a system_init for EVERY
        // one — hundreds-to->1000 per session (measured 1109 in the field)
        // — which (a) spammed the store's synchronous appendFileSync on the
        // hot path and (b) defeated mid-turn stall detection, because each
        // bogus event looked like fresh agent progress and reset the
        // watchdog. The host still needs the FIRST one to persist the
        // resume id on SessionMeta (sessionManager.captureBackendSessionId).
        return firstForId ? [{ kind: 'system_init', backendSessionId: obj.session_id }] : [];
      }
      case 'assistant':
        return this.fromAssistant(obj);
      case 'user':
        return this.fromUser(obj);
      case 'result': {
        // Claude emits `result` at end-of-turn. When the turn FAILED
        // (context overflow, tool-call abort, rate limit) the line still
        // says type=result but flips is_error=true and stuffs a reason
        // into `error` or `result`. The prior normalizer surfaced only
        // the `result` SessionUpdate, which the reducer used to clear
        // `busy` but produced no visible bubble — so the user saw
        // "working…" disappear with NO feedback (this is the silent
        // "prompt is too long" the user reported). We now emit BOTH a
        // result (clears busy + carries usage) AND a structured error
        // (red bubble naming the actual reason).
        const updates: SessionUpdate[] = [
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
        const errorLike = obj.is_error === true || /error/i.test(obj.subtype ?? '');
        if (errorLike) {
          const reason = (obj.error || obj.result || obj.subtype || 'unknown').toString();
          updates.push({
            kind: 'error',
            message: `Claude returned an error mid-turn: ${reason}`
          });
        }
        return updates;
      }
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
        // Filter empty thinking blocks. Claude sometimes emits a
        // thinking block whose only content is a `signature` field
        // (continuation marker) with no actual `thinking` text —
        // pushing that as a thought chunk gave the user empty
        // "▶ Thinking…" rows that wouldn't expand to anything because
        // the body genuinely was empty. Skip the chunk entirely when
        // the text is empty.
        const text = String(block.thinking ?? '');
        if (text.trim()) {
          out.push({
            kind: 'agent_thought_chunk',
            content: { type: 'text', text }
          });
        }
      } else if (t === 'tool_use') {
        const name = String(block.name ?? 'tool');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const diff = synthesizeDiff(name, input);
        out.push({
          kind: 'tool_call',
          toolCall: {
            toolCallId: String(block.id),
            title: name,
            kind: classifyTool(name),
            status: 'in_progress',
            rawInput: block.input,
            content: diff ? [diff] : undefined,
            locations: typeof input.file_path === 'string' ? [{ path: input.file_path }] : undefined
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

  /** Encode a user prompt as a stream-json input line for the CLI stdin.
   *
   * Anthropic's Messages API accepts a closed set of content-block types
   * (text, image, tool_use, tool_result, document, thinking, …). Our
   * internal ContentBlock uses additional ACP shapes (resource_link,
   * diff) that grok / ACP backends accept directly — sending them
   * verbatim to claude triggers a 400:
   *   "Input tag 'resource_link' found using 'type' does not match any
   *    of the expected tags: ..."
   *
   * Shape each non-text block into claude's expected form here:
   *   - resource_link → inline text `@<path>` so the model resolves
   *     the reference via its own Read tool (claude code's stream-json
   *     mode does NOT pre-process @-mentions; it forwards JSON to the
   *     Messages API as-is).
   *   - image → wrap `data` in the API's `source: {type, media_type,
   *     data}` envelope.
   *   - tool_result → pass through (already in API shape).
   *   - diff / unknown → drop with a one-line fallback text so the
   *     turn doesn't break.
   */
  encodeUserMessage(blocks: ContentBlock[]): string {
    const content = blocks
      .map((b) => this.shapeContentBlock(b))
      .filter((b): b is Record<string, unknown> => b !== null);
    return JSON.stringify({ type: 'user', message: { role: 'user', content } });
  }

  private shapeContentBlock(b: ContentBlock): Record<string, unknown> | null {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'resource_link': {
        // Strip a leading file:// scheme so the @-mention reads as a
        // plain workspace path. browser://current is expanded into an
        // explicit personal-profile instruction (zhirafovod@gmail.com).
        if (
          b.uri === 'browser://current' ||
          b.uri === 'web://current' ||
          b.uri.startsWith('browser:')
        ) {
          return {
            type: 'text',
            text:
              '[Browser context: use the user\'s real Chrome profile ' +
              '(zhirafovod@gmail.com). Prefer chrome-devtools MCP with autoConnect/CDP ' +
              'or playwright attached to that profile — never a fresh isolated Chromium. ' +
              'If CDP is down, run ~/docs/scripts/chrome-personal-debug.sh after quitting Chrome once.]'
          };
        }
        const ref = b.uri.startsWith('file://') ? b.uri.slice('file://'.length) : b.uri;
        return { type: 'text', text: `@${ref}` };
      }
      case 'image':
        return {
          type: 'image',
          source: { type: 'base64', media_type: b.mimeType, data: b.data }
        };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: b.content
        };
      case 'diff':
        // diff blocks are a tool-call output shape; they shouldn't
        // appear in user input but if they do, render the file path
        // as a hint so the turn isn't silently empty.
        return { type: 'text', text: `(diff for ${b.path})` };
      default:
        return null;
    }
  }
}

/** Build a diff content block from an edit/write tool's input, when recognizable. */
function synthesizeDiff(name: string, input: Record<string, unknown>): ContentBlock | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (!path) return undefined;
  const n = name.toLowerCase();
  if (n === 'edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return { type: 'diff', path, oldText: input.old_string, newText: input.new_string };
  }
  if (n === 'write' && typeof input.content === 'string') {
    return { type: 'diff', path, oldText: '', newText: input.content };
  }
  return undefined;
}

function classifyTool(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('glob') || n.includes('grep') || n.includes('search')) return 'read';
  if (n.includes('edit') || n.includes('write') || n.includes('patch')) return 'edit';
  if (n.includes('bash') || n.includes('exec') || n.includes('run')) return 'execute';
  return 'other';
}
