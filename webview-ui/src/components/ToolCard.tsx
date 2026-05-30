import type { ContentBlock, ToolCall } from '../../../src/shared/acpTypes';
import { post } from '../vscodeApi';
import { lineDiff } from '../diff';

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✕'
};

export function ToolCard({ tool }: { tool: ToolCall }) {
  const blocks = tool.content ?? [];
  const diffs = blocks.filter((b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff');
  const resultText = blocks
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
  const loc = tool.locations?.[0];

  return (
    <details className={`tool tool-${tool.status} tool-kind-${tool.kind ?? 'other'}`} open={diffs.length > 0}>
      <summary>
        <span className="tool-status">{STATUS_ICON[tool.status] ?? '·'}</span>
        <span className="tool-title">{tool.title}</span>
        {loc && (
          <span
            className="tool-loc"
            onClick={(e) => {
              e.preventDefault();
              post({ type: 'revealLocation', path: loc.path, line: loc.line });
            }}
          >
            {loc.path}
          </span>
        )}
      </summary>

      {tool.rawInput != null && diffs.length === 0 && (
        <pre className="tool-input">{safeStringify(tool.rawInput)}</pre>
      )}

      {diffs.map((d, i) => (
        <DiffBlock key={i} diff={d} />
      ))}

      {resultText && <pre className="tool-result">{resultText}</pre>}
    </details>
  );
}

function DiffBlock({ diff }: { diff: Extract<ContentBlock, { type: 'diff' }> }) {
  const rows = lineDiff(diff.oldText, diff.newText);
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  const name = diff.path.split('/').pop() ?? diff.path;
  // Collapse very large diffs by default (Claude-style "click to expand").
  const big = rows.length > 40;

  return (
    <details className="diff" open={!big}>
      <summary className="diff-head">
        <span className="diff-file">{name}</span>
        <span className="diff-stat">
          {added > 0 && <span className="diff-add-count">+{added}</span>}
          {removed > 0 && <span className="diff-del-count">−{removed}</span>}
        </span>
        <span className="diff-spacer" />
        <span
          className="diff-open"
          onClick={(e) => {
            e.preventDefault();
            post({ type: 'openDiff', path: diff.path, oldText: diff.oldText, newText: diff.newText });
          }}
        >
          Open diff ↗
        </span>
      </summary>
      <pre className="diff-body">
        {rows.map((r, i) => (
          <div key={i} className={`diff-line diff-${r.type}`}>
            <span className="diff-gutter">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
            <span className="diff-text">{r.text || ' '}</span>
          </div>
        ))}
      </pre>
    </details>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
