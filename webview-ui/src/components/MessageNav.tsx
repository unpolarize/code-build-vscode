import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../store';
import {
  childOffsetInScroller,
  clampTurnIndex,
  findMessagesScroller,
  stepUserTurn,
  userMessageTops,
  visibleUserTurnIndex
} from '../util/messageNav';

interface Props {
  items: ChatItem[];
  /** True while the transcript is pinned to the live tail. */
  follow?: boolean;
  /** idx of the user turn navigated to; isLast when that turn is the latest. */
  onNavigate?: (idx: number, isLast: boolean) => void;
  onJumpLatest?: () => void;
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
 * - **latest** jumps to the live tail and the counter follows (N/N).
 *
 * The counter is a scroll-spy of the transcript: manual scrolling updates
 * `currentIdx` to the user turn at the top of the pane, so ↑/↓ always step
 * from what is on screen rather than a stale click index.
 *
 * The component finds messages by `data-msg-id` on each user-message DOM
 * node (set by MessageList.tsx). We rely on the DOM rather than fed-through
 * refs because items are reordered on every reduce() and refs would churn.
 */
export function MessageNav({ items, follow, onNavigate, onJumpLatest }: Props) {
  const userItems = items.filter((it) => it.kind === 'user');
  const [openList, setOpenList] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(userItems.length - 1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const userItemsRef = useRef(userItems);
  userItemsRef.current = userItems;
  const followRef = useRef(follow);
  followRef.current = follow;
  const idxRef = useRef(currentIdx);
  idxRef.current = currentIdx;
  const navLock = useRef(false);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onJumpLatestRef = useRef(onJumpLatest);
  onJumpLatestRef.current = onJumpLatest;

  function setIdx(idx: number) {
    idxRef.current = idx;
    setCurrentIdx(idx);
  }

  function lockNav(scroller: HTMLElement | null, ms = 200) {
    navLock.current = true;
    const unlock = () => {
      navLock.current = false;
    };
    if (scroller) scroller.addEventListener('scrollend', unlock, { once: true });
    window.setTimeout(unlock, ms);
  }

  function visibleIdx(scroller: HTMLElement | null): number {
    const users = userItemsRef.current;
    if (users.length === 0) return -1;
    if (followRef.current) return users.length - 1;
    if (!scroller) return clampTurnIndex(idxRef.current, users.length);
    const tops = userMessageTops(
      scroller,
      users.map((u) => u.id)
    );
    return visibleUserTurnIndex({
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      userTops: tops
    });
  }

  // Keep the counter in lockstep with the scroller. Programmatic jumps set
  // navLock so a mid-animation scroll doesn't flicker the number backwards.
  useEffect(() => {
    const scroller = findMessagesScroller();
    if (!scroller) return;

    const sync = () => {
      if (navLock.current) return;
      const idx = visibleIdx(scroller);
      if (idx >= 0 && idx !== idxRef.current) setIdx(idx);
    };

    scroller.addEventListener('scroll', sync, { passive: true });
    sync();
    return () => scroller.removeEventListener('scroll', sync);
    // Re-bind when the conversation length changes so a newly mounted
    // scroller (session switch) is picked up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userItems.length]);

  // Follow-the-tail pins the counter to N/N. Also clamps after a shorter
  // session is loaded into the same panel.
  useEffect(() => {
    const lastReal = userItems.length - 1;
    if (lastReal < 0) {
      setIdx(-1);
      return;
    }
    if (follow) {
      setIdx(lastReal);
      return;
    }
    setCurrentIdx((idx) => {
      const next = clampTurnIndex(idx, userItems.length);
      idxRef.current = next;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userItems.length, follow]);

  function scrollTo(idx: number) {
    const users = userItemsRef.current;
    const target = users[idx];
    if (!target) return;
    const scroller = findMessagesScroller();
    const el = scroller?.querySelector<HTMLElement>(
      `[data-msg-id="${cssEscape(target.id)}"]`
    );
    setIdx(idx);
    if (scroller && el) {
      lockNav(scroller);
      // Instant scroll on the transcript pane only — scrollIntoView was
      // racing follow-the-bottom (smooth + ancestor scrollports).
      scroller.scrollTo({ top: childOffsetInScroller(scroller, el), behavior: 'auto' });
      el.classList.add('msg-highlight');
      window.setTimeout(() => el.classList.remove('msg-highlight'), 1200);
    }
    onNavigateRef.current?.(idx, idx === users.length - 1);
  }

  function prev() {
    const users = userItemsRef.current;
    if (users.length === 0) return;
    const from = visibleIdx(findMessagesScroller());
    const next = stepUserTurn(from, -1, users.length);
    if (next === from && next === 0) {
      setIdx(0);
      return;
    }
    scrollTo(next);
  }

  function next() {
    const users = userItemsRef.current;
    if (users.length === 0) return;
    const from = visibleIdx(findMessagesScroller());
    const n = stepUserTurn(from, 1, users.length);
    if (n === from && n === users.length - 1) {
      setIdx(n);
      return;
    }
    scrollTo(n);
  }

  function jumpLatest() {
    const last = userItemsRef.current.length - 1;
    if (last < 0) return;
    const scroller = findMessagesScroller();
    lockNav(scroller, 1000);
    setIdx(last);
    onJumpLatestRef.current?.();
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
    // prev/next read refs, so this listener is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const atFirst = currentIdx <= 0;
  const atLast = currentIdx >= userItems.length - 1;

  return (
    <div className="msg-nav" ref={wrapRef}>
      <button
        className="msg-nav-btn"
        onClick={prev}
        disabled={atFirst}
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
        disabled={atLast}
        title="Next user message (Alt+↓)"
        aria-label="Next message"
      >
        ↓
      </button>
      {follow === false && onJumpLatest && (
        <button
          className="msg-nav-btn msg-nav-latest"
          onClick={jumpLatest}
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          latest
        </button>
      )}

      {openList && (
        <div className="msg-nav-list">
          {userItems.map((it, idx) => {
            const preview = (it.kind === 'user' ? it.text : '').replace(/\s+/g, ' ').slice(0, 80);
            return (
              <div
                key={it.id}
                className={`msg-nav-item${idx === currentIdx ? ' msg-nav-item-current' : ''}`}
                onClick={() => {
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

function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
