import type { PendingPermission } from '../store';
import type { PermissionOutcome } from '../../../src/shared/acpTypes';

interface Props {
  permission: PendingPermission;
  onRespond: (requestId: string, outcome: PermissionOutcome) => void;
}

export function PermissionPrompt({ permission, onRespond }: Props) {
  return (
    <div className="permission">
      <div className="permission-title">
        Permission requested: <strong>{permission.tool.title}</strong>
      </div>
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
