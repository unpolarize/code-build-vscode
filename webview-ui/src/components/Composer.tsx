import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '../store';
import { findActiveMention } from '../util/mentions';
import { post } from '../vscodeApi';

/** A file resolved by the host from a drag-and-drop onto the chat. */
interface DroppedItem {
  path: string;
  isImage: boolean;
  mimeType?: string;
  data?: string;
  name?: string;
}

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
  const [caret, setCaret] = useState(0);
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

  // @-mention file suggestions. Caret-aware: the menu fires for an @-token at
  // the cursor, not only when it sits at the very end of the input — so editing
  // mid-text still triggers search (the old /@(\S*)$/ silently did nothing).
  // Debounced + de-duplicated to avoid spawning a `workspace.findFiles` (and
  // thus a ripgrep subprocess) on every keystroke. A bare `@` (empty query) is
  // allowed now: the host answers with recently-used files instead of nothing.
  const mention = findActiveMention(text, caret);
  const atQuery = mention ? mention.query : null;
  const lastSentQuery = useRef<string | null>(null);
  useEffect(() => {
    if (atQuery === null) {
      // Reset so the next "@" fires a fresh request even if the previous
      // query was the same string before we left at-mention mode.
      lastSentQuery.current = null;
      return;
    }
    if (!onRequestFileSuggestions) return;
    // Drop the no-op case where the user re-rendered for an unrelated
    // reason (App passes a new `onRequestFileSuggestions` reference on
    // every render — unstable; the useEffect would otherwise re-fire
    // even when atQuery hadn't changed).
    if (lastSentQuery.current === atQuery) return;
    const handle = window.setTimeout(() => {
      lastSentQuery.current = atQuery;
      onRequestFileSuggestions(atQuery);
    }, 200);
    return () => window.clearTimeout(handle);
  }, [atQuery, onRequestFileSuggestions]);

  // Filter client-side as fallback; host ideally already filters
  const atSuggestions = mention
    ? fileSuggestions.filter((f) =>
        (f.label || f.path).toLowerCase().includes(mention.query.toLowerCase())
      )
    : [];

  /** Insert text at the current caret, replacing the active @-token span (from
   * the `@` through the end of the token, which may extend past the caret). */
  function replaceMentionWith(insert: string) {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    let tokenEnd = caret;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) tokenEnd++;
    const after = text.slice(tokenEnd);
    const next = before + insert + after;
    const pos = (before + insert).length;
    setText(next);
    setCaret(pos);
    setTimeout(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(pos, pos);
      }
    }, 0);
  }

  /** Apply files the host resolved from a drop: images become tiles, other
   * files are inserted as `@path` mentions at the caret. */
  const applyRef = useRef<(items: DroppedItem[]) => void>(() => {});
  applyRef.current = (items: DroppedItem[]) => {
    const paths: string[] = [];
    for (const it of items) {
      if (it.isImage && it.data) {
        setImages((cur) => [
          ...cur,
          { mimeType: it.mimeType || 'image/png', data: it.data!, name: it.name }
        ]);
      } else {
        paths.push(it.path);
      }
    }
    if (paths.length === 0) return;
    const insert = paths.map((p) => `@${p}`).join(' ') + ' ';
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    const pos = (before + insert).length;
    setText(before + insert + after);
    setCaret(pos);
    setTimeout(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(pos, pos);
      }
    }, 0);
  };

  // The host replies to a drop with `droppedFilesResolved`. App's store ignores
  // unknown host messages, so a dedicated listener here keeps drop state local.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const m = e.data;
      if (m && m.type === 'droppedFilesResolved') {
        applyRef.current((m.items ?? []) as DroppedItem[]);
      }
    }
    // App-level drop forwards image files via a CustomEvent so we don't
    // duplicate the FileReader→base64 pipeline up there. App handles
    // workspace-path URIs directly (posts `resolveDroppedUris`); only
    // raw image bytes need to flow through this composer-local path.
    function onAppDropFiles(ev: Event) {
      const files = (ev as CustomEvent<File[]>).detail ?? [];
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== 'string') return;
          const comma = result.indexOf(',');
          const data = comma >= 0 ? result.slice(comma + 1) : result;
          setImages((current) => [
            ...current,
            { mimeType: file.type || 'image/png', data, name: file.name || `dropped-${current.length + 1}` }
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
    window.addEventListener('message', onMsg);
    window.addEventListener('cb-app-drop-files', onAppDropFiles as EventListener);
    return () => {
      window.removeEventListener('message', onMsg);
      window.removeEventListener('cb-app-drop-files', onAppDropFiles as EventListener);
    };
  }, []);

  function submit() {
    const t = text.trim();
    // Allow image-only messages (some agents accept "look at this screenshot"
    // with no accompanying text) but require something — either text or at
    // least one image — to avoid empty sends.
    if (!t && images.length === 0) return;
    onSend(t, images);
    setText('');
    setImages([]);
    setCaret(0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  /** Keep `caret` in sync so the @-mention detector knows where the cursor is.
   * Reads from the textarea after the browser has applied the selection. */
  function syncCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
  }

  // Drop handling moved to App.tsx so drops anywhere in the chat
  // panel (not just the composer strip) become @-mentions. App posts
  // `resolveDroppedUris` to the host; the host's reply
  // `droppedFilesResolved` is caught by the message listener above
  // and applied via applyRef → @path inserts. Raw image files come
  // back via the `cb-app-drop-files` CustomEvent the listener above
  // also subscribes to.

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
                  // Insert the FULL workspace-relative path (not just the
                  // filename), replacing the active @-token at the caret.
                  replaceMentionWith(`@${f.path} `);
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
        placeholder="Ask the agent to build something…  (Enter to send, Shift+Enter for newline; @file for context, drag files in, paste images)"
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
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
