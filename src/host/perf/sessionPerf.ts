/**
 * Session / turn performance collector for Code Build.
 *
 * Pure (no vscode). The SessionManager feeds events; the webview and Output
 * channel consume snapshots / flight reports.
 */
import type { SessionUpdate } from '../../shared/acpTypes';

export type PerfDebugMode = 'off' | 'hud' | 'full';

export interface ActivitySegment {
  kind: 'think' | 'text' | 'tool' | 'wait' | 'error' | 'idle';
  label: string;
  /** ms from turn start */
  startMs: number;
  endMs: number;
  toolCallId?: string;
}

export interface EventRingEntry {
  t: number;
  kind: string;
  preview: string;
  bytes: number;
  diskMs?: number;
  /** Pre-normalize raw line (when available) */
  rawPreview?: string;
}

export interface TurnPerf {
  turnId: string;
  promptSentAt: number;
  firstEventAt?: number;
  firstTokenAt?: number;
  firstThoughtAt?: number;
  firstToolAt?: number;
  resultAt?: number;
  eventCount: number;
  byKind: Record<string, number>;
  diskWriteCount: number;
  diskMsTotal: number;
  maxDiskMs: number;
  ipcPostCount: number;
  ipcBatchMax: number;
  silenceMaxMs: number;
  lastMeaningfulAt: number;
  openToolsMax: number;
  segments: ActivitySegment[];
  paintLagMs?: number;
  renderMsAvg?: number;
  itemsAtEnd?: number;
}

export interface DualStoreInfo {
  codebuildPath?: string;
  codebuildBytes?: number;
  codebuildMtimeMs?: number;
  claudePath?: string;
  claudeBytes?: number;
  claudeMtimeMs?: number;
}

export interface PerfHud {
  enabled: boolean;
  ttfeMs?: number;
  ttftMs?: number;
  hostTaxMs: number;
  eventsPerSec?: number;
  paintLagMs?: number;
  openTools: number;
  phase: string;
}

export interface PerfSnapshot {
  mode: PerfDebugMode;
  sessionId?: string;
  backend?: string;
  model?: string;
  modePerm?: string;
  currentTurn?: TurnPerf;
  previousTurns: TurnPerf[];
  eventRing: EventRingEntry[];
  dualStore?: DualStoreInfo;
  hud: PerfHud;
  flightReport: string;
}

const RING_MAX = 4000;
const PREV_TURNS_MAX = 20;

function previewOf(update: SessionUpdate): string {
  switch (update.kind) {
    case 'agent_message_chunk':
      return update.content?.type === 'text' ? (update.content.text ?? '').slice(0, 80) : '[chunk]';
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? (update.content.text ?? '').slice(0, 80) : '[thought]';
    case 'tool_call':
      return `${update.toolCall.title ?? 'tool'} ${update.toolCall.toolCallId.slice(0, 8)}`;
    case 'tool_call_update':
      return `${update.toolCall.status ?? '?'} ${update.toolCall.toolCallId.slice(0, 8)}`;
    case 'result':
      return update.stopReason ?? 'end';
    case 'error':
      return (update.message ?? 'error').slice(0, 100);
    case 'system_init':
      return `sid ${(update.backendSessionId ?? '').slice(0, 8)}`;
    case 'usage':
      return `in=${update.usage?.inputTokens ?? '?'} out=${update.usage?.outputTokens ?? '?'}`;
    default:
      return update.kind;
  }
}

function isMeaningful(kind: string): boolean {
  return (
    kind === 'agent_message_chunk' ||
    kind === 'agent_thought_chunk' ||
    kind === 'tool_call' ||
    kind === 'tool_call_update' ||
    kind === 'usage' ||
    kind === 'plan' ||
    kind === 'permission_request' ||
    kind === 'result' ||
    kind === 'error'
  );
}

export class SessionPerfCollector {
  mode: PerfDebugMode = 'off';
  sessionId?: string;
  backend?: string;
  model?: string;
  modePerm?: string;
  dualStore?: DualStoreInfo;

  private turn?: TurnPerf;
  private previousTurns: TurnPerf[] = [];
  private ring: EventRingEntry[] = [];
  private openTools = 0;
  private segmentOpen?: ActivitySegment;
  private lastPaintLagMs?: number;
  private lastRenderMsAvg?: number;

  setMode(mode: PerfDebugMode): void {
    this.mode = mode;
  }

