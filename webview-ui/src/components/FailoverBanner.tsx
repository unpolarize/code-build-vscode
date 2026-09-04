import { useState } from 'react';
import type { BackendId } from '../../../src/shared/acpTypes';

export interface FailoverOfferView {
  errorClass: 'overload' | 'unavailable';
  fromBackend: BackendId;
  fromLabel: string;
  suggestedBackend: BackendId;
  suggestedLabel: string;
  alternatives: Array<{ id: BackendId; label: string }>;
  message: string;
}

interface Props {
  offer: FailoverOfferView;
  onDecide: (accept: boolean, backend?: BackendId) => void;
}

/**
 * Confirm banner for host-level cross-ACP failover on overload|unavailable.
 * v1 always confirms — never silent swap. One-click Continue uses the
 * suggested peer; optional select exposes other installed backends.
 */
export function FailoverBanner({ offer, onDecide }: Props) {
  const [backend, setBackend] = useState<BackendId>(offer.suggestedBackend);

  return (
    <div className="failover-banner" role="alertdialog" aria-label="Backend failover">
      <div className="failover-banner-header">{offer.message}</div>
      <div className="failover-banner-detail">
        <strong>{offer.fromLabel}</strong> hit a {offer.errorClass} error. Continue on another
        backend with a last-N transcript primer — this does not fire on quota/429.
      </div>
      {offer.alternatives.length > 1 && (
        <label className="failover-banner-pick">
          Continue on{' '}
          <select
            value={backend}
            onChange={(e) => setBackend(e.target.value as BackendId)}
            aria-label="Failover target backend"
          >
            {offer.alternatives.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="failover-banner-actions">
        <button
          type="button"
          className="btn-primer"
          onClick={() => onDecide(true, backend)}
        >
          Continue on{' '}
          {offer.alternatives.find((a) => a.id === backend)?.label ?? offer.suggestedLabel}
        </button>
        <button
          type="button"
          className="btn-primer btn-primer-ghost"
          onClick={() => onDecide(false)}
        >
          Stay / dismiss
        </button>
      </div>
    </div>
  );
}
