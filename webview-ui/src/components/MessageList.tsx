import { useEffect, useRef } from 'react';
import type { ChatItem } from '../store';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { TaskListCard } from './TaskListCard';
import { post } from '../vscodeApi';

interface Props {
  items: ChatItem[];
  /** True from the moment the user hits Send until the agent's turn ends.
   * Drives the "working…" indicator that fills the spawn→first-token gap. */
  busy?: boolean;
  /** Called when the user clicks an option inside an AskUserQuestion card.
   * Forwarded to App, which posts `askUserAnswer` back to the host. */
  onAskUserAnswer: (toolCallId: string, answers: Record<string, string>) => void;
}

export function MessageList({ items, busy, onAskUserAnswer }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, busy]);

  // Show the working indicator only when we're busy AND the agent hasn't
  // started streaming a response yet (last item is the user's message or a
  // tool call still in flight). Once assistant text starts arriving the
  // streaming text itself is the feedback, so we hide the pill.
  const last = items[items.length - 1];
  const awaitingFirstToken =
    busy === true && (!last || last.kind === 'user' || last.kind === 'tool');

  return (
    <div className="messages">
      {items.length === 0 && !busy && (
        <div className="empty">
          <h3>Code Build</h3>
          <p>One chat, many agents — Claude, Grok, Codex, and any ACP CLI.</p>
        </div>
      )}
      {items.map((item) => (
        <Item key={item.id} item={item} onAskUserAnswer={onAskUserAnswer} />
      ))}
      {awaitingFirstToken && (
        <div className="msg msg-assistant">
          <div className="msg-role">Agent</div>
          <div className="thinking-indicator" aria-label="Agent is working">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-label">working…</span>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Item({
  item,
  onAskUserAnswer
}: {
  item: ChatItem;
  onAskUserAnswer: (toolCallId: string, answers: Record<string, string>) => void;
}) {
  switch (item.kind) {
    case 'user':
      // User messages contain markdown often (the user types `## headers`,
      // `**bold**`, bullet lists, fenced code, etc.) — rendering them as
      // plain text made imported grok/claude session replays look raw and
      // unreadable. Render through the same Markdown pipeline as assistant
      // messages, plus any image attachments. `data-msg-id` lets the
      // MessageNav floating widget jump to the right bubble.
      return (
        <div className="msg msg-user" data-msg-id={item.id}>
          <div className="msg-role">You</div>
          <Markdown className="msg-body" text={item.text} />
          {item.images && item.images.length > 0 && (
            <div className="msg-attachments">
              {item.images.map((img, idx) => (
                <img
                  key={idx}
                  className="msg-attachment"
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name ?? `pasted image ${idx + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="msg-role">Agent</div>
          <Markdown className="msg-body" text={item.text} />
        </div>
      );
    case 'thought':
      return (
        <details className="msg msg-thought">
          <summary>Thinking…</summary>
          <Markdown className="msg-body" text={item.text} />
        </details>
      );
    case 'tool':
      return <ToolCard tool={item.tool} />;
    case 'files':
      return (
        <div className="msg msg-files">
          <div className="msg-role">Modified files ({item.files.length})</div>
          <div className="files-list">
            {item.files.map((f, i) => (
              <div
                key={i}
                className="files-item"
                title={f.path}
                onClick={() => post({ type: 'revealLocation', path: f.path })}
              >
                <span className="files-path">{f.path}</span>
                <span className="files-stat">
                  {f.added > 0 && <span className="files-add">+{f.added}</span>}
                  {f.removed > 0 && <span className="files-del">-{f.removed}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    case 'plan':
      return (
        <div className="msg msg-plan">
          <div className="msg-role">Plan</div>
          <ol>
            {item.entries.map((e, i) => (
              <li key={i} className={`plan-${e.status}`}>
                {e.content}
              </li>
            ))}
          </ol>
        </div>
      );
    case 'error':
      return (
        <div className="msg msg-error">
          <div className="msg-role">Error</div>
          <div className="msg-body">{item.text}</div>
        </div>
      );
    case 'askUser':
      return (
        <AskUserQuestionCard
          toolCallId={item.toolCallId}
          questions={item.questions}
          answers={item.answers}
          onAnswer={onAskUserAnswer}
        />
      );
    case 'tasks':
      return <TaskListCard tasks={item.tasks} />;
    default:
      return null;
  }
}
