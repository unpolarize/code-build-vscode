import type { ContentBlock, ToolCall } from '../../../src/shared/acpTypes';
import { post } from '../vscodeApi';
import { lineDiff } from '../diff';

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✕'
};

/** Detect noteworthy operations the user typically wants highlighted in the
 * chat timeline — primarily git commits / pushes (irreversible, often
 * unintended) but also any bash invocation that names a destructive verb.
 * Returns a small badge label or null. */
function classifyTool(tool: ToolCall): { badge: string; severity: 'info' | 'warn' } | null {
  const name = tool.title;
  const raw = tool.rawInput as { command?: string; cmd?: string } | undefined;
  const cmd = (raw?.command ?? raw?.cmd ?? '').toLowerCase();
  if (name === 'Bash' || name === 'run_terminal_command' || name === 'execute_bash') {
    if (/\bgit\s+push\b/.test(cmd)) return { badge: '↑ git push', severity: 'warn' };
    if (/\bgit\s+commit\b/.test(cmd)) return { badge: '◆ git commit', severity: 'warn' };
    if (/\bgit\s+merge\b/.test(cmd)) return { badge: '◆ git merge', severity: 'warn' };
    if (/\bgit\s+reset\s+--hard\b/.test(cmd)) return { badge: '⚠ git reset --hard', severity: 'warn' };
    if (/\brm\s+-rf\b/.test(cmd)) return { badge: '⚠ rm -rf', severity: 'warn' };
    if (/\bnpm\s+(install|run\s+build|publish)\b/.test(cmd)) {
      return { badge: '📦 npm', severity: 'info' };
    }
  }
  return null;
}

/** Pull the bash command (for Bash / run_terminal_command tools) so the
 * collapsed summary can show what's being run without expanding the card. */
function commandPreview(tool: ToolCall): string | null {
  if (tool.title !== 'Bash' && tool.title !== 'run_terminal_command' && tool.title !== 'execute_bash') {
    return null;
  }
  const raw = tool.rawInput as { command?: string; cmd?: string } | undefined;
  const cmd = (raw?.command ?? raw?.cmd ?? '').trim();
  if (!cmd) return null;
  // Single-line preview — the full command is visible in the expanded body.
  const oneLine = cmd.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
}

export function ToolCard({ tool }: { tool: ToolCall }) {
  const blocks = tool.content ?? [];
  const diffs = blocks.filter((b): b is Extract<ContentBlock, { type: 'diff' }> => b.type === 'diff');
  const resultText = blocks
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
  const loc = tool.locations?.[0];
  const tag = classifyTool(tool);
  const cmdPreview = commandPreview(tool);

  // Auto-expand cards that carry diffs (the user almost always wants to
  // review the change) and cards flagged as warn-level (git push, rm -rf).
  const defaultOpen = diffs.length > 0 || tag?.severity === 'warn';

  return (
    <details
      className={`tool tool-${tool.status} tool-kind-${tool.kind ?? 'other'}${tag ? ` tool-tagged tool-${tag.severity}` : ''}`}
      open={defaultOpen}
    >
      <summary>
        <span className="tool-status">{STATUS_ICON[tool.status] ?? '·'}</span>
        <span className="tool-title">{tool.title}</span>
        {tag && (
          <span className={`tool-tag tool-tag-${tag.severity}`} title={`Highlighted operation: ${tag.badge}`}>
            {tag.badge}
          </span>
        )}
        {cmdPreview && <span className="tool-cmd-preview" title={cmdPreview}>{cmdPreview}</span>}
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
