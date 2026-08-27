/** Transcript turn-nav helpers. Pure enough to unit-test without jsdom. */

/** Attribute on the `.messages` scroller so nav can find it without a ref. */
export const SCROLLER_ATTR = 'data-cb-scroller';

export const DEFAULT_SLOP_PX = 64;
/** Viewport Y used as the "which turn am I reading" line (from the scroller top). */
export const DEFAULT_READ_LINE_PX = 48;

export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slopPx = DEFAULT_SLOP_PX
): boolean {
  return scrollHeight - scrollTop - clientHeight <= slopPx;
}

/**
 * Index of the user turn currently in view.
 *
 * A turn owns the viewport from its prompt top until the next prompt top.
 * Sitting on the live tail (near the bottom) always reports the last turn so
 * the `N/N` counter matches follow-the-bottom.
 */
export function visibleUserTurnIndex(opts: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Prompt offset from the scroller content origin (same units as scrollTop). */
  userTops: number[];
  slopPx?: number;
  readLinePx?: number;
}): number {
  const {
    scrollTop,
    clientHeight,
    scrollHeight,
    userTops,
    slopPx = DEFAULT_SLOP_PX,
    readLinePx = DEFAULT_READ_LINE_PX
  } = opts;
  if (userTops.length === 0) return -1;
  const last = userTops.length - 1;
  if (isNearBottom(scrollTop, clientHeight, scrollHeight, slopPx)) return last;
  const readLine = scrollTop + readLinePx;
  let idx = 0;
  for (let i = 0; i < userTops.length; i++) {
    if (userTops[i] <= readLine) idx = i;
    else break;
  }
  return idx;
}

export function clampTurnIndex(idx: number, count: number): number {
  if (count <= 0) return -1;
  if (idx < 0) return 0;
  if (idx > count - 1) return count - 1;
  return idx;
}

export function stepUserTurn(from: number, dir: -1 | 1, count: number): number {
  if (count <= 0) return -1;
  const base = clampTurnIndex(from, count);
  return clampTurnIndex(base + dir, count);
}

/** Content-origin Y of `child` inside `scroller` (works with nested offsetParents). */
export function childOffsetInScroller(scroller: HTMLElement, child: HTMLElement): number {
  const childRect = child.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  return scroller.scrollTop + (childRect.top - scrollerRect.top);
}

export function userMessageTops(scroller: HTMLElement, ids: string[]): number[] {
  const scRect = scroller.getBoundingClientRect();
  return ids.map((id) => {
    const el = scroller.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(id)}"]`);
    if (!el) return Number.POSITIVE_INFINITY;
    return scroller.scrollTop + (el.getBoundingClientRect().top - scRect.top);
  });
}

export function findMessagesScroller(root: ParentNode | null | undefined = document): HTMLElement | null {
  if (!root) return null;
  return root.querySelector<HTMLElement>(`[${SCROLLER_ATTR}]`);
}

function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(id);
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
