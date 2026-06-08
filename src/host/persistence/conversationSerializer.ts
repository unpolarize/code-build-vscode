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

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

interface Record_ {
  type: string;
  text?: string;
  update?: SessionUpdate;
}

// Char budgets for the prepended primer. The old 48K full-mode cap was
// hitting context-overflow when the new agent was a `--resume` of an
// already-long session (the existing transcript ate most of the window;
// prepending another 12K tokens of primer pushed it over). Tighter caps
// keep the handoff safe across all reasonable starting conditions —
// 16K chars is ~4K tokens which a 200K-token model swallows without
// dropping the user's actual prompt.
const FULL_BUDGET = 16_000;
const SUMMARY_BUDGET = 6_000;
const SUMMARY_ASSISTANT_CLIP = 400; // chars of each assistant reply in summary

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

/** Group records into role-alternating turns. Skips empty / non-text
 * agent updates (tool calls, thinking, usage) — the goal is a clean
 * Q→A list a downstream agent can read like a chat log. Used by the
 * hybrid primer to append the last N turns verbatim after the
 * LLM-generated summary. */
export function extractTurns(records: Record_[]): Turn[] {
  const turns: Turn[] = [];
  let assistantBuf = '';
  const flushAssistant = () => {
    if (assistantBuf.trim()) {
      turns.push({ role: 'assistant', text: assistantBuf.trim() });
    }
    assistantBuf = '';
  };
  for (const rec of records) {
    if (rec.type === 'user' && rec.text) {
      flushAssistant();
      turns.push({ role: 'user', text: rec.text });
      continue;
    }
    if (rec.type !== 'update' || !rec.update) continue;
    const u = rec.update;
    if (u.kind === 'agent_message_chunk' && u.content?.type === 'text') {
      assistantBuf += u.content.text ?? '';
    }
  }
  flushAssistant();
  return turns;
}

/** Build a plain-text transcript suitable for piping into a one-shot
 * `claude -p` (or grok) to ask for an LLM summary. Tail-truncated to
 * `maxChars` so a huge conversation can't push the summarizer over its
 * input limit; the earliest turns are dropped (recency > breadth for
 * handoff). */
export function buildTranscriptForSummary(
  records: Record_[],
  maxChars = 120_000
): string {
  const turns = extractTurns(records);
  const body = turns
    .map((t) => (t.role === 'user' ? `[USER]\n${t.text}` : `[ASSISTANT]\n${t.text}`))
    .join('\n\n');
  if (body.length <= maxChars) return body;
  return `[…earliest turns elided to fit summary budget…]\n\n${body.slice(body.length - maxChars)}`;
}

/** Compose the hybrid primer: an LLM-generated summary up top, the
 * last `lastNTurns` user/assistant exchanges verbatim below it, and a
 * framing instruction telling the new agent to use this as context for
 * the user's NEXT message (which the host appends as a regular user
 * block right after). The new agent doesn't need to acknowledge the
 * handoff explicitly — the framing prompt tells it to just answer the
 * upcoming user message naturally. */
export function serializeHybridConversation(args: {
  records: Record_[];
  summary: string;
  lastNTurns: number;
  fromBackend: string;
}): string {
  const turns = extractTurns(args.records);
  const n = Math.max(0, Math.min(turns.length, args.lastNTurns));
  const recent = n > 0 ? turns.slice(-n) : [];

  const verbatimSection = recent.length
    ? `\n\n== LAST ${recent.length} TURN${recent.length === 1 ? '' : 'S'} (verbatim) ==\n` +
      recent
        .map((t) => (t.role === 'user' ? `**User:**\n${t.text}` : `**Assistant:**\n${t.text}`))
        .join('\n\n')
    : '';

  return `<conversation-context source="${args.fromBackend}" mode="hybrid">
You are continuing a conversation that started in a different AI assistant (${args.fromBackend}). Below is:
1. A SUMMARY of the prior conversation (LLM-generated, by ${args.fromBackend} itself).
${recent.length ? `2. THE LAST ${recent.length} TURN${recent.length === 1 ? '' : 'S'} verbatim, so you have fresh detail.
3. The user's next message follows immediately after this block.` : `2. The user's next message follows immediately after this block.`}

Use this context to inform your response. Do NOT respond to this context block directly — just answer the user's upcoming message naturally, as if you'd been part of the conversation.

== SUMMARY ==
${args.summary.trim()}${verbatimSection}
</conversation-context>`;
}

/** Self-resume primer: same backend, same conversation, but the agent
 * process was restarted (panel reload, "Open Previous Conversation",
 * crash recovery). For backends like grok where ACP doesn't expose a
 * native `--resume` flag, the fresh agent starts with zero memory of
 * the conversation even though the user sees it in the UI. We inject
 * the last N turns verbatim + a short framing prompt explaining the
 * situation. Different from the cross-backend handoff primer in tone:
 * "you are resuming YOUR OWN conversation" instead of "you are
 * continuing from a different assistant". */
export function serializeSelfResumePrimer(args: {
  records: Record_[];
  lastNTurns: number;
  backendLabel: string;
}): string {
  const turns = extractTurns(args.records);
  const n = Math.max(0, Math.min(turns.length, args.lastNTurns));
  if (n === 0) return '';
  const recent = turns.slice(-n);
  const body = recent
    .map((t) => (t.role === 'user' ? `**User:**\n${t.text}` : `**Assistant:**\n${t.text}`))
    .join('\n\n');
  // Cap so a long-tail conversation doesn't blow the new agent's context.
  const capped = body.length > FULL_BUDGET ? tailTruncate(body, FULL_BUDGET) : body;
  return `<conversation-history mode="resume" backend="${args.backendLabel}">
You are RESUMING a conversation you were having with the user. The agent process restarted (panel reload / new window / crash) so your in-memory context has been lost, but the conversation itself is intact. Below are the last ${n} turn${n === 1 ? '' : 's'} verbatim. Use them to pick up exactly where you left off.

Do NOT acknowledge the restart or describe the situation back to the user — just answer their next message naturally, as if you'd been in the conversation all along. If the user's next message refers to "this conversation" or asks about something discussed earlier, treat the history below as that context.

== RECENT TURNS ==
${capped}
</conversation-history>`;
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
