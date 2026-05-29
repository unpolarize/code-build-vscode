import type { ContentBlock, ToolCall } from '../../../src/shared/acpTypes';
import { post } from '../vscodeApi';

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
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path">{diff.path}</span>
        <button
          className="btn btn-secondary diff-open"
          onClick={() =>
            post({ type: 'openDiff', path: diff.path, oldText: diff.oldText, newText: diff.newText })
          }
        >
          Open diff
        </button>
      </div>
      <pre className="diff-body">
        {renderUnified(diff.oldText, diff.newText)}
      </pre>
    </div>
  );
}

/** Tiny line-based unified preview (full diffing handled by the native diff editor). */
function renderUnified(oldText: string, newText: string) {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const rows: { sign: string; text: string }[] = [];
  for (const l of oldLines) rows.push({ sign: '-', text: l });
  for (const l of newLines) rows.push({ sign: '+', text: l });
  return rows.map((r, i) => (
    <div key={i} className={r.sign === '+' ? 'diff-add' : 'diff-del'}>
      {r.sign} {r.text}
    </div>
  ));
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
