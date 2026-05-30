import { useEffect, useRef, useState } from 'react';

interface SlashCommand {
  name: string;
  description?: string;
}

interface FileSuggestion {
  path: string;
  label?: string;
}

interface Props {
  busy: boolean;
  commands: SlashCommand[];
  fileSuggestions?: FileSuggestion[];
  onSend: (text: string) => void;
  onCancel: () => void;
  onRequestFileSuggestions?: (query: string) => void;
}

export function Composer({
  busy,
  commands,
  fileSuggestions = [],
  onSend,
  onCancel,
  onRequestFileSuggestions
}: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Show matching slash commands when the input is a bare "/command" prefix.
  const slashMatch = /^\/(\S*)$/.exec(text);
  const slashSuggestions =
    slashMatch && commands.length
      ? commands.filter((c) => c.name.startsWith(slashMatch[1]))
      : [];

  // @-mention file suggestions (triggered when @word at end of input)
  const atMatch = /@(\S*)$/.exec(text);
  const atQuery = atMatch ? atMatch[1] : '';
  // Request suggestions from host when the @ query changes
  useEffect(() => {
    if (atQuery !== undefined && onRequestFileSuggestions) {
      onRequestFileSuggestions(atQuery);
    }
  }, [atQuery, onRequestFileSuggestions]);

  // Filter client-side as fallback; host ideally already filters
  const atSuggestions = atMatch
    ? fileSuggestions.filter((f) =>
        (f.label || f.path).toLowerCase().includes(atQuery.toLowerCase())
      )
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
      {slashSuggestions.length > 0 && (
        <div className="slash-menu">
          {slashSuggestions.map((c) => (
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

      {atSuggestions.length > 0 && (
        <div className="at-menu">
          {atSuggestions.slice(0, 12).map((f, idx) => {
            const display = f.label || f.path;
            return (
              <div
                key={idx}
                className="at-item"
                onClick={() => {
                  // Replace the @partial with @fullpath (relative)
                  const before = text.slice(0, atMatch!.index);
                  const after = text.slice(atMatch!.index! + atMatch![0].length);
                  const insert = `@${f.path} `;
                  setText(before + insert + after);
                  // move cursor after insert on next tick
                  setTimeout(() => {
                    if (ref.current) {
                      const pos = (before + insert).length;
                      ref.current.focus();
                      ref.current.setSelectionRange(pos, pos);
                    }
                  }, 0);
                }}
              >
                <span className="at-icon">📄</span>
                <span className="at-path">{display}</span>
              </div>
            );
          })}
          {fileSuggestions.length > 12 && (
            <div className="at-item at-more">… more files (type to filter)</div>
          )}
        </div>
      )}

      <textarea
        ref={ref}
        value={text}
        placeholder="Ask the agent to build something…  (Enter to send, Shift+Enter for newline; @file for context)"
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
