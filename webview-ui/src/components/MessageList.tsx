import { useEffect, useRef } from 'react';
import type { ChatItem } from '../store';
import { ToolCard } from './ToolCard';

interface Props {
  items: ChatItem[];
}

export function MessageList({ items }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  return (
    <div className="messages">
      {items.length === 0 && (
        <div className="empty">
          <h3>Code Build</h3>
          <p>One chat, many agents — Claude, Grok, Codex, and any ACP CLI.</p>
        </div>
      )}
      {items.map((item) => (
        <Item key={item.id} item={item} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="msg-role">You</div>
          <div className="msg-body">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="msg-role">Agent</div>
          <div className="msg-body">{item.text}</div>
        </div>
      );
    case 'thought':
      return (
        <details className="msg msg-thought">
          <summary>Thinking…</summary>
          <div className="msg-body">{item.text}</div>
        </details>
      );
    case 'tool':
      return <ToolCard tool={item.tool} />;
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
    default:
      return null;
  }
}
