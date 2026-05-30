// Transcript replay for sessions imported from upstream coding-agent CLIs.
//
// Code-build's own webview rehydrates from `historyLoaded` records — an array
// of `{type: 'user', text}` and `{type: 'update', update: SessionUpdate}`
// items. Local sessions in ~/.codebuild already produce these; this module
// converts the upstream Claude Code JSONL and Grok Build chat_history.jsonl
// into the same shape so an external session feels just like a native resume.
//
// Cost accounting is rolled up per model (claude only — grok doesn't record
// per-turn token usage in chat_history.jsonl). Anthropic public list prices
// are baked in below; if those drift we re-tune in one place. Local-model
// usage (Ollama, transformers.js) would carry `provider: 'local'` and zero
// cost; none of those event types exist in upstream CLI transcripts today
// so we don't synthesize them here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ContentBlock, SessionUpdate, ToolCall, UsageInfo } from '../../shared/acpTypes';

/** One element of the `records[]` array `historyLoaded` consumes. Matches
 * the shape `SessionStore` writes to local JSONLs. */
export type ReplayRecord =
  | { type: 'user'; text: string }
  | { type: 'update'; update: SessionUpdate };

const CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const GROK_SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions');

// Anthropic list prices in USD per 1M tokens. Tuned for Opus 4.x — caller
// can pass a `priceTable` override to handle Sonnet/Haiku separately.
export const CLAUDE_RATES = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheCreation: 18.75
};

/** Encode a cwd to claude-code's project directory naming: prepend `-`,
 * then replace every `/` with `-`. Lossy on paths containing `/` AND `-`
 * but round-trips for typical layouts (`/Users/me/docs` → `-Users-me-docs`). */
export function claudeProjectDirForCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/** Compute the canonical claude jsonl path from a cwd + session id. */
export function claudeJsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(CLAUDE_PROJECTS_ROOT, claudeProjectDirForCwd(cwd), `${sessionId}.jsonl`);
}

/** Compute the canonical grok chat_history.jsonl path. */
export function grokChatPathFor(cwd: string, sessionId: string): string {
  return path.join(GROK_SESSIONS_ROOT, encodeURIComponent(cwd), sessionId, 'chat_history.jsonl');
}

