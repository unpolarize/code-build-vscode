import { useEffect, useRef, useState } from 'react';

interface SlashCommand {
  name: string;
  description?: string;
}

interface Props {
  busy: boolean;
  commands: SlashCommand[];
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function Composer({ busy, commands, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Show matching slash commands when the input is a bare "/command" prefix.
  const slashMatch = /^\/(\S*)$/.exec(text);
  const suggestions =
    slashMatch && commands.length
      ? commands.filter((c) => c.name.startsWith(slashMatch[1]))
      : [];

  function submit() {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="slash-menu">
          {suggestions.map((c) => (
            <div
              key={c.name}
              className="slash-item"
              onClick={() => {
                setText(`/${c.name} `);
                ref.current?.focus();
              }}
            >
              <span className="slash-name">/{c.name}</span>
              {c.description && <span className="slash-desc">{c.description}</span>}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        placeholder="Ask the agent to build something…  (Enter to send, Shift+Enter for newline)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={3}
      />
      <div className="composer-actions">
        {busy ? (
          <button className="btn btn-cancel" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button className="btn btn-send" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
