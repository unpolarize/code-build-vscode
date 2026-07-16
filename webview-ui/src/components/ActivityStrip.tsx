import type { ActivitySegmentMsg } from '../../../src/shared/protocol';

interface Props {
  segments: ActivitySegmentMsg[];
  turnDurationMs: number;
  visible: boolean;
}

const COLORS: Record<ActivitySegmentMsg['kind'], string> = {
  think: 'var(--vscode-charts-purple, #a78bfa)',
  text: 'var(--vscode-charts-blue, #60a5fa)',
  tool: 'var(--vscode-charts-orange, #fb923c)',
  wait: 'var(--vscode-descriptionForeground, #888)',
  error: 'var(--vscode-errorForeground, #f87171)',
  idle: 'transparent'
};

/** One-row sparkline of the current turn: think / text / tool segments. */
export function ActivityStrip({ segments, turnDurationMs, visible }: Props) {
  if (!visible || segments.length === 0 || turnDurationMs <= 0) return null;
  const total = Math.max(turnDurationMs, 1);
  return (
    <div className="activity-strip" title="Turn activity (think / text / tools)" aria-label="Turn activity strip">
      {segments.map((s, i) => {
        const start = Math.max(0, s.startMs);
        const end = Math.max(start + 1, s.endMs);
        const left = (start / total) * 100;
        const width = Math.max(0.4, ((end - start) / total) * 100);
        return (
          <div
            key={i}
            className={`activity-seg activity-seg-${s.kind}`}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: COLORS[s.kind]
            }}
            title={`${s.label} · ${((end - start) / 1000).toFixed(1)}s`}
          />
        );
      })}
    </div>
  );
}
