import { useState } from 'react';
import type { PermissionMode } from '../../../src/shared/acpTypes';
import { modePickerOptions } from '../../../src/shared/permissionModes';
import type { ChatState } from '../store';
import { post } from '../vscodeApi';
type Effort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORT_LEVELS: Effort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

interface Props {
  state: ChatState;
  onPickBackend: (id: string) => void;
  onSetMode: (mode: PermissionMode) => void;
  onSetModel: (model: string) => void;
  onSetEffort: (effort: Effort) => void;
  onNewSession: () => void;
  onOpenInNewTab: () => void;
  onOpenInNewWindow: () => void;
  onResumeSession: (id: string, source?: 'codebuild' | 'claude' | 'grok', cwd?: string) => void;
  onRefreshSessions: () => void;
  onTogglePerf?: () => void;
  onSetStallTimeout?: (seconds: number) => void;
}

const STALL_OPTIONS: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'timeout: never' },
  { seconds: 120, label: 'timeout: 2m' },
  { seconds: 300, label: 'timeout: 5m' },
  { seconds: 600, label: 'timeout: 10m' }
];

function fmtHudMs(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Header({
  state,
  onPickBackend,
  onSetMode,
  onSetModel,
  onSetEffort,
  onNewSession,
  onOpenInNewTab,
  onOpenInNewWindow,
  onResumeSession,
  onRefreshSessions,
  onTogglePerf,
  onSetStallTimeout
}: Props) {
  const current = state.session?.backend ?? '';
  const [historyOpen, setHistoryOpen] = useState(false);

  // Look up the current backend's capabilities to decide which dropdowns
  // to render. Hide the model picker when the backend has no curated
  // model list (e.g. opencode, cline — they don't accept --model);
  // hide effort when the backend doesn't honor it (grok, opencode, cline).
  const currentCap = state.backends.find((b) => b.id === current);
  const modelOptions = currentCap?.models ?? [];
  const supportsEffort = currentCap?.supportsEffort === true;

  // Picker options from the agent-reported modes_update inventory when
  // present (agent labels, inventory-only modes); static fallback otherwise.
  const modeOptions = modePickerOptions(state.modeOptions, state.session?.mode ?? 'default');

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
        title={
          state.pinnedPermissionMode
            ? `Permission mode (workspace pin: ${state.pinnedPermissionMode})`
            : 'Permission mode'
        }
      >
        {modeOptions.map((o) => (
          <option key={o.mode} value={o.mode} disabled={o.mode === 'bypass' && !state.allowBypass}>
            {o.label}
            {state.pinnedPermissionMode === o.mode ? ' · pinned' : ''}
          </option>
        ))}
      </select>

      <button
        type="button"
        className={
          state.pinnedPermissionMode
            ? 'mode-pin-btn mode-pin-btn-active'
            : 'mode-pin-btn'
        }
        title={
          state.pinnedPermissionMode
            ? `Unpin workspace mode (${state.pinnedPermissionMode}). New sessions fall back to lastMode / settings.`
            : 'Pin current permission mode for this workspace (sticky across new sessions)'
        }
        onClick={() => {
          if (state.pinnedPermissionMode) {
            post({ type: 'unpinMode' });
          } else {
            post({ type: 'pinMode' });
          }
        }}
      >
        {state.pinnedPermissionMode ? '📌' : '📍'}
      </button>

      {modelOptions.length > 0 && (
        <select
          className="model-picker"
          value={state.session?.model ?? 'default'}
          onChange={(e) => onSetModel(e.target.value)}
          title="Model — takes effect on next agent process spawn"
        >
          {modelOptions.map((m) => (
            <option key={m} value={m}>
              {m === 'default' ? 'auto · model' : m}
            </option>
          ))}
        </select>
      )}

      {supportsEffort && (
        <select
          className="effort-picker"
          value={state.session?.effort ?? 'default'}
          onChange={(e) => onSetEffort(e.target.value as Effort)}
          title="Effort / thinking budget — takes effect on next agent process spawn"
        >
          {EFFORT_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl === 'default' ? 'auto · effort' : `effort: ${lvl}`}
            </option>
          ))}
        </select>
      )}

      {(state.visActive || state.session?.sessionKind === 'voice-ideation') && (
        <span className="session-kind-badge" title="Voice Ideation Session">
          VIS
        </span>
      )}

      {state.protocolPin && (
        <span
          className={
            state.protocolPin.warn ? 'protocol-pin-chip protocol-pin-chip-warn' : 'protocol-pin-chip'
          }
          title={
            state.protocolPin.warnReason
              ? `${state.protocolPin.label} — ${state.protocolPin.warnReason}`
              : `Negotiated ACP protocol version (host v${state.protocolPin.hostVersion}` +
                (state.protocolPin.agentVersion != null
                  ? `, agent v${state.protocolPin.agentVersion}`
                  : ', agent unknown') +
                '). Read-only; does not block the session.'
          }
        >
          {state.protocolPin.label}
        </span>
      )}

      {state.session?.failoverFrom && state.session.failoverReason && (
        <span
          className="failover-chip"
          title={formatFailoverTooltip(state.session)}
        >
          failover←{state.session.failoverFrom}
        </span>
      )}

      {state.spendLimit && (
        <span
          className={
            state.spendLimit.warn
              ? 'spend-limit-chip spend-limit-chip-warn'
              : state.spendLimit.available
                ? 'spend-limit-chip'
                : 'spend-limit-chip spend-limit-chip-na'
          }
          title={formatSpendLimitTooltip(state.spendLimit)}
        >
          {state.spendLimit.label}
        </span>
      )}

      {state.mediaToolTax && (
        <button
          type="button"
          className={
            state.mediaToolTax.warn || state.mediaToolTax.pause
              ? 'media-tax-chip media-tax-chip-warn'
              : 'media-tax-chip'
          }
          title={formatMediaTaxTooltip(state.mediaToolTax)}
          onClick={() => {
            if (state.mediaToolTax?.preferDomArmed) return;
            post({ type: 'preferDomHint' });
          }}
        >
          {state.mediaToolTax.preferDomArmed
            ? `${state.mediaToolTax.label} · DOM`
            : state.mediaToolTax.label}
        </button>
      )}

      {onSetStallTimeout && (
        <select
          className="stall-picker"
          value={String(state.stallAutoCancelSeconds)}
          onChange={(e) => onSetStallTimeout(Number(e.target.value))}
          title="Auto-stop after this much silence. Never = warn only, do not interrupt long waits."
        >
          {STALL_OPTIONS.map((o) => (
            <option key={o.seconds} value={o.seconds}>
              {o.label}
            </option>
          ))}
          {!STALL_OPTIONS.some((o) => o.seconds === state.stallAutoCancelSeconds) && (
            <option value={state.stallAutoCancelSeconds}>
              timeout: {state.stallAutoCancelSeconds}s
            </option>
          )}
        </select>
      )}

      <div className="header-spacer" />

      {state.daemon && (
        <span
          className={state.daemon.up ? 'daemon-chip daemon-up' : 'daemon-chip daemon-down'}
          title={
            state.daemon.up
              ? `Sessions daemon connected (v${state.daemon.version ?? '?'}) — transcripts dual-write to ~/.sessions`
              : `Sessions daemon down — ${state.daemon.error ?? 'local fallback'}`
          }
        >
          {state.daemon.up ? `daemon ${state.daemon.version ?? 'ok'}` : 'daemon off · local'}
        </span>
      )}

      {state.perfDebug !== 'off' && state.perfHud?.enabled && (
        <button
          type="button"
          className="perf-hud"
          title="Session performance — click for panel (/perf)"
          onClick={onTogglePerf}
        >
          <span>TTFT {fmtHudMs(state.perfHud.ttftMs)}</span>
          <span>host {fmtHudMs(state.perfHud.hostTaxMs)}</span>
          <span>
            {state.perfHud.eventsPerSec != null
              ? `${state.perfHud.eventsPerSec.toFixed(0)}/s`
              : '—/s'}
          </span>
          <span>paint {fmtHudMs(state.perfHud.paintLagMs)}</span>
          <span className="perf-hud-phase">{state.perfHud.phase}</span>
        </button>
      )}

      {state.memoryEntries > 0 && (
        <span
          className="memory-chip"
          title={
            `Memory: ${state.memoryEntries} entr${state.memoryEntries === 1 ? 'y' : 'ies'} across ${state.memoryFiles} source file${state.memoryFiles === 1 ? '' : 's'} (CLAUDE.md / AGENTS.md / MEMORY.md / ~/.claude / ~/.codex visible to the agent).\n` +
            Object.entries(state.memoryByProvider)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ') +
            `\n\nOpen "Memory" in the Code Sessions sidebar for per-source breakdown.`
          }
        >
          🧠 {state.memoryEntries}
        </span>
      )}

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

