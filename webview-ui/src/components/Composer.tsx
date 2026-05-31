import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '../store';

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
  /** Sends text + optional pasted-image attachments. Empty images array
   * means a text-only message — same as before. */
  onSend: (text: string, images: ImageAttachment[]) => void;
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
  const [images, setImages] = useState<ImageAttachment[]>([]);
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
    // Allow image-only messages (some agents accept "look at this screenshot"
    // with no accompanying text) but require something — either text or at
    // least one image — to avoid empty sends.
    if (!t && images.length === 0) return;
    onSend(t, images);
    setText('');
    setImages([]);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /** Cmd/Ctrl-V handler: intercept image clipboard items, convert each to
   * base64, and attach as a tile preview. Multiple images per paste are
   * supported. Text paste behavior is left to the browser default. */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        imageItems.push(it);
      }
    }
    if (imageItems.length === 0) return;

    e.preventDefault(); // stop the browser from also pasting a binary blob string
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return;
        // result is "data:image/png;base64,<...>". Strip the prefix so we
        // ship just the base64 payload (matches the ContentBlock 'image' shape).
        const comma = result.indexOf(',');
        const data = comma >= 0 ? result.slice(comma + 1) : result;
        setImages((current) => [
          ...current,
          { mimeType: file.type || item.type, data, name: file.name || `pasted-${current.length + 1}` }
        ]);
      };
      reader.readAsDataURL(file);
    }
  }

  function removeImage(idx: number) {
    setImages((current) => current.filter((_, i) => i !== idx));
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
            const slash = f.path.lastIndexOf('/');
            const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
            const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
            return (
              <div
                key={idx}
                className="at-item"
                onClick={() => {
                  // Insert the FULL workspace-relative path (not just the filename).
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
                <span className="at-path">
                  <span className="at-base">{base}</span>
                  {dir && <span className="at-dir">{dir}</span>}
                </span>
              </div>
            );
          })}
          {fileSuggestions.length > 12 && (
            <div className="at-item at-more">… more files (type to filter)</div>
          )}
        </div>
      )}

      {images.length > 0 && (
        <div className="composer-attachments">
          {images.map((img, idx) => (
            <div key={idx} className="composer-thumb" title={img.name ?? 'pasted image'}>
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? ''} />
              <button
                className="composer-thumb-remove"
                aria-label="Remove image"
                onClick={() => removeImage(idx)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        value={text}
        placeholder="Ask the agent to build something…  (Enter to send, Shift+Enter for newline; @file for context, paste images)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        rows={3}
      />
      <div className="composer-actions">
        {busy ? (
          <>
            {/* Mid-stream steer: send a new user message while the agent is
              * still generating. Claude's stream-json input format accepts
              * additional `user` lines on stdin; grok's ACP queues the next
              * session/prompt at the protocol level. Either way the
              * intervention is integrated into the agent's response without
              * the user having to wait for the current turn to finish. */}
            <button
              className="btn btn-steer"
              onClick={submit}
              disabled={!text.trim() && images.length === 0}
              title="Send mid-turn — the agent will pick up your steer in its next response"
            >
              ↗ Steer
            </button>
            <button className="btn btn-cancel" onClick={onCancel}>
              Stop
            </button>
          </>
        ) : (
          <button
            className="btn btn-send"
            onClick={submit}
            disabled={!text.trim() && images.length === 0}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
