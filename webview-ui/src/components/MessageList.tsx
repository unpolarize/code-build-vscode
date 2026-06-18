import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../store';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { TaskListCard } from './TaskListCard';
import { post } from '../vscodeApi';
import { formatRelative, formatHover } from '../util/time';

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

/** Small live-updating relative-time chip rendered next to each message
 * role label. Refreshes every 30s so "just now" → "1m ago" without
 * waiting for the next render trigger. Hover tooltip carries the
 * absolute ISO timestamp(s). */
function TimeChip({ createdAt, updatedAt }: { createdAt: number; updatedAt?: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="msg-time" title={formatHover(createdAt, updatedAt)} dateTime={new Date(createdAt).toISOString()}>
      {formatRelative(createdAt)}
    </time>
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
      // MessageNav floating widget jump to the right bubble. The
      // `interjected` flag marks mid-turn steers — a small badge in the
      // role line so the user can see where they intervened.
      return (
        <div className={`msg msg-user${item.interjected ? ' msg-user-interjected' : ''}`} data-msg-id={item.id}>
          <div className="msg-role">
            You
            {item.interjected && <span className="msg-interjected-badge">↗ mid-turn</span>}
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
            {item.labels && item.labels.length > 0 && (
              <span className="msg-labels">
                {item.labels.map((l, i) => (
                  <span key={i} className="msg-label-chip" title={`Classifier label: ${l}`}>{l}</span>
                ))}
              </span>
            )}
          </div>
          <Markdown className="msg-body" text={item.text} />
          {item.images && item.images.length > 0 && (
            <div className="msg-attachments">
              {item.images.map((img, idx) => (
                <ImageAttachmentTile key={idx} image={img} index={idx} />
              ))}
            </div>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="msg-role">
            Agent
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </div>
          <Markdown className="msg-body" text={item.text} />
        </div>
      );
    case 'thought': {
      const firstLine =
        item.text
          .split('\n')
          .find((l) => l.trim().length > 0)
          ?.trim() ?? '';
      const preview = firstLine.length > 70 ? firstLine.slice(0, 70) + '…' : firstLine;
      return (
        <details className="msg msg-thought">
          <summary>
            Thinking…{' '}
            {preview && <span className="msg-thought-preview">— {preview}</span>}
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </summary>
          <Markdown className="msg-body" text={item.text} />
        </details>
      );
    }
    case 'tool':
      return <ToolCard tool={item.tool} />;
    case 'files':
      return (
        <div className="msg msg-files">
          <div className="msg-role">
            Modified files ({item.files.length})
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </div>
          <div className="files-list">
            {item.files.map((f, i) => (
              <div key={i} className="files-item" title={f.path}>
                <span
                  className="files-path"
                  onClick={() => post({ type: 'revealLocation', path: f.path })}
                >
                  {f.path}
                </span>
                <span className="files-stat">
                  {f.added > 0 && <span className="files-add">+{f.added}</span>}
                  {f.removed > 0 && <span className="files-del">-{f.removed}</span>}
                </span>
                {/* "Open diff" affordance — launches VS Code's
                    side-by-side diff view via EditorTools.openDiff.
                    Only shown when we captured both halves of the
                    diff from the tool's content block; rawInput-only
                    fallbacks don't have the before-text so the
                    button is hidden. */}
                {f.oldText != null && f.newText != null && (
                  <button
                    className="files-diff-btn"
                    title="Open side-by-side diff"
                    onClick={(e) => {
                      e.stopPropagation();
                      post({
                        type: 'openDiff',
                        path: f.path,
                        oldText: f.oldText ?? '',
                        newText: f.newText ?? ''
                      });
                    }}
                  >
                    diff
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    case 'plan':
      return (
        <div className="msg msg-plan">
          <div className="msg-role">
            Plan
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </div>
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
          <div className="msg-role">
            Error
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </div>
          <div className="msg-body">{item.text}</div>
        </div>
      );
    case 'notice':
      return (
        // `title` lets the user hover anywhere on the bubble to see the
        // resolved spawn command, cwd, and resume id — the diagnostic
        // info that explains a "Starting … agent" line that hasn't
        // moved in 60 seconds. The role label is also `title`d so the
        // tooltip shows even when hovering the small "Notice" tag.
        <div className="msg msg-notice" title={item.detail}>
          <div className="msg-role" title={item.detail}>
            Notice
            <TimeChip createdAt={item.createdAt} updatedAt={item.updatedAt} />
          </div>
          <Markdown className="msg-body" text={item.text} />
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
    case 'context':
      return <ContextCard origin={item.origin} summary={item.summary} sections={item.sections} />;
    default:
      return null;
  }
}

/** Collapsible audit card showing exactly what the host injected into
 * the agent's stdin on a given turn — the carry-over primer, resolved
 * @-mention paths, raw user text, and tool_result payloads. The
 * collapsed summary line names section kinds + sizes so the user can
 * scan without expanding; each section expands independently so a 12K
 * primer doesn't drown out a 2-character user prompt. */
function ContextCard({
  origin,
  summary,
  sections
}: {
  origin: 'prompt' | 'tool_result' | 'system';
  summary: string;
  sections: Array<{ label: string; body: string; chars: number; kind?: string }>;
}) {
  const originLabel =
    origin === 'prompt' ? 'Injected into agent' :
    origin === 'tool_result' ? 'Tool result returned' :
    'System context';
  return (
    <details className="msg msg-context">
      <summary className="msg-context-summary">
        <span className="msg-context-eyebrow">{originLabel}</span>
        <span className="msg-context-summary-text">{summary}</span>
      </summary>
      <div className="msg-context-body">
        {sections.map((s, i) => (
          <details key={i} className={`msg-context-section msg-context-${s.kind ?? 'other'}`}>
            <summary>{s.label}</summary>
            <pre className="msg-context-section-body">{s.body}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

/** Image attachment tile rendered inside a user message bubble.
 *
 * Click → opens a centred lightbox overlay with the full-resolution image.
 * Each tile also exposes hover-revealed buttons to copy the image to the
 * system clipboard (PNG bytes when ClipboardItem is supported, base64
 * data-URL fallback otherwise) and to save the image to disk via the host. */
import type { ImageAttachment } from '../store';

function ImageAttachmentTile({ image, index }: { image: ImageAttachment; index: number }) {
  const [showLightbox, setShowLightbox] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const dataUrl = `data:${image.mimeType};base64,${image.data}`;

  async function copyImage() {
    try {
      // Preferred path: native ClipboardItem with the actual binary bytes
      // so paste targets (Slack, Notes, design tools) get a real image.
      // Fall back to copying the data URL as text when ClipboardItem isn't
      // available — most native paste targets won't accept it but at least
      // the user can paste it into a markdown source if they need to.
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const binary = atob(image.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: image.mimeType });
        await navigator.clipboard.write([new ClipboardItem({ [image.mimeType]: blob })]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(dataUrl);
      } else {
        throw new Error('Clipboard API not available');
      }
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 1500);
    }
  }

  return (
    <>
      <div className="msg-attachment-wrap" title="Click to view full size">
        <img
          className="msg-attachment"
          src={dataUrl}
          alt={image.name ?? `pasted image ${index + 1}`}
          onClick={() => setShowLightbox(true)}
        />
        <div className="msg-attachment-actions">
          <button
            className="msg-attachment-btn"
            onClick={copyImage}
            title="Copy image to clipboard"
          >
            {copyState === 'copied' ? '✓ Copied' : copyState === 'failed' ? '✕ Failed' : '⧉ Copy'}
          </button>
        </div>
      </div>
      {showLightbox && (
        <div
          className="image-lightbox"
          onClick={() => setShowLightbox(false)}
          role="dialog"
          aria-label="Image viewer"
        >
          <img className="image-lightbox-img" src={dataUrl} alt={image.name ?? ''} />
          <button
            className="image-lightbox-close"
            onClick={(e) => { e.stopPropagation(); setShowLightbox(false); }}
            aria-label="Close"
          >
            ×
          </button>
          <button
            className="image-lightbox-copy"
            onClick={(e) => { e.stopPropagation(); copyImage(); }}
            title="Copy image to clipboard"
          >
            {copyState === 'copied' ? '✓ Copied' : '⧉ Copy'}
          </button>
        </div>
      )}
    </>
  );
}
