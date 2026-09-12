import { useState } from 'react';
import type { PermissionMode } from '../../../src/shared/acpTypes';
import { modePickerOptions } from '../../../src/shared/permissionModes';
import { formatModelSwitchTooltip } from '../../../src/shared/modelSwitchHook';
import { formatFinishabilityTooltip } from '../../../src/shared/finishabilityPreflight';
import { formatSandboxPostureTooltip } from '../../../src/shared/sandboxPostureChip';
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

      <button
        type="button"
        className={
          state.investigate
            ? 'mode-pin-btn mode-pin-btn-active'
            : 'mode-pin-btn'
        }
        title={
          !state.investigate
            ? 'Investigate mode: lock host writes until the agent reports a structured Findings block (path + severity + observation)'
            : state.investigate.unlocked
              ? `${state.investigate.chip}. Click to turn Investigate off.`
              : `${state.investigate.chip}. Click to unlock writes (needs ≥1 finding); alt-click to turn Investigate off.`
        }
        onClick={(e) => {
          if (!state.investigate) {
            post({ type: 'investigateDecision', decision: 'arm' });
          } else if (state.investigate.unlocked || e.altKey) {
            post({ type: 'investigateDecision', decision: 'disarm' });
          } else {
            post({ type: 'investigateDecision', decision: 'unlock' });
          }
        }}
      >
        {!state.investigate
          ? '🔎'
          : state.investigate.unlocked
            ? `🔎✓${state.investigate.findingsCount}`
            : `🔎🔒${state.investigate.findingsCount}`}
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
          title={
            state.effortCeiling?.available && state.effortCeiling.ceiling
              ? `Effort / thinking budget (ceiling: ${state.effortCeiling.ceiling} · ${state.effortCeiling.source ?? 'unknown'}) — takes effect on next agent process spawn`
              : 'Effort / thinking budget — takes effect on next agent process spawn'
          }
        >
          {EFFORT_LEVELS.map((lvl) => {
            const ceil = state.effortCeiling?.available
              ? state.effortCeiling.ceiling
              : null;
            const over =
              ceil != null &&
              lvl !== 'default' &&
              EFFORT_LEVELS.indexOf(lvl) > EFFORT_LEVELS.indexOf(ceil as Effort);
            return (
              <option key={lvl} value={lvl} disabled={over}>
                {lvl === 'default'
                  ? 'auto · effort'
                  : over
                    ? `effort: ${lvl} (over ceil)`
                    : `effort: ${lvl}`}
              </option>
            );
          })}
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

      {state.sessionStopCapability && (
        <span
          className={
            state.sessionStopCapability.hostTeardown
              ? 'protocol-pin-chip protocol-pin-chip-warn'
              : 'protocol-pin-chip'
          }
          title={state.sessionStopCapability.reason}
        >
          {state.sessionStopCapability.label}
        </span>
      )}

      {state.sandboxPosture?.available && (
        <button
          type="button"
          className={
            state.sandboxPosture.warn || state.sandboxPosture.conflict
              ? 'sandbox-posture-chip sandbox-posture-chip-warn'
              : 'sandbox-posture-chip'
          }
          title={formatSandboxPostureTooltip(state.sandboxPosture)}
          onClick={() => post({ type: 'sandboxPostureDetail' })}
        >
          {state.sandboxPosture.label}
        </button>
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

      {state.effortCeiling?.available && (
        <span
          className={
            state.effortCeiling.warn
              ? 'effort-ceiling-chip effort-ceiling-chip-warn'
              : 'effort-ceiling-chip'
          }
          title={formatEffortCeilingTooltip(state.effortCeiling)}
        >
          {state.effortCeiling.label}
        </span>
      )}

      {state.cacheMiss?.available && (
        <span
          className={
            state.cacheMiss.warn
              ? 'cache-miss-chip cache-miss-chip-warn'
              : 'cache-miss-chip'
          }
          title={formatCacheMissTooltip(state.cacheMiss)}
        >
          {state.cacheMiss.label}
        </span>
      )}

      {state.modelSwitch?.available && (
        <span
          className={
            state.modelSwitch.warn
              ? 'model-switch-chip model-switch-chip-warn'
              : 'model-switch-chip'
          }
          title={formatModelSwitchTooltip(state.modelSwitch)}
        >
          {state.modelSwitch.label}
        </span>
      )}

      {state.writeDrain?.available && (
        <span
          className={
            state.writeDrain.warn
              ? 'write-drain-chip write-drain-chip-warn'
              : 'write-drain-chip'
          }
          title={formatWriteDrainTooltip(state.writeDrain)}
        >
          {state.writeDrain.label}
        </span>
      )}

      {state.finishability?.available &&
        (state.finishability.gated ? (
          <button
            type="button"
            className={
              state.finishability.warn
                ? 'finishability-chip finishability-chip-warn'
                : 'finishability-chip'
            }
            title={formatFinishabilityTooltip(state.finishability)}
            onClick={(e) => {
              if (e.shiftKey) post({ type: 'finishabilityDecision', action: 'rebind' });
              else if (e.altKey) post({ type: 'finishabilityDecision', action: 'shrink' });
              else post({ type: 'finishabilityDecision', action: 'override' });
            }}
          >
            {state.finishability.label}
          </button>
        ) : (
          <span
            className={
              state.finishability.warn
                ? 'finishability-chip finishability-chip-warn'
                : 'finishability-chip'
            }
            title={formatFinishabilityTooltip(state.finishability)}
          >
            {state.finishability.label}
          </span>
        ))}

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

      {state.idleNoticeTax && (
        <span
          className={
            state.idleNoticeTax.warn || state.idleNoticeTax.pause
              ? 'media-tax-chip media-tax-chip-warn'
              : 'media-tax-chip'
          }
          title={formatIdleNoticeTooltip(state.idleNoticeTax)}
        >
          {state.idleNoticeTax.label}
        </span>
      )}

      {state.teammateCompact && (
        <button
          type="button"
          className={
            state.teammateCompact.warn
              ? 'media-tax-chip media-tax-chip-warn'
              : 'media-tax-chip'
          }
          title={formatTeammateCompactTooltip(state.teammateCompact)}
          onClick={() => post({ type: 'compactTeammate' })}
        >
          {state.teammateCompact.label}
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

function formatCacheMissTooltip(
  chip: NonNullable<ChatState['cacheMiss']>
): string {
  const lines: string[] = [];
  if (!chip.available) {
    return (
      'cache: n/a — this backend did not expose cache_read / cache_creation / miss fields. ' +
      'Never invents Anthropic Cache Diagnostics for other vendors.'
    );
  }
  const hit = chip.hitPct != null ? `${chip.hitPct}%` : 'n/a';
  if (chip.lastMissSegment) {
    const tok =
      chip.lastMissTokens != null
        ? ` (+${chip.lastMissTokens.toLocaleString()} tok)`
        : '';
    lines.push(`cache: ${hit} | last miss: ${chip.lastMissSegment}${tok}`);
  } else {
    lines.push(`cache: ${hit}`);
  }
  if (chip.cacheReadTokens != null) {
    lines.push(`Cache read: ${chip.cacheReadTokens.toLocaleString()} tok`);
  }
  if (chip.cacheCreationTokens != null) {
    lines.push(`Cache write: ${chip.cacheCreationTokens.toLocaleString()} tok`);
  }
  if (chip.sourceDetail) lines.push(chip.sourceDetail);
  if (chip.warnReason) lines.push(chip.warnReason);
  lines.push(
    'Claude Cache Diagnostics class — miss segment (system/tools/history/unknown). ' +
      'Degrades to hit% when the vendor omitted the segment. Distinct from parked hit-meter.'
  );
  lines.push('codeBuild.cacheMiss.mode');
  return lines.join('\n');
}

function formatWriteDrainTooltip(
  chip: NonNullable<ChatState['writeDrain']>
): string {
  const lines: string[] = [chip.label];
  if (chip.hint) lines.push(chip.hint);
  if (chip.flushed) lines.push(`Flushed complete writes: ${chip.flushed}`);
  if (chip.rolledBack) lines.push(`Rolled back truncated writes: ${chip.rolledBack}`);
  if (chip.skipped) lines.push(`Skipped (no pre-image): ${chip.skipped}`);
  if (chip.paths.length) {
    const shown = chip.paths.slice(0, 6);
    lines.push(`Paths: ${shown.join(', ')}${chip.paths.length > 6 ? '…' : ''}`);
  }
  lines.push(
    'Host invariant: on a quota/rate-limit signal, in-flight Write/Edit either flushes to a complete file or rolls back to the pre-image — never a truncated file. Then the session parks.'
  );
  return lines.join('\n');
}

function formatEffortCeilingTooltip(
  chip: NonNullable<ChatState['effortCeiling']>
): string {
  const lines: string[] = [chip.label];
  if (chip.ceiling) lines.push(`Ceiling: ${chip.ceiling}`);
  if (chip.selected) lines.push(`Selected: ${chip.selected}`);
  if (chip.source) lines.push(`Source: ${chip.source}`);
  if (chip.sourceDetail) lines.push(chip.sourceDetail);
  if (chip.warnReason) lines.push(chip.warnReason);
  lines.push(
    'Claude 2.1.267 maxEffortLevel / codex-acp recommended effort — distinct from effort-semantics drift canary.'
  );
  lines.push('codeBuild.maxEffortLevel · codeBuild.effortCeiling.mode');
  return lines.join('\n');
}

function formatTeammateCompactTooltip(
  chip: NonNullable<ChatState['teammateCompact']>
): string {
  const lines = [
    chip.label,
    `${chip.childCount} child(ren) · near ${chip.approachingCount + chip.criticalCount} · compacted ${chip.compactedCount} · parked ${chip.parkedCount} · failed ${chip.failedCount}`,
    chip.hint ??
      'Host compact proxy for Agent Team / subagent children near context limit (Claude #49786). Click to act.',
    'codeBuild.teammateCompact.*'
  ];
  return lines.join('\n');
}

function formatIdleNoticeTooltip(chip: NonNullable<ChatState['idleNoticeTax']>): string {
  const lines: string[] = [chip.label];
  lines.push(
    `Team coordination chatter: ${chip.idleCount} idle notice(s), ${chip.taskNoticeCount} task notice(s)`
  );
  lines.push(`Estimated context consumed: ~${chip.sessionNoticeTokens} tok (chars÷4 heuristic)`);
  if (chip.hint) lines.push(chip.hint);
  lines.push('Observe-only — idle notices are never blocked. codeBuild.idleNoticeTax.*');
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