  setSessionMeta(meta: {
    sessionId?: string;
    backend?: string;
    model?: string;
    modePerm?: string;
  }): void {
    if (meta.sessionId !== undefined) this.sessionId = meta.sessionId;
    if (meta.backend !== undefined) this.backend = meta.backend;
    if (meta.model !== undefined) this.model = meta.model;
    if (meta.modePerm !== undefined) this.modePerm = meta.modePerm;
  }

  setDualStore(info: DualStoreInfo): void {
    this.dualStore = info;
  }

  /** Call when user prompt is submitted. */
  onPromptSent(at = Date.now()): void {
    if (this.turn && !this.turn.resultAt) {
      this.closeTurn(at);
    }
    const turnId = `t${at.toString(36)}`;
    this.turn = {
      turnId,
      promptSentAt: at,
      eventCount: 0,
      byKind: {},
      diskWriteCount: 0,
      diskMsTotal: 0,
      maxDiskMs: 0,
      ipcPostCount: 0,
      ipcBatchMax: 0,
      silenceMaxMs: 0,
      lastMeaningfulAt: at,
      openToolsMax: 0,
      segments: []
    };
    this.openTools = 0;
    this.segmentOpen = undefined;
  }

  /** Record a disk append cost (ms). */
  recordDiskWrite(diskMs: number): void {
    if (!this.turn) return;
    this.turn.diskWriteCount += 1;
    this.turn.diskMsTotal += diskMs;
    if (diskMs > this.turn.maxDiskMs) this.turn.maxDiskMs = diskMs;
  }

  /** Record an IPC flush of `batchSize` updates. */
  recordIpcFlush(batchSize: number): void {
    if (!this.turn) return;
    this.turn.ipcPostCount += 1;
    if (batchSize > this.turn.ipcBatchMax) this.turn.ipcBatchMax = batchSize;
  }

  /** Webview paint lag / render samples. */
  recordWebviewSample(paintLagMs?: number, renderMs?: number, items?: number): void {
    if (paintLagMs != null) this.lastPaintLagMs = paintLagMs;
    if (this.turn) {
      if (paintLagMs != null) this.turn.paintLagMs = paintLagMs;
      if (renderMs != null) {
        this.lastRenderMsAvg = renderMs;
        this.turn.renderMsAvg = renderMs;
      }
      if (items != null) this.turn.itemsAtEnd = items;
    }
  }

  /**
   * Feed a SessionUpdate. Returns whether this was meaningful progress.
   * `rawPreview` optional pre-normalize line for the inspector.
   */
  onUpdate(update: SessionUpdate, opts?: { t?: number; diskMs?: number; rawPreview?: string }): void {
    const t = opts?.t ?? Date.now();
    const kind = update.kind;
    const entry: EventRingEntry = {
      t,
      kind,
      preview: previewOf(update),
      bytes: roughBytes(update),
      diskMs: opts?.diskMs,
      rawPreview: opts?.rawPreview
    };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);

    if (!this.turn) return;
    const turn = this.turn;
    turn.eventCount += 1;
    turn.byKind[kind] = (turn.byKind[kind] ?? 0) + 1;
    if (opts?.diskMs != null) {
      turn.diskWriteCount += 1;
      turn.diskMsTotal += opts.diskMs;
      if (opts.diskMs > turn.maxDiskMs) turn.maxDiskMs = opts.diskMs;
    }

    if (!turn.firstEventAt && isMeaningful(kind)) {
      turn.firstEventAt = t;
    }

    if (isMeaningful(kind)) {
      const gap = t - turn.lastMeaningfulAt;
      if (gap > turn.silenceMaxMs) turn.silenceMaxMs = gap;
      turn.lastMeaningfulAt = t;
    }

