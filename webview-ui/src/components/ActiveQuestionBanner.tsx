// Sticky banner pinned just under the chat header that surfaces the
// CURRENT user question — the one the agent is actively working on,
// or the most recent one if the agent has finished. Matches Claude
// Code's pattern of always keeping the user's prompt visible while a
// long reply scrolls.
//
// Dismissable per-session (X button); persistent off-switch via the
// `codeBuild.showActiveQuestionBanner` VS Code setting (off → banner
// never appears, hydrate carries `showActiveQuestionBanner: false`
// in HydrateState).

import { useState } from 'react';
import type { ChatItem } from '../store';
import { formatRelative, formatHover } from '../util/time';

interface Props {
  /** The user bubble to surface. Null when no user messages yet. */
  question: Extract<ChatItem, { kind: 'user' }> | null;
  /** True if the agent is mid-reply for this question. Drives the
   * "active" framing ("⏳ active question") vs "previous question". */
  busy: boolean;
  /** Master toggle from settings. When false the banner never renders. */
  visible: boolean;
}

export function ActiveQuestionBanner({ question, busy, visible }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (!visible || !question || dismissed) return null;

  // First non-empty line, capped at 240 chars so a long prompt
  // doesn't blow up the layout. The full text is in the hover
  // tooltip.
  const firstLine =
    question.text
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  const preview = firstLine.length > 240 ? firstLine.slice(0, 240) + '…' : firstLine;

  return (
    <div
      className={`active-question-banner${busy ? ' active-question-banner-busy' : ''}`}
      role="region"
      aria-label={busy ? 'Active question' : 'Previous question'}
    >
      <span className="active-question-eyebrow">
        {busy ? '⏳ active' : '↩︎ previous'}
      </span>
      <span
        className="active-question-text"
        title={`${question.text}\n\nSent ${formatHover(question.createdAt, question.updatedAt)}`}
      >
        {preview}
      </span>
      <span
        className="active-question-time"
        title={formatHover(question.createdAt, question.updatedAt)}
      >
        {formatRelative(question.createdAt)}
      </span>
      <button
        className="active-question-dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss this banner for the current session. Permanently disable: codeBuild.showActiveQuestionBanner = false."
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
