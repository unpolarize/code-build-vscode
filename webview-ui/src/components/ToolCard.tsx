import type { ToolCall } from '../../../src/shared/acpTypes';

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✕'
};

export function ToolCard({ tool }: { tool: ToolCall }) {
  const resultText = (tool.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();

  return (
    <details className={`tool tool-${tool.status} tool-kind-${tool.kind ?? 'other'}`}>
      <summary>
        <span className="tool-status">{STATUS_ICON[tool.status] ?? '·'}</span>
        <span className="tool-title">{tool.title}</span>
        {tool.locations?.[0] && <span className="tool-loc">{tool.locations[0].path}</span>}
      </summary>
      {tool.rawInput != null && (
        <pre className="tool-input">{safeStringify(tool.rawInput)}</pre>
      )}
      {resultText && <pre className="tool-result">{resultText}</pre>}
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