    // Tool open/close tracking
    if (kind === 'tool_call') {
      this.openTools += 1;
      if (this.openTools > turn.openToolsMax) turn.openToolsMax = this.openTools;
      if (!turn.firstToolAt) turn.firstToolAt = t;
      this.closeSegment(t);
      const id = update.toolCall.toolCallId;
      this.segmentOpen = {
        kind: 'tool',
        label: update.toolCall.title ?? 'tool',
        startMs: t - turn.promptSentAt,
        endMs: t - turn.promptSentAt,
        toolCallId: id
      };
    } else if (kind === 'tool_call_update') {
      const st = update.toolCall.status;
      if (st === 'completed' || st === 'failed') {
        this.openTools = Math.max(0, this.openTools - 1);
        if (this.segmentOpen?.kind === 'tool' && this.segmentOpen.toolCallId === update.toolCall.toolCallId) {
          this.segmentOpen.endMs = t - turn.promptSentAt;
          turn.segments.push(this.segmentOpen);
          this.segmentOpen = undefined;
        }
      }
    } else if (kind === 'agent_thought_chunk') {
      if (!turn.firstThoughtAt) turn.firstThoughtAt = t;
      this.ensureSegment(turn, t, 'think', 'thinking');
    } else if (kind === 'agent_message_chunk') {
      if (!turn.firstTokenAt) turn.firstTokenAt = t;
      this.ensureSegment(turn, t, 'text', 'text');
    } else if (kind === 'error') {
      this.closeSegment(t);
      turn.segments.push({
        kind: 'error',
        label: 'error',
        startMs: t - turn.promptSentAt,
        endMs: t - turn.promptSentAt
      });
    } else if (kind === 'result') {
      turn.resultAt = t;
      this.closeSegment(t);
      this.closeTurn(t);
    }
  }

  private ensureSegment(
    turn: TurnPerf,
    t: number,
    kind: ActivitySegment['kind'],
    label: string
  ): void {
    const rel = t - turn.promptSentAt;
    if (this.segmentOpen && this.segmentOpen.kind === kind) {
      this.segmentOpen.endMs = rel;
      return;
    }
    this.closeSegment(t);
    this.segmentOpen = { kind, label, startMs: rel, endMs: rel };
  }

  private closeSegment(t: number): void {
    if (!this.segmentOpen || !this.turn) return;
    this.segmentOpen.endMs = Math.max(this.segmentOpen.endMs, t - this.turn.promptSentAt);
    this.turn.segments.push(this.segmentOpen);
    this.segmentOpen = undefined;
  }

  private closeTurn(at: number): void {
    if (!this.turn) return;
    this.closeSegment(at);
    if (!this.turn.resultAt) this.turn.resultAt = at;
    if (this.lastPaintLagMs != null) this.turn.paintLagMs = this.lastPaintLagMs;
    if (this.lastRenderMsAvg != null) this.turn.renderMsAvg = this.lastRenderMsAvg;
    this.previousTurns.unshift(this.turn);
    if (this.previousTurns.length > PREV_TURNS_MAX) this.previousTurns.pop();
    this.turn = undefined;
    this.openTools = 0;
  }

  /** Force-end current turn (cancel). */
  onCancel(at = Date.now()): void {
    if (!this.turn) return;
    this.closeTurn(at);
  }

  getCurrentTurn(): TurnPerf | undefined {
    return this.turn;
  }

  getHud(): PerfHud {
    const turn = this.turn ?? this.previousTurns[0];
    const now = Date.now();
    if (!turn) {
      return {
        enabled: this.mode !== 'off',
        hostTaxMs: 0,
        openTools: this.openTools,
        phase: 'idle'
      };
    }
    const ttfeMs =
      turn.firstEventAt != null ? turn.firstEventAt - turn.promptSentAt : undefined;
    const ttftMs =
      turn.firstTokenAt != null ? turn.firstTokenAt - turn.promptSentAt : undefined;
    const hostTaxMs = Math.round(turn.diskMsTotal);
    const end = turn.resultAt ?? now;
    const durSec = Math.max(0.001, (end - turn.promptSentAt) / 1000);
    const eventsPerSec = turn.eventCount / durSec;
    let phase = 'waiting';
    if (turn.resultAt) phase = 'done';
    else if (this.openTools > 0) phase = `tool×${this.openTools}`;
    else if (turn.firstTokenAt) phase = 'streaming';
    else if (turn.firstThoughtAt) phase = 'thinking';
    else if (turn.firstEventAt) phase = 'agent';
    return {
      enabled: this.mode !== 'off',
      ttfeMs,
      ttftMs,
      hostTaxMs,
      eventsPerSec,
      paintLagMs: turn.paintLagMs ?? this.lastPaintLagMs,
      openTools: this.openTools,
      phase
    };
  }

  snapshot(): PerfSnapshot {
    return {
      mode: this.mode,
      sessionId: this.sessionId,
      backend: this.backend,
      model: this.model,
      modePerm: this.modePerm,
      currentTurn: this.turn,
      previousTurns: this.previousTurns.slice(),
      eventRing: this.ring.slice(-500),
      dualStore: this.dualStore,
      hud: this.getHud(),
      flightReport: this.formatFlightReport()
    };
  }

  formatFlightReport(): string {
    const turn = this.turn ?? this.previousTurns[0];
    const hud = this.getHud();
    const lines: string[] = [
      '### CB perf snapshot',
      `- version: (host)  backend: ${this.backend ?? '?'}  model: ${this.model ?? 'default'}  mode: ${this.modePerm ?? '?'}`,
      `- session: ${(this.sessionId ?? '').slice(0, 8) || '—'}  perfDebug: ${this.mode}`
    ];
    if (turn) {
      const ttfe =
        turn.firstEventAt != null
          ? ((turn.firstEventAt - turn.promptSentAt) / 1000).toFixed(2)
          : '—';
      const ttft =
        turn.firstTokenAt != null
          ? ((turn.firstTokenAt - turn.promptSentAt) / 1000).toFixed(2)
          : '—';
      const end = turn.resultAt ?? Date.now();
      const duration = ((end - turn.promptSentAt) / 1000).toFixed(1);
      lines.push(
        `- turn: TTFE ${ttfe}s  TTFT ${ttft}s  duration ${duration}s  phase ${hud.phase}`
      );
      lines.push(
        `- host tax: ${Math.round(turn.diskMsTotal)}ms (disk n=${turn.diskWriteCount} max ${turn.maxDiskMs.toFixed(1)}ms, ipc posts ${turn.ipcPostCount} maxBatch ${turn.ipcBatchMax})`
      );
      lines.push(
        `- webview: paint lag ${turn.paintLagMs ?? this.lastPaintLagMs ?? '—'}ms, items ${turn.itemsAtEnd ?? '—'}, renderAvg ${turn.renderMsAvg?.toFixed?.(1) ?? this.lastRenderMsAvg?.toFixed?.(1) ?? '—'}ms`
      );
      const kinds = Object.entries(turn.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ');
      lines.push(`- events: ${turn.eventCount} (${kinds})`);
      lines.push(
        `- flags: silenceMax ${(turn.silenceMaxMs / 1000).toFixed(1)}s openToolsMax=${turn.openToolsMax}`
      );
    } else {
      lines.push('- turn: (no turn yet)');
    }
    if (this.dualStore) {
      const ds = this.dualStore;
      lines.push(
        `- dual-store: cb ${fmtBytes(ds.codebuildBytes)} · claude ${fmtBytes(ds.claudeBytes)}`
      );
      if (ds.codebuildPath) lines.push(`  cb: ${ds.codebuildPath}`);
      if (ds.claudePath) lines.push(`  claude: ${ds.claudePath}`);
    }
    // Decision tree
    lines.push('', '### Decision tree');
    if (turn) {
      const ttft = turn.firstTokenAt != null ? turn.firstTokenAt - turn.promptSentAt : 0;
      const hostTax = turn.diskMsTotal;
      const paint = turn.paintLagMs ?? this.lastPaintLagMs ?? 0;
      if (ttft > 3000 && hostTax < 100 && paint < 150) {
        lines.push('- High TTFT, low host tax/paint → **model / network / CLI**');
      } else if (paint > 200) {
        lines.push('- High paint lag → **webview markdown / list render**');
      } else if (hostTax > 200 || turn.maxDiskMs > 5) {
        lines.push('- High host tax / disk → **sync store or unbatched IPC** (check batching)');
      } else if (turn.openToolsMax > 0 && (turn.silenceMaxMs ?? 0) > 5000) {
        lines.push('- Long silence with open tools → **real tool work** (not CB)');
      } else {
        lines.push('- No dominant signal — compare with native Claude on same prompt');
      }
    } else {
      lines.push('- No turn data yet — send a prompt with perfDebug on');
    }
    return lines.join('\n');
  }

  /** Exportable JSON for ~/.codebuild/sessions/<id>.perf.json */
  toExportJson(version: string): unknown {
    return {
      type: 'code-build-perf',
      version,
      exportedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      backend: this.backend,
      model: this.model,
      mode: this.modePerm,
      dualStore: this.dualStore,
      currentTurn: this.turn,
      previousTurns: this.previousTurns,
      eventRingTail: this.ring.slice(-200),
      flightReport: this.formatFlightReport()
    };
  }
}

function roughBytes(update: SessionUpdate): number {
  try {
    return JSON.stringify(update).length;
  } catch {
    return 0;
  }
}

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/** Format ms for HUD display. */
export function fmtMs(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
