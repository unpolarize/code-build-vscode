import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../store';

interface Props {
  items: ChatItem[];
}

/** Floating navigator that lets the user jump between their own messages in
 * a long conversation. Useful for code-review-style sessions where you ask
 * many questions and want to scroll back to a specific prompt.
 *
 * - ↑ / ↓ buttons step to the previous/next user message in the visible list.
 * - Alt+ArrowUp / Alt+ArrowDown bind the same actions at the document level
 *   so the user doesn't have to mouse over.
 * - A ☰ button toggles a dropdown listing every user message with its text
 *   preview; clicking jumps directly to that message.
 *
 * The component finds messages by `data-msg-id` on each user-message DOM
 * node (set by MessageList.tsx). We rely on the DOM rather than fed-through
 * refs because items are reordered on every reduce() and refs would churn.
 */
export function MessageNav({ items }: Props) {
  const userItems = items.filter((it) => it.kind === 'user');
  const [openList, setOpenList] = useState(false);
  // Track the message the user last navigated to so prev/next have a frame
  // of reference; starts at the latest user message so ↑ jumps to the one
  // before the current prompt.
  const [currentIdx, setCurrentIdx] = useState(userItems.length - 1);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-anchor on new user messages so the indicator stays in sync as the
  // conversation grows. We only auto-bump to the latest if the user was
  // already there — preserves a deliberate scroll-back.
  useEffect(() => {
    setCurrentIdx((idx) => {
      const lastReal = userItems.length - 1;
      if (lastReal < 0) return -1;
      if (idx < 0 || idx === lastReal - 1) return lastReal;
      if (idx > lastReal) return lastReal;
      return idx;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userItems.length]);

  function scrollTo(idx: number) {
    const target = userItems[idx];
    if (!target) return;
    const el = document.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(target.id)}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Visual ping so the user can find it in a wall of text.
      el.classList.add('msg-highlight');
      setTimeout(() => el.classList.remove('msg-highlight'), 1200);
    }
  }

  function prev() {
    if (userItems.length === 0) return;
    const next = Math.max(0, currentIdx - 1);
    setCurrentIdx(next);
    scrollTo(next);
  }
  function next() {
    if (userItems.length === 0) return;
    const n = Math.min(userItems.length - 1, currentIdx + 1);
    setCurrentIdx(n);
    scrollTo(n);
  }

  // Document-level keyboard shortcuts. We scope them with Alt+Arrow because
  // plain Arrow keys are used inside the composer textarea, and Cmd+Arrow
  // is already a tab-navigation gesture in VS Code.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userItems.length, currentIdx]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!openList) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenList(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [openList]);

  // Hide when there's nothing to navigate (no point showing "0 / 0").
  if (userItems.length === 0) return null;

  return (
    <div className="msg-nav" ref={wrapRef}>
      <button
        className="msg-nav-btn"
        onClick={prev}
        disabled={currentIdx <= 0}
        title="Previous user message (Alt+↑)"
        aria-label="Previous message"
      >
        ↑
      </button>
      <button
        className="msg-nav-btn msg-nav-count"
        onClick={() => setOpenList((v) => !v)}
        title="Jump to message"
        aria-label="Jump to message"
      >
        {currentIdx + 1} / {userItems.length}
      </button>
      <button
        className="msg-nav-btn"
        onClick={next}
        disabled={currentIdx >= userItems.length - 1}
        title="Next user message (Alt+↓)"
        aria-label="Next message"
      >
        ↓
      </button>

      {openList && (
        <div className="msg-nav-list">
          {userItems.map((it, idx) => {
            const preview = (it.kind === 'user' ? it.text : '').replace(/\s+/g, ' ').slice(0, 80);
            return (
              <div
                key={it.id}
                className={`msg-nav-item${idx === currentIdx ? ' msg-nav-item-current' : ''}`}
                onClick={() => {
                  setCurrentIdx(idx);
                  scrollTo(idx);
                  setOpenList(false);
                }}
                title={preview}
              >
                <span className="msg-nav-idx">{idx + 1}.</span>
                <span className="msg-nav-text">{preview || '(empty)'}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
