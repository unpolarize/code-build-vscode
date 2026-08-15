/**
 * ACP `_x.ai/ask_user_question` / `x.ai/ask_user_question` wire helpers.
 *
 * Grok (and any ACP client using the x.ai ext-method) blocks the turn on a
 * JSON-RPC request to the host. Claude instead emits a regular AskUserQuestion
 * tool_use and waits for a tool_result. These helpers parse both the direct
 * ext-method params and the `_x.ai/…` wrapper so AcpTransport can show the
 * existing AskUserQuestion card and resolve the RPC with the expected
 * `{ outcome: "accepted", answers }` shape.
 */

export const ASK_USER_QUESTION_METHODS = [
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question'
] as const;

export function isAskUserQuestionMethod(method: string): boolean {
  return (
    method === 'x.ai/ask_user_question' || method === '_x.ai/ask_user_question'
  );
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskUserQuestionEntry {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

export interface ParsedAskUserQuestion {
  sessionId?: string;
  toolCallId: string;
  mode: 'default' | 'plan';
  questions: AskUserQuestionEntry[];
}

export interface AskUserQuestionAccepted {
  outcome: 'accepted';
  answers: Record<string, string[]>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

export interface AskUserQuestionCancelled {
  outcome: 'cancelled';
}

/** Unwrap `_x.ai/ask_user_question` `{ method, params }` envelopes. */
export function unwrapExtParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const rec = params as Record<string, unknown>;
  if (
    typeof rec.method === 'string' &&
    (rec.method === 'x.ai/ask_user_question' || rec.method === '_x.ai/ask_user_question') &&
    rec.params != null
  ) {
    return rec.params;
  }
  return params;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function parseOptions(raw: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const rec = o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
    const description = asString(rec.description);
    const preview = rec.preview != null ? asString(rec.preview) : undefined;
    return {
      label: asString(rec.label),
      description: description || undefined,
      preview: preview || undefined
    };
  });
}

function parseQuestions(raw: unknown): AskUserQuestionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const rec = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
    const multi =
      rec.multiSelect === true ||
      rec.multi_select === true ||
      rec.multiSelect === 'true' ||
      rec.multi_select === 'true';
    const header = rec.header != null ? asString(rec.header) : undefined;
    return {
      question: asString(rec.question),
      header: header || undefined,
      multiSelect: multi || undefined,
      options: parseOptions(rec.options)
    };
  });
}

export function parseAskUserQuestionParams(params: unknown): ParsedAskUserQuestion | null {
  const body = unwrapExtParams(params);
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const toolCallId = asString(rec.toolCallId || rec.tool_call_id);
  if (!toolCallId) return null;
  const modeRaw = asString(rec.mode).toLowerCase();
  return {
    sessionId: asString(rec.sessionId || rec.session_id) || undefined,
    toolCallId,
    mode: modeRaw === 'plan' ? 'plan' : 'default',
    questions: parseQuestions(rec.questions)
  };
}

/** Map the webview's question→label record into Grok's ACP accepted payload. */
export function buildAskUserQuestionAccepted(
  answers: Record<string, string>
): AskUserQuestionAccepted {
  const mapped: Record<string, string[]> = {};
  for (const [q, raw] of Object.entries(answers)) {
    mapped[q] = [raw ?? ''];
  }
  return { outcome: 'accepted', answers: mapped };
}

export function buildAskUserQuestionCancelled(): AskUserQuestionCancelled {
  return { outcome: 'cancelled' };
}
