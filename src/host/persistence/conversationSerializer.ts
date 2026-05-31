// Serialise a conversation transcript to plain text for cross-backend
// handoff. When the user switches a chat from one CLI to another (e.g.
// Claude → Grok), the new agent starts with an empty context window — it
// has no idea what was discussed. We turn the prior transcript into a text
// primer that's prepended to the user's next prompt so the new agent
// inherits the conversation.
//
// Two fidelity modes:
//   - 'full'    : every user + assistant message verbatim, plus tool names.
//   - 'summary' : user prompts verbatim (they're the intent) + a clipped
//                 first chunk of each assistant reply. Much smaller; good
//                 enough for "remember what we were doing".
//
// Both modes tail-truncate to a char budget — recency matters more than
// depth for a handoff, and we don't want to blow the new agent's first-turn
// cost. The records shape matches SessionStore.load() and externalReplay.

import type { SessionUpdate } from '../../shared/acpTypes';

export type PrimerMode = 'full' | 'summary';

interface Record_ {
  type: string;
  text?: string;
  update?: SessionUpdate;
}

const FULL_BUDGET = 48_000; // chars — generous; first-turn cost is one-shot
const SUMMARY_BUDGET = 12_000;
const SUMMARY_ASSISTANT_CLIP = 600; // chars of each assistant reply in summary

/** Count the user turns in a record list (for the banner "N prior turns"). */
export function countUserTurns(records: Record_[]): number {
  return records.filter((r) => r.type === 'user' && r.text).length;
}

/** Build the primer text. Returns '' when there's nothing to carry over. */
export function serializeConversation(
  records: Record_[],
  mode: PrimerMode,
  fromBackend: string
): string {
  const turns: string[] = [];
  // Accumulate assistant text across chunks within a turn so a streamed
  // reply collapses to one block.
  let assistantBuf = '';
  const flushAssistant = () => {
    if (!assistantBuf.trim()) return;
    const text =
      mode === 'summary' ? clip(assistantBuf.trim(), SUMMARY_ASSISTANT_CLIP) : assistantBuf.trim();
    turns.push(`**Assistant:**\n${text}`);
    assistantBuf = '';
  };

  for (const rec of records) {
    if (rec.type === 'user' && rec.text) {
      flushAssistant();
      turns.push(`**User:**\n${rec.text}`);
      continue;
    }
    if (rec.type !== 'update' || !rec.update) continue;
    const u = rec.update;
    if (u.kind === 'agent_message_chunk' && u.content?.type === 'text') {
      assistantBuf += u.content.text ?? '';
    } else if (mode === 'full' && u.kind === 'tool_call') {
      // In full mode, note tool calls inline so the new agent knows what
      // actions were taken (it can't see the editor side-effects otherwise).
      flushAssistant();
      turns.push(`_[tool: ${u.toolCall.title}]_`);
    }
  }
  flushAssistant();

  if (turns.length === 0) return '';

  const body = tailTruncate(turns.join('\n\n'), mode === 'full' ? FULL_BUDGET : SUMMARY_BUDGET);
  const header =
    mode === 'full'
      ? `The following is the full prior conversation from a ${fromBackend} session that I'm continuing here. Use it as context for my next message; you don't need to respond to it directly.`
      : `Here is a summary of the prior conversation from a ${fromBackend} session that I'm continuing here. Use it as context for my next message; you don't need to respond to it directly.`;

  return `<conversation-context source="${fromBackend}" mode="${mode}">\n${header}\n\n${body}\n</conversation-context>`;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Keep the END of a long string (recent turns) when over budget, with a
 * marker noting earlier content was dropped. */
function tailTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = s.slice(s.length - max);
  // Snap to the next turn boundary so we don't start mid-sentence.
  const boundary = tail.indexOf('\n\n**');
  const snapped = boundary >= 0 ? tail.slice(boundary + 2) : tail;
  return `_[…earlier turns omitted to fit context budget…]_\n\n${snapped}`;
}
