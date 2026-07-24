// Shared tool-call preview helpers, used by BOTH the timeline ToolCard and
// the PermissionPrompt so the approval gate shows exactly the same command
// text / destructive badges as the timeline (one implementation, no drift).
import type { ToolCall } from '../../src/shared/acpTypes';

const EXECUTE_TOOLS = new Set(['Bash', 'run_terminal_command', 'execute_bash']);

/** Detect noteworthy operations the user typically wants highlighted —
 * primarily git commits / pushes (irreversible, often unintended) but also
 * any bash invocation that names a destructive verb.
 * Returns a small badge label or null. */
export function classifyTool(tool: ToolCall): { badge: string; severity: 'info' | 'warn' } | null {
  const cmd = (rawCommand(tool) ?? '').toLowerCase();
  if (EXECUTE_TOOLS.has(tool.title)) {
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

/** The verbatim command string for execute-kind tools, or null when the
 * payload doesn't carry one (adapter stripped rawInput, non-bash tool). */
export function rawCommand(tool: ToolCall): string | null {
  if (!EXECUTE_TOOLS.has(tool.title) && tool.kind !== 'execute') return null;
  const raw = tool.rawInput as { command?: string; cmd?: string } | undefined;
  const cmd = typeof raw?.command === 'string' ? raw.command : typeof raw?.cmd === 'string' ? raw.cmd : '';
  const trimmed = cmd.trim();
  return trimmed ? trimmed : null;
}

/** Pull the bash command so a collapsed summary can show what's being run
 * without expanding the card. Single-line, 80-char capped. */
export function commandPreview(tool: ToolCall): string | null {
  if (!EXECUTE_TOOLS.has(tool.title)) return null;
  const cmd = rawCommand(tool);
  if (!cmd) return null;
  // Single-line preview — the full command is visible in the expanded body.
  const oneLine = cmd.replace(/\s+/g, ' ');
  return oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine;
}

/** Cap multi-KB payloads before they hit the DOM. Rendering stays
 * text-nodes-only (sanitizer-safe); this only bounds the size. */
export function capText(text: string, max = 4096): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n… [truncated — ' + (text.length - max) + ' more chars]';
}
