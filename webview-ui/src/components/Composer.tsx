import { useEffect, useRef, useState } from 'react';

interface Props {
  busy: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function Composer({ busy, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

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