function formatFailoverTooltip(session: NonNullable<ChatState['session']>): string {
  const lines = [
    `Failed over from ${session.failoverFrom}`,
    `Reason: ${session.failoverReason}`
  ];
  if (session.failoverAt != null && session.failoverAt > 0) {
    try {
      lines.push(`At: ${new Date(session.failoverAt).toLocaleString()}`);
    } catch {
      /* ignore */
    }
  }
  return lines.join('\n');
}

function formatSpendLimitTooltip(chip: NonNullable<ChatState['spendLimit']>): string {
  if (!chip.available) {
    return (
      'Spend limit n/a — this backend did not expose rate_limits.spend_limit ' +
      '(Claude 2.1.251 /usage parity). Never invents remaining %.'
    );
  }
  const lines: string[] = [chip.label];
  if (chip.usedPercentage != null) lines.push(`Used: ${chip.usedPercentage}% of spend limit`);
  if (chip.remainingPercentage != null) lines.push(`Remaining: ${chip.remainingPercentage}%`);
  if (chip.resetsAt != null && chip.resetsAt > 0) {
    try {
      lines.push(`Resets: ${new Date(chip.resetsAt * 1000).toLocaleString()}`);
    } catch {
      /* ignore bad epoch */
    }
  }
  if (chip.warnReason) lines.push(chip.warnReason);
  lines.push('Host parity with Claude Code /usage spend-limit bar — observational only.');
  return lines.join('\n');
}

function formatMediaTaxTooltip(chip: NonNullable<ChatState['mediaToolTax']>): string {
  const lines: string[] = [chip.label];
  lines.push(`Turn media tax: ~${chip.turnMediaTokens} tok`);
  lines.push(
    `Session media tax: ~${chip.sessionMediaTokens} tok across ${chip.sessionMediaCount} media result(s)`
  );
  if (chip.hint) lines.push(chip.hint);
  if (chip.preferDomArmed) {
    lines.push('Prefer DOM/CLI armed — sticky host hint on prompts this session.');
  } else if (chip.pause || chip.warn) {
    lines.push('Click to arm Prefer DOM/CLI (advisory host hint; tools not blocked).');
  } else {
    lines.push('Click to arm Prefer DOM/CLI host hint.');
  }
  lines.push('Meters post-tool pixel payloads — distinct from MCP schema budget.');
  return lines.join('\n');
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
