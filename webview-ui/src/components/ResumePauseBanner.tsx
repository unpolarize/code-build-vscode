interface Props {
  /** Host-rendered copy: "Resume after reset · wakes HH:MM" / "· unknown reset". */
  label: string;
  /** Null = unknown reset; manual Resume is the only wake. */
  resumeAt: number | null;
  onAction: (action: 'resume' | 'cancel' | 'switch_backend') => void;
}

/**
 * Resume-after-reset park banner (kp: ideas/cb-host-resume-after-reset-
 * coordinator-park-goal). Shown while a quota (429) soft-stop has the
 * session parked; Resume re-primes the SAME backend. Deliberately not the
 * warning-styled failover banner — a park is an informational hold, not a
 * backend-health incident.
 */
export function ResumePauseBanner({ label, resumeAt, onAction }: Props) {
  return (
    <div className="resume-pause-banner" role="status" aria-label="Resume after reset">
      <div className="resume-pause-label">{label}</div>
      <div className="resume-pause-detail">
        {resumeAt == null
          ? 'Usage limit hit and the reset time is unknown — press Resume when your window is back.'
          : 'Usage limit hit — this session is parked on the same backend until the window resets.'}
      </div>
      <div className="failover-banner-actions">
        <button type="button" className="btn-primer" onClick={() => onAction('resume')}>
          Resume now
        </button>
        <button
          type="button"
          className="btn-primer btn-primer-ghost"
          onClick={() => onAction('switch_backend')}
        >
          Switch backend…
        </button>
        <button
          type="button"
          className="btn-primer btn-primer-ghost"
          onClick={() => onAction('cancel')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
