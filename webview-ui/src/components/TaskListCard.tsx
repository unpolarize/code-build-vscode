import type { TaskEntry } from '../store';

interface Props {
  tasks: TaskEntry[];
}

/**
 * Render a TodoWrite-style task list snapshot. Read-only from the user's
 * side — the agent owns updates. Each task shows its current status with
 * a checkbox-like glyph and uses `activeForm` (continuous tense, e.g.
 * "Running tests") when the task is in_progress so the live status reads
 * naturally; otherwise shows `content` (imperative).
 */
export function TaskListCard({ tasks }: Props) {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === 'completed').length;
  return (
    <div className="msg msg-tasks">
      <div className="msg-role">
        Tasks · {done}/{tasks.length}
      </div>
      <ol className="task-list">
        {tasks.map((t, i) => (
          <li key={i} className={`task task-${t.status}`}>
            <span className="task-marker" aria-hidden>
              {glyph(t.status)}
            </span>
            <span className="task-text">
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function glyph(status: TaskEntry['status']): string {
  switch (status) {
    case 'completed': return '✓';
    case 'in_progress': return '◐';
    case 'cancelled': return '✕';
    default: return '○';
  }
}