interface ContentText { type: 'text'; text: string }
interface ContentToolUse { type: 'tool_use'; id: string; name: string; input: unknown }
interface ContentToolResult { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const obj = b as { type?: string; text?: string };
        if (obj?.type === 'text') return obj.text ?? '';
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .map((b) => (b?.type === 'text' ? b.text ?? '' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Compute the cost for a single Claude turn's usage record. */
export function claudeTurnCost(
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number {
  return (
    (inputTokens * CLAUDE_RATES.input +
      outputTokens * CLAUDE_RATES.output +
      cacheReadTokens * CLAUDE_RATES.cacheRead +
      cacheCreationTokens * CLAUDE_RATES.cacheCreation) /
    1_000_000
  );
}

export interface ReplayResult {
  records: ReplayRecord[];
  totals: UsageInfo;
  /** Per-model breakdown of token usage for the imported session. Empty for
   * grok sessions (no per-turn token data in chat_history.jsonl). */
  byModel: UsageInfo[];
}

/** Parse a Claude Code JSONL transcript and emit webview-replay records +
 * per-model token totals. Tolerates malformed lines (skips them) so a
 * partial transcript still loads. */
export function loadClaudeHistory(jsonlPath: string): ReplayResult | null {
  if (!fs.existsSync(jsonlPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }

  const records: ReplayRecord[] = [];
  const byModel = new Map<string, UsageInfo>();
  const pendingToolCalls = new Map<string, ToolCall>();

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // User turn — either a real prompt or a tool_result echo.
    if (obj.type === 'user') {
      const content = obj?.message?.content;
      if (Array.isArray(content) && content[0]?.type === 'tool_result') {
        // tool_result back to the agent — surface as a tool_call_update so the
        // matching tool_call card transitions to "completed" with output text.
        for (const block of content as ContentToolResult[]) {
          if (block?.type !== 'tool_result') continue;
          const text = toolResultText(block.content);
          records.push({
            type: 'update',
            update: {
              kind: 'tool_call_update',
              toolCall: {
                toolCallId: block.tool_use_id,
                status: block.is_error ? 'failed' : 'completed',
                content: text ? [{ type: 'text', text }] : undefined
              } as Partial<ToolCall> & { toolCallId: string }
            }
          });
          pendingToolCalls.delete(block.tool_use_id);
        }
        continue;
      }
      const text = asText(content);
      if (text) records.push({ type: 'user', text });
      continue;
    }

    // Assistant turn — text + tool calls + token usage.
    if (obj.type === 'assistant') {
      const content = obj?.message?.content;
      const model = (obj?.message?.model as string | undefined) ?? undefined;
      if (Array.isArray(content)) {
        for (const block of content as Array<ContentText | ContentToolUse>) {
          if (block?.type === 'text') {
            const text = (block as ContentText).text;
            if (text) {
              records.push({
                type: 'update',
                update: { kind: 'agent_message_chunk', content: { type: 'text', text } as ContentBlock }
              });
            }
          } else if (block?.type === 'tool_use') {
            const b = block as ContentToolUse;
            const tc: ToolCall = {
              toolCallId: b.id,
              title: b.name,
              kind: 'execute',
              status: 'in_progress',
              rawInput: b.input as Record<string, unknown> | undefined,
              locations: []
            } as ToolCall;
            pendingToolCalls.set(b.id, tc);
            records.push({ type: 'update', update: { kind: 'tool_call', toolCall: tc } });
          }
        }
      } else if (typeof content === 'string') {
        records.push({
          type: 'update',
          update: { kind: 'agent_message_chunk', content: { type: 'text', text: content } as ContentBlock }
        });
      }

      // Roll up token usage per model.
      const u = obj?.message?.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      // Skip the `<synthetic>` placeholder Claude Code emits for fabricated
      // system events (interactive UI messages, not real model invocations).
      // These never carry real usage anyway; counting them as a "model" just
      // clutters the breakdown panel.
      if (u && model && model !== '<synthetic>') {
        const slot = byModel.get(model) ?? {
          model,
          provider: 'remote' as const,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0
        };
        slot.inputTokens! += u.input_tokens || 0;
        slot.outputTokens! += u.output_tokens || 0;
        slot.cacheReadTokens! += u.cache_read_input_tokens || 0;
        slot.cacheCreationTokens! += u.cache_creation_input_tokens || 0;
        slot.costUsd =
          claudeTurnCost(
            slot.inputTokens,
            slot.outputTokens,
            slot.cacheReadTokens,
            slot.cacheCreationTokens
          );
        byModel.set(model, slot);
      }
    }
  }

  const totals = rollupTotals(Array.from(byModel.values()));
  // Emit the usage updates at the end of the replay so the header reflects
  // the imported session's lifetime spend immediately on open.
  records.push({ type: 'update', update: { kind: 'usage_breakdown', entries: Array.from(byModel.values()) } });
  records.push({ type: 'update', update: { kind: 'usage', usage: totals } });

  return { records, totals, byModel: Array.from(byModel.values()) };
}

interface GrokAssistantToolCall {
  id?: string;
  name?: string;
  arguments?: string;
}

/** Parse a Grok Build chat_history.jsonl into replay records. Grok doesn't
 * record per-turn token usage in chat_history (verified across many real
 * sessions), so `totals` + `byModel` are empty — there's nothing to display
 * in the header beyond message/tool counts. */
export function loadGrokHistory(chatPath: string): ReplayResult | null {
  if (!fs.existsSync(chatPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(chatPath, 'utf8');
  } catch {
    return null;
  }

  const records: ReplayRecord[] = [];

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === 'user') {
      const text = asText(obj.content);
      if (text) records.push({ type: 'user', text });
      continue;
    }

    if (obj.type === 'assistant') {
      const text = asText(obj.content);
      if (text) {
        records.push({
          type: 'update',
          update: { kind: 'agent_message_chunk', content: { type: 'text', text } as ContentBlock }
        });
      }
      const tcs: GrokAssistantToolCall[] = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      for (const tc of tcs) {
        if (!tc?.name || !tc?.id) continue;
        let input: Record<string, unknown> | undefined;
        if (typeof tc.arguments === 'string') {
          try {
            input = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            input = undefined;
          }
        }
        const toolCall: ToolCall = {
          toolCallId: tc.id,
          title: tc.name,
          kind: 'execute',
          status: 'completed',
          rawInput: input,
          locations: []
        } as ToolCall;
        records.push({ type: 'update', update: { kind: 'tool_call', toolCall } });
      }
      continue;
    }

    if (obj.type === 'tool_result') {
      const text = toolResultText(obj.content);
      if (text) {
        records.push({
          type: 'update',
          update: {
            kind: 'tool_call_update',
            toolCall: {
              toolCallId: obj.tool_call_id as string,
              status: 'completed',
              content: [{ type: 'text', text }]
            } as Partial<ToolCall> & { toolCallId: string }
          }
        });
      }
      continue;
    }

    // system / backend_tool_call: skip — system prompts dominate but
    // carry no per-session signal; backend tool calls in observed sessions
    // are web_search and similar, not editor-side activity.
  }

  return { records, totals: {}, byModel: [] };
}

function rollupTotals(perModel: UsageInfo[]): UsageInfo {
  if (perModel.length === 0) return {};
  const totals: UsageInfo = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0
  };
  for (const u of perModel) {
    totals.inputTokens! += u.inputTokens ?? 0;
    totals.outputTokens! += u.outputTokens ?? 0;
    totals.cacheReadTokens! += u.cacheReadTokens ?? 0;
    totals.cacheCreationTokens! += u.cacheCreationTokens ?? 0;
    totals.costUsd! += u.costUsd ?? 0;
  }
  return totals;
}
