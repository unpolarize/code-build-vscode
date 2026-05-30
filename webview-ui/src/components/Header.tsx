import type { PermissionMode } from '../../../src/shared/acpTypes';
import type { ChatState } from '../store';

const MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypass'];

interface Props {
  state: ChatState;
  onPickBackend: (id: string) => void;
  onSetMode: (mode: PermissionMode) => void;
  onNewSession: () => void;
  onOpenInNewTab: () => void;
  onOpenInNewWindow: () => void;
}

export function Header({ state, onPickBackend, onSetMode, onNewSession, onOpenInNewTab, onOpenInNewWindow }: Props) {
  const current = state.session?.backend ?? '';
  return (
    <div className="header">
      <select
        className="backend-picker"
        value={current}
        onChange={(e) => onPickBackend(e.target.value)}
      >
        {!current && <option value="">Pick backend…</option>}
        {state.backends.map((b) => (
          <option key={b.id} value={b.id} disabled={!b.available}>
            {b.label}
            {b.available ? '' : ' (not installed)'}
          </option>
        ))}
      </select>

      <select
        className="mode-picker"
        value={state.session?.mode ?? 'default'}
        onChange={(e) => onSetMode(e.target.value as PermissionMode)}
      >
        {MODES.map((m) => (
          <option key={m} value={m} disabled={m === 'bypass' && !state.allowBypass}>
            {m}
          </option>
        ))}
      </select>

      <div className="header-spacer" />

      {state.usage?.costUsd != null && (
        <span className="usage">${state.usage.costUsd.toFixed(4)}</span>
      )}
      {state.commands.length > 0 && (
        <span
          className="cmd-hint"
          title={`${state.commands.length} slash commands provided by ${current || 'current agent'}`}
        >
          /{state.commands.length}
        </span>
      )}
      <button className="btn btn-new" onClick={onNewSession} title="New conversation">
        + New
      </button>

      <button
        className="icon-btn"
        title="Open in new tab (⌘⇧⎋)"
        onClick={onOpenInNewTab}
      >
        ⤴
      </button>
      <button
        className="icon-btn"
        title="Open in new window"
        onClick={onOpenInNewWindow}
      >
        ⧉
      </button>
    </div>
  );
}
