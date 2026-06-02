import type { SessionUpdate } from '../../shared/acpTypes';
import type { SessionMeta } from '../../shared/protocol';

/**
 * Exports a code-build transcript into a Claude-Code-style turn JSONL that the
 * Code Sessions extension can index. Note: when code-build drives the real
 * `claude`/`grok` CLIs, those CLIs already persist their native transcripts that
 * Code Sessions indexes directly — this exporter covers synthetic/other backends
 * and provides a uniform cross-link target.
 */
export interface ExportRecord {
  type: string;
  update?: SessionUpdate;
  text?: string;
}

export function exportToClaudeJsonl(meta: SessionMeta, records: ExportRecord[]): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: 'summary',
      sessionId: meta.id,
      source: 'code-build',
      backend: meta.backend,
      cwd: meta.cwd,
      timestamp: new Date(meta.createdAt).toISOString()
    })
  );

  for (const rec of records) {
    if (rec.type === 'user' && rec.text != null) {
      lines.push(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: rec.text }] }
        })
      );
    } else if (rec.type === 'update' && rec.update) {
      const line = updateToTurn(rec.update);
      if (line) lines.push(JSON.stringify(line));
    }
  }
  return lines.join('\n') + '\n';
}

function updateToTurn(u: SessionUpdate): object | null {
  switch (u.kind) {
    case 'agent_message_chunk':
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: u.content.type === 'text' ? u.content.text : '' }]
        }
      };
    case 'tool_call':
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: u.toolCall.toolCallId, name: u.toolCall.title, input: u.toolCall.rawInput ?? {} }
          ]
        }
      };
    case 'result':
      return {
        type: 'result',
        subtype: u.stopReason,
        total_cost_usd: u.usage?.costUsd,
        usage: {
          input_tokens: u.usage?.inputTokens,
          output_tokens: u.usage?.outputTokens
        }
      };
    default:
      return null;
  }
}
