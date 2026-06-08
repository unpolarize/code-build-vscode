import { useState } from 'react';

interface Props {
  fromBackend: string;
  toBackend: string;
  turnCount: number;
  /** True when the host can run a one-shot LLM summarization on the
   * source backend (today: claude). False → the hybrid card hides the
   * "LLM-generated" tag and the host falls back to a clipped summary. */
  llmSummarySupported: boolean;
  onDecide: (choice: 'full' | 'hybrid' | 'none', lastNTurns?: number) => void;
}

/**
 * Card-based picker for cross-backend context handoff. Shown after the
 * user switches the backend dropdown while a conversation has real
 * content. Three options:
 *
 *   1. Full conversation — verbatim everything, capped to a char budget.
 *   2. Summary + last N turns — kicks the SOURCE backend (one-shot,
 *      via `claude -p`) to LLM-summarise the conversation, then appends
 *      the last N user/assistant turns verbatim. Best of both worlds —
 *      a recap for the high-level "what is this conversation about"
 *      plus recent detail so the new agent has the live state. N is
 *      user-selectable (default 5; 0 = summary only; 1 = "last turn"
 *      shortcut).
 *   3. Start fresh — no carried-over context.
 *
 * The hybrid card shows a number input so the user can tune N without
 * leaving the picker. Sending the decision posts back to the host
 * which runs the summarization asynchronously (5-30s); the user can
 * keep typing while we wait — their first send won't fire until the
 * primer is ready (queued in the host).
 */
export function PrimerBanner({
  fromBackend,
  toBackend,
  turnCount,
  llmSummarySupported,
  onDecide
}: Props) {
  const [n, setN] = useState(5);

  return (
    <div className="primer-banner">
      <div className="primer-banner-header">
        Carrying over <strong>{turnCount}</strong> prior turn{turnCount === 1 ? '' : 's'} from{' '}
        <strong>{fromBackend}</strong> into <strong>{toBackend}</strong>. Pick how much
        context to inject before your next message:
      </div>
      <div className="primer-cards">
        <button
          className="primer-card primer-card-hybrid"
          onClick={() => onDecide('hybrid', n)}
        >
          <div className="primer-card-title">
            Summary + last{' '}
            <input
              type="number"
              min={0}
              max={50}
              value={n}
              onChange={(e) => setN(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
              onClick={(e) => e.stopPropagation()}
              className="primer-card-n-input"
            />{' '}
            turn{n === 1 ? '' : 's'}
          </div>
          <div className="primer-card-desc">
            {llmSummarySupported
              ? `Forks ${fromBackend} one-shot to write an LLM summary of the prior conversation, then appends the last ${n} verbatim turn${n === 1 ? '' : 's'} for fresh detail. Adds 10–30s before the first message; small extra token cost. Recommended for long sessions.`
              : `Clipped summary (first lines of each prior turn) + last ${n} verbatim turn${n === 1 ? '' : 's'}. ${fromBackend} doesn't support one-shot summarization yet, so the summary is mechanical, not LLM-generated.`}
          </div>
        </button>
        <button
          className="primer-card primer-card-full"
          onClick={() => onDecide('full')}
        >
          <div className="primer-card-title">Full conversation (risky)</div>
          <div className="primer-card-desc">
            Prepends the prior conversation verbatim, capped at a safe char budget.
            May still push the new agent over its context limit on long sessions —
            prefer Summary + last N if unsure.
          </div>
        </button>
        <button
          className="primer-card primer-card-none"
          onClick={() => onDecide('none')}
        >
          <div className="primer-card-title">Start fresh</div>
          <div className="primer-card-desc">
            No carried-over context. The new agent starts with zero memory of the
            prior conversation. Use when the new chat is unrelated.
          </div>
        </button>
      </div>
    </div>
  );
}
