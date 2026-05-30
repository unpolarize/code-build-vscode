import { useState } from 'react';
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
  onResumeSession: (id: string, source?: 'codebuild' | 'claude' | 'grok', cwd?: string) => void;
  onRefreshSessions: () => void;
}

export function Header({
  state,
  onPickBackend,
  onSetMode,
  onNewSession,
  onOpenInNewTab,
  onOpenInNewWindow,
  onResumeSession,
  onRefreshSessions
}: Props) {
  const current = state.session?.backend ?? '';
  const [historyOpen, setHistoryOpen] = useState(false);

  function toggleHistory() {
    if (!historyOpen) onRefreshSessions();
    setHistoryOpen((v) => !v);
  }

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
        <span className="usage" title={formatUsageTooltip(state)}>
          ${state.usage.costUsd.toFixed(4)}
          {state.usageBreakdown && state.usageBreakdown.length > 0 && (
            <span className="usage-models"> · {state.usageBreakdown.length} model{state.usageBreakdown.length > 1 ? 's' : ''}</span>
          )}
        </span>
      )}
      {state.commands.length > 0 && (
        <span
          className="cmd-hint"
          title={`${state.commands.length} slash commands provided by ${current || 'current agent'} — type / to browse`}
        >
          /{state.commands.length}
        </span>
      )}

      <div className="history-wrap">
        <button
          className="icon-btn"
          title="Conversation history"
          onClick={toggleHistory}
        >
          🕘
        </button>
        {historyOpen && (
          <div className="history-menu" onMouseLeave={() => setHistoryOpen(false)}>
            {state.sessions.length === 0 && <div className="history-empty">No previous conversations</div>}
            {state.sessions.map((s) => {
              const src = s.source ?? 'codebuild';
              const tag = src === 'claude' ? 'CC' : src === 'grok' ? 'GR' : 'CB';
              return (
                <div
                  key={`${src}:${s.id}`}
                  className="history-item"
                  onClick={() => {
                    onResumeSession(s.id, src, s.cwd);
                    setHistoryOpen(false);
                  }}
                  title={`${src} · ${s.cwd}`}
                >
                  <span className={`history-tag history-tag-${src}`}>{tag}</span>
                  <span className="history-title">{s.title || `${s.backend} session`}</span>
                  <span className="history-meta">
                    {s.backend} · {new Date(s.createdAt).toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button className="btn btn-new" onClick={onNewSession} title="New conversation (⌘N)">
        + New
      </button>

      <button className="icon-btn" title="Open in new tab (⌘⇧⎋)" onClick={onOpenInNewTab}>
        ⤴
      </button>
      <button className="icon-btn" title="Open in new window" onClick={onOpenInNewWindow}>
        ⧉
      </button>
    </div>
  );
}

/** Compose a multi-line tooltip describing the current chat's spend. Includes
 * per-model breakdown when more than one model contributed, plus cache
 * read/write rows so the user can see how much of the spend was discounted
 * via the provider's prompt cache. */
function formatUsageTooltip(state: ChatState): string {
  const u = state.usage;
  if (!u) return '';
  const lines: string[] = [];
  if (u.costUsd != null) lines.push(`Total cost: $${u.costUsd.toFixed(4)}`);
  if (u.inputTokens) lines.push(`Input tokens: ${u.inputTokens.toLocaleString()}`);
  if (u.outputTokens) lines.push(`Output tokens: ${u.outputTokens.toLocaleString()}`);
  if (u.cacheReadTokens)
    lines.push(`Cache hits (remote): ${u.cacheReadTokens.toLocaleString()} (~10% cost)`);
  if (u.cacheCreationTokens)
    lines.push(`Cache writes (remote): ${u.cacheCreationTokens.toLocaleString()} (~125% cost)`);
  const breakdown = state.usageBreakdown ?? [];
  if (breakdown.length > 0) {
    lines.push('');
    lines.push('Per model:');
    for (const m of breakdown) {
      const provider = m.provider === 'local' ? '[local GPU, free]' : '[remote]';
      const cost = m.costUsd != null ? ` $${m.costUsd.toFixed(4)}` : '';
      const inTok = m.inputTokens ? ` ${m.inputTokens.toLocaleString()}in` : '';
      const outTok = m.outputTokens ? `/${m.outputTokens.toLocaleString()}out` : '';
      const cacheR = m.cacheReadTokens ? ` ${m.cacheReadTokens.toLocaleString()}cR` : '';
      const cacheW = m.cacheCreationTokens ? `/${m.cacheCreationTokens.toLocaleString()}cW` : '';
      lines.push(`  ${m.model ?? 'unknown'} ${provider}${cost}${inTok}${outTok}${cacheR}${cacheW}`);
    }
  }
  return lines.join('\n');
}
