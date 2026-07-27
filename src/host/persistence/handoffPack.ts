// Build a structured HANDOFF.md "pack" from a session transcript so the
// user can continue the work on another agent/backend (or another machine)
// without losing state. Unlike the conversational primers in
// conversationSerializer (which replay the chat), the pack is a *briefing
// document*: goal, decisions, files touched, last green check, open risks,
// next step. It is deliberately heuristic — no LLM call — so it works
// instantly and offline, including when the current backend is the thing
// that just rate-limited us.

import * as path from 'node:path';
import type { SessionUpdate, ToolCall, PlanEntry } from '../../shared/acpTypes';
import { extractTurns } from './conversationSerializer';

interface Record_ {
  type: string;
  text?: string;
  update?: SessionUpdate;
}

export interface HandoffPackMeta {
  /** Human label of the backend the session ran on (e.g. "Claude Code"). */
  fromBackend: string;
  model?: string;
  sessionId?: string;
  cwd?: string;
  /** ISO timestamp; supplied by the caller so the builder stays pure. */
  generatedAt?: string;
}

const GOAL_CLIP = 700;
const LINE_CLIP = 240;
const NEXT_STEP_CLIP = 900;
const MAX_FILES = 30;
const MAX_LINES = 8;

/** Lines in assistant text that read like a decision was made. */
const DECISION_RE =
  /\b(decid\w*|chose|choos\w*|going with|went with|opted|instead of|we(?:'|’)ll use|approach:|trade-?off)\b/i;
/** Lines that flag open risks / unfinished business. */
const RISK_RE =
  /\b(risk|caveat|TODO|FIXME|known issue|limitation|watch out|blocked|workaround|does not handle|doesn(?:'|’)t handle)\b/i;
/** Tool titles that look like a verification step (test/build/lint/typecheck). */
const CHECK_RE = /\b(test|vitest|jest|pytest|tsc|typecheck|type-check|lint|eslint|build|check)\b/i;

/** Merge tool_call + tool_call_update records into final per-call state. */
function mergeToolCalls(records: Record_[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  const order: string[] = [];
  for (const rec of records) {
    if (rec.type !== 'update' || !rec.update) continue;
    const u = rec.update;
    if (u.kind === 'tool_call') {
      if (!byId.has(u.toolCall.toolCallId)) order.push(u.toolCall.toolCallId);
      byId.set(u.toolCall.toolCallId, { ...u.toolCall });
    } else if (u.kind === 'tool_call_update') {
      const prev = byId.get(u.toolCall.toolCallId);
      if (prev) {
        // Partial update: only overwrite fields the update actually carries.
        for (const [k, v] of Object.entries(u.toolCall)) {
          if (v !== undefined) (prev as unknown as Record<string, unknown>)[k] = v;
        }
      }
    }
  }
  return order.map((id) => byId.get(id)!);
}

/** Workspace-relative display path (falls back to the raw path). */
function displayPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd + path.sep)) return p.slice(cwd.length + 1);
  return p;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Pull matching lines out of assistant turns, most recent last, deduped. */
function scanAssistantLines(records: Record_[], re: RegExp, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const turn of extractTurns(records)) {
    if (turn.role !== 'assistant') continue;
    for (const raw of turn.text.split('\n')) {
      const line = raw.replace(/^[\s>*#-]+/, '').trim();
      if (!line || line.length < 8 || !re.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clip(line, LINE_CLIP));
    }
  }
  // Keep the most recent matches — later decisions supersede earlier ones.
  return out.slice(-max);
}

/** The last plan update wins — it reflects current progress. */
function lastPlan(records: Record_[]): PlanEntry[] | undefined {
  let plan: PlanEntry[] | undefined;
  for (const rec of records) {
    if (rec.type === 'update' && rec.update?.kind === 'plan') plan = rec.update.entries;
  }
  return plan;
}

/** Build the handoff pack markdown. Returns '' when there are no turns. */
export function buildHandoffPack(records: Record_[], meta: HandoffPackMeta): string {
  const turns = extractTurns(records);
  const userTurns = turns.filter((t) => t.role === 'user');
  if (userTurns.length === 0) return '';

  const toolCalls = mergeToolCalls(records);

  // Files touched: union of every location every tool call reported.
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const tc of toolCalls) {
    for (const loc of tc.locations ?? []) {
      const p = displayPath(loc.path, meta.cwd);
      if (!seenFiles.has(p)) {
        seenFiles.add(p);
        files.push(p);
      }
    }
  }

  // Last verification-looking tool call — tells the next agent what the
  // most recent known-good (or known-bad) check state was.
  let lastCheck: ToolCall | undefined;
  for (const tc of toolCalls) {
    if (CHECK_RE.test(tc.title) && (tc.status === 'completed' || tc.status === 'failed')) {
      lastCheck = tc;
    }
  }

  const decisions = scanAssistantLines(records, DECISION_RE, MAX_LINES);
  const risks = scanAssistantLines(records, RISK_RE, MAX_LINES);
  const plan = lastPlan(records);
  const pendingPlan = plan?.filter((e) => e.status !== 'completed') ?? [];
  const donePlan = plan?.filter((e) => e.status === 'completed') ?? [];

  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  // The tail of the final assistant reply is usually "here's where we are /
  // what's next" — the best free-text next-step signal we have.
  const nextStepText = pendingPlan.length
    ? pendingPlan.map((e) => `- [ ] ${clip(e.content, LINE_CLIP)}`).join('\n')
    : lastAssistant
      ? clip(tailParagraphs(lastAssistant.text), NEXT_STEP_CLIP)
      : '_Unknown — no assistant reply captured._';

  const headerLines = [
    `- **From:** ${meta.fromBackend}${meta.model ? ` (${meta.model})` : ''}`,
    meta.sessionId ? `- **Session:** \`${meta.sessionId}\`` : undefined,
    meta.cwd ? `- **Workspace:** \`${meta.cwd}\`` : undefined,
    meta.generatedAt ? `- **Generated:** ${meta.generatedAt}` : undefined,
    `- **User turns:** ${userTurns.length}`
  ].filter(Boolean);

  const sections: string[] = [
    `# Handoff Pack`,
    headerLines.join('\n'),
    `## Goal\n${clip(userTurns[0].text, GOAL_CLIP)}`
  ];

  const lastUser = userTurns[userTurns.length - 1];
  if (userTurns.length > 1) {
    sections.push(`## Latest request\n${clip(lastUser.text, GOAL_CLIP)}`);
  }

  sections.push(
    `## Decisions\n${decisions.length ? decisions.map((d) => `- ${d}`).join('\n') : '_None detected._'}`
  );

  const fileList = files.slice(0, MAX_FILES).map((f) => `- \`${f}\``);
  if (files.length > MAX_FILES) fileList.push(`- …and ${files.length - MAX_FILES} more`);
  sections.push(`## Files touched\n${fileList.length ? fileList.join('\n') : '_None recorded._'}`);

  sections.push(
    `## Last check\n${
      lastCheck
        ? `${lastCheck.status === 'completed' ? '✅' : '❌'} \`${clip(lastCheck.title, LINE_CLIP)}\` (${lastCheck.status})`
        : '_No test/build/lint run recorded — verify before trusting the working tree._'
    }`
  );

  if (donePlan.length || pendingPlan.length) {
    const planLines = [
      ...donePlan.map((e) => `- [x] ${clip(e.content, LINE_CLIP)}`),
      ...pendingPlan.map((e) => `- [ ] ${clip(e.content, LINE_CLIP)}`)
    ];
    sections.push(`## Plan status\n${planLines.join('\n')}`);
  }

  sections.push(
    `## Open risks\n${risks.length ? risks.map((r) => `- ${r}`).join('\n') : '_None detected._'}`
  );

  sections.push(`## Next step\n${nextStepText}`);

  return sections.join('\n\n') + '\n';
}

/**
 * Frame a handoff pack as a one-shot primer for the *next* user message on a
 * different backend. Pure (no I/O) so unit tests can lock the contract.
 * The host sets this as `pendingPrimer` after the user picks "Continue on…".
 */
export function formatHandoffPackPrimer(pack: string, fromBackend: string): string {
  const body = pack.trim();
  if (!body) return '';
  return (
    `<handoff-pack source="${fromBackend}">\n` +
    `You are continuing work that started in a different AI assistant (${fromBackend}). ` +
    `Below is a structured handoff briefing (goal, decisions, files touched, last check, open risks, next step). ` +
    `A HANDOFF.md file with the same content may also exist in the workspace.\n\n` +
    `Use this context to inform your response. Do NOT re-summarize the pack back to the user — ` +
    `answer their upcoming message naturally and pick up the next step if they ask you to continue.\n\n` +
    `== HANDOFF PACK ==\n` +
    `${body}\n` +
    `</handoff-pack>`
  );
}

/** Last one or two paragraphs of an assistant reply. */
function tailParagraphs(text: string): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.slice(-2).join('\n\n');
}
