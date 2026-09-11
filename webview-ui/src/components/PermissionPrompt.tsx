import type { PendingPermission } from '../store';
import type { ContentBlock, PermissionOutcome } from '../../../src/shared/acpTypes';
import type { BallotAction, PermissionBallotInfo } from '../../../src/shared/permissionBallot';
import { classifyTool, rawCommand, capText } from '../toolPreview';
import { DiffBlock } from './ToolCard';

interface Props {
  permission: PendingPermission;
  /** How many more requests wait behind this one (FIFO). */
  queued?: number;
  /** Sibling prompts with the same fingerprint (same-session or cross-session). */
  ballot?: PermissionBallotInfo | null;
  onRespond: (requestId: string, outcome: PermissionOutcome) => void;
  onBallot?: (action: BallotAction) => void;
}

/**
 * The human-in-the-loop approval gate. Shows WHAT is being approved via a
 * fallback chain — command text → diff → file path → title+kind — because
 * rawInput/content/locations are all optional on the wire (good agents send
 * them; some adapters send title only). Rendering is text-nodes-only and
 * size-capped; a bare {toolCallId, title} payload must still render.
 */
export function PermissionPrompt({ permission, queued = 0, ballot, onRespond, onBallot }: Props) {
  const tool = permission.tool;
  const tag = classifyTool(tool);
  const command = rawCommand(tool);
  const diffs = (tool.content ?? []).filter(
    (b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff'
  );
  const loc = tool.locations?.[0];
  const highRisk = ballot?.highRisk;
  const showBallot = !!ballot && ballot.count > 1 && onBallot;

  return (
    <div className="permission">
      <div className="permission-title">
        Permission requested: <strong>{tool.title}</strong>
        {tool.kind && <span className="permission-kind">{tool.kind}</span>}
        {tag && (
          <span className={`tool-tag tool-tag-${tag.severity}`} title={`Highlighted operation: ${tag.badge}`}>
            {tag.badge}
          </span>
        )}
        {queued > 0 && (
          <span className="permission-queued" title="More permission requests are waiting">
            +{queued} queued
          </span>
        )}
      </div>

      {command ? (
        <pre className="permission-command">{capText(command)}</pre>
      ) : diffs.length > 0 ? (
        // Cap diff sides before the O(n×m) lineDiff — a multi-MB edit
        // approval must not freeze the webview.
        diffs.map((d, i) => (
          <DiffBlock key={i} diff={{ ...d, oldText: capText(d.oldText), newText: capText(d.newText) }} />
        ))
      ) : loc ? (
        <div className="permission-path">{loc.path}</div>
      ) : null}

      {showBallot && (
        <div className="permission-ballot">
          <span className="permission-ballot-label">
            Same {ballot.method}
            {ballot.target ? ` · ${ballot.target}` : ''} in {ballot.count} sessions
            {ballot.backends.length > 1 ? ` (${ballot.backends.join(', ')})` : ''}
          </span>
          {highRisk && (
            <span className="permission-ballot-risk" title="High-risk class is never auto-approved">
              {highRisk} — Approve-all blocked
            </span>
          )}
          <div className="permission-options">
            {!highRisk && (
              <button className="btn perm-allow_always" onClick={() => onBallot('approve-all')}>
                Approve all
              </button>
            )}
            <button className="btn perm-reject_once" onClick={() => onBallot('deny-any')}>
              Deny all
            </button>
            {!highRisk && (
              <button className="btn perm-allow_once" onClick={() => onBallot('approve-this-backend')}>
                Approve this backend only
              </button>
            )}
          </div>
        </div>
      )}

      <div className="permission-options">
        {permission.options.map((opt) => (
          <button
            key={opt.optionId}
            className={`btn perm-${opt.kind}`}
            onClick={() =>
              onRespond(permission.requestId, { outcome: 'selected', optionId: opt.optionId })
            }
          >
            {opt.name}
          </button>
        ))}
        <button
          className="btn perm-cancel"
          onClick={() => onRespond(permission.requestId, { outcome: 'cancelled' })}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
