interface Props {
  turnCount: number;
  fromBackend: string;
  toBackend: string;
  onChoose: (choice: 'full' | 'summary' | 'none') => void;
}

/**
 * Inline banner shown above the composer right after a backend swap
 * (Claude → Grok, etc.) when the prior chat had real content. Lets the
 * user decide whether the new agent gets the full prior transcript, a
 * summary, or nothing.
 *
 * The banner stays visible until any button is clicked, then disappears.
 * Closing without choosing is equivalent to "Start fresh" (handled by the
 * dismiss × button at the right).
 */
export function PrimerBanner({ turnCount, fromBackend, toBackend, onChoose }: Props) {
  return (
    <div className="primer-banner">
      <div className="primer-banner-text">
        Carrying over {turnCount} prior turn{turnCount === 1 ? '' : 's'} from{' '}
        <strong>{fromBackend}</strong> to <strong>{toBackend}</strong>?
      </div>
      <div className="primer-banner-actions">
        <button className="btn btn-primer" onClick={() => onChoose('full')}>
          Full conversation
        </button>
        <button className="btn btn-primer" onClick={() => onChoose('summary')}>
          Summary
        </button>
        <button className="btn btn-primer btn-primer-skip" onClick={() => onChoose('none')}>
          Start fresh
        </button>
        <button
          className="primer-banner-close"
          title="Dismiss (same as 'Start fresh')"
          onClick={() => onChoose('none')}
        >
          ×
        </button>
      </div>
    </div>
  );
}
