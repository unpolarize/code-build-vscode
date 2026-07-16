import type { PerfSnapshotMsg } from '../../../src/shared/protocol';

interface Props {
  open: boolean;
  snapshot: PerfSnapshotMsg | null;
  onClose: () => void;
  onRefresh: () => void;
  onCopy: () => void;
  onExport: () => void;
}

function fmtMs(ms?: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
}

/** Session Performance panel: waterfall, event inspector, dual-store, flight report. */
export function PerfPanel({ open, snapshot, onClose, onRefresh, onCopy, onExport }: Props) {
  if (!open) return null;
  const turn = snapshot?.currentTurn ?? snapshot?.previousTurns?.[0];
  const hud = snapshot?.hud;
  const ring = snapshot?.eventRing ?? [];
  const dual = snapshot?.dualStore;
  const durationMs =
    turn != null
      ? (turn.resultAt ?? Date.now()) - turn.promptSentAt
      : 0;

  return (
    <div className="perf-panel" role="dialog" aria-label="Session Performance">
      <div className="perf-panel-header">
        <strong>Session Performance</strong>
        <span className="perf-panel-meta">
          {snapshot?.backend ?? '?'}
          {snapshot?.model ? ` · ${snapshot.model}` : ''}
          {snapshot?.mode ? ` · debug:${snapshot.mode}` : ''}
        </span>
        <div className="perf-panel-actions">
          <button type="button" className="btn" onClick={onRefresh} title="Refresh snapshot">
            ↻
          </button>
          <button type="button" className="btn" onClick={onCopy} title="Copy flight report">
            Copy
          </button>
          <button type="button" className="btn" onClick={onExport} title="Export .perf.json">
            Export
          </button>
          <button type="button" className="btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>
      </div>

      <div className="perf-kpis">
        <span>TTFE {fmtMs(hud?.ttfeMs)}</span>
        <span>TTFT {fmtMs(hud?.ttftMs)}</span>
        <span>Host tax {fmtMs(hud?.hostTaxMs)}</span>
        <span>Paint {fmtMs(hud?.paintLagMs)}</span>
        <span>
          {hud?.eventsPerSec != null ? `${hud.eventsPerSec.toFixed(0)} ev/s` : '— ev/s'}
        </span>
        <span>phase {hud?.phase ?? '—'}</span>
      </div>

      {turn && (
        <div className="perf-waterfall">
          <div className="perf-section-title">Phase timeline</div>
          <WaterfallRow label="prompt" ms={0} total={durationMs} />
          {turn.firstEventAt != null && (
            <WaterfallRow
              label="first event"
              ms={turn.firstEventAt - turn.promptSentAt}
              total={durationMs}
            />
          )}
          {turn.firstThoughtAt != null && (
            <WaterfallRow
              label="thinking"
              ms={turn.firstThoughtAt - turn.promptSentAt}
              total={durationMs}
            />
          )}
          {turn.firstTokenAt != null && (
            <WaterfallRow
              label="first token"
              ms={turn.firstTokenAt - turn.promptSentAt}
              total={durationMs}
            />
          )}
          {turn.firstToolAt != null && (
            <WaterfallRow
              label="first tool"
              ms={turn.firstToolAt - turn.promptSentAt}
              total={durationMs}
            />
          )}
          {turn.resultAt != null && (
            <WaterfallRow
              label="result"
              ms={turn.resultAt - turn.promptSentAt}
              total={durationMs}
            />
          )}
          <div className="perf-hotpath">
            disk writes: {turn.diskWriteCount} · max {turn.maxDiskMs.toFixed(1)}ms · total{' '}
            {Math.round(turn.diskMsTotal)}ms · ipc posts {turn.ipcPostCount} · maxBatch{' '}
            {turn.ipcBatchMax}
          </div>
          {turn.byKind && (
            <div className="perf-kinds">
              {Object.entries(turn.byKind)
                .map(([k, n]) => `${k}:${n}`)
                .join(' · ')}
            </div>
          )}
        </div>
      )}

      {dual && (dual.codebuildPath || dual.claudePath) && (
        <div className="perf-dual">
          <div className="perf-section-title">Dual store</div>
          {dual.codebuildPath && (
            <div className="perf-dual-row" title={dual.codebuildPath}>
              <code>CB</code> {fmtBytes(dual.codebuildBytes)}
              {dual.codebuildMtimeMs != null && (
                <span className="perf-dual-time">
                  {' '}
                  · {new Date(dual.codebuildMtimeMs).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}
          {dual.claudePath && (
            <div className="perf-dual-row" title={dual.claudePath}>
              <code>Claude</code> {fmtBytes(dual.claudeBytes)}
              {dual.claudeMtimeMs != null && (
                <span className="perf-dual-time">
                  {' '}
                  · {new Date(dual.claudeMtimeMs).toLocaleTimeString()}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="perf-events">
        <div className="perf-section-title">Event inspector (latest {Math.min(ring.length, 80)})</div>
        <div className="perf-event-list">
          {ring
            .slice(-80)
            .reverse()
            .map((e, i) => (
              <div key={i} className="perf-event-row" title={e.rawPreview ?? e.preview}>
                <span className="perf-event-kind">{e.kind}</span>
                <span className="perf-event-preview">{e.preview}</span>
                <span className="perf-event-bytes">{e.bytes}B</span>
                {e.diskMs != null && e.diskMs > 0.05 && (
                  <span className="perf-event-disk">{e.diskMs.toFixed(1)}ms</span>
                )}
              </div>
            ))}
          {ring.length === 0 && <div className="perf-empty">No events yet — send a prompt.</div>}
        </div>
      </div>

      {snapshot?.flightReport && (
        <pre className="perf-report">{snapshot.flightReport}</pre>
      )}
    </div>
  );
}

function WaterfallRow({ label, ms, total }: { label: string; ms: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (ms / total) * 100) : 0;
  return (
    <div className="perf-wf-row">
      <span className="perf-wf-label">{label}</span>
      <div className="perf-wf-track">
        <div className="perf-wf-bar" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="perf-wf-ms">{fmtMs(ms)}</span>
    </div>
  );
}
