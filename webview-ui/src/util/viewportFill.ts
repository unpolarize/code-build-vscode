/**
 * Viewport-fill (Metafizzy Infinite Scroll `prefill`): when restore paints a
 * tail shorter than the scroller, there is no overflow, so the scroll-up
 * pager never fires. Decide whether to auto-request another older page.
 *
 * Host paging (`REPLAY_TAIL_*`, `pageWindow`, `keepLastCompleteTurns`) is
 * unchanged — this is a webview-only loop.
 */

export const VIEWPORT_FILL_MAX_PAGES = 6;
/** Slack so a barely-overflowing tail still fills once (matches the
 * scroll-up threshold in MessageList). */
export const VIEWPORT_FILL_MARGIN_PX = 96;

export interface ViewportFillInput {
  scrollHeight: number;
  clientHeight: number;
  hasOlder: boolean;
  olderLoading: boolean;
  pagesAutoLoaded: number;
  /** User still following the live tail. Fill aborts if false. */
  follow: boolean;
  /** Last auto-fill page landed with no new items (request-storm guard). */
  stalled: boolean;
  maxPages?: number;
  marginPx?: number;
}

export function needsViewportFill(input: ViewportFillInput): boolean {
  const maxPages = input.maxPages ?? VIEWPORT_FILL_MAX_PAGES;
  const margin = input.marginPx ?? VIEWPORT_FILL_MARGIN_PX;
  if (!input.hasOlder) return false;
  if (input.olderLoading) return false;
  if (!input.follow) return false;
  if (input.stalled) return false;
  if (input.pagesAutoLoaded >= maxPages) return false;
  // Hidden / pre-layout panel: ResizeObserver re-arms when height > 0.
  if (input.clientHeight <= 0) return false;
  if (input.scrollHeight > input.clientHeight + margin) return false;
  return true;
}

/** Top-of-list chip: always shown while `hasOlder`. Cap-hit switches the copy
 * so paging stays discoverable after auto-fill stops. */
export function viewportFillAffordanceLabel(
  pagesAutoLoaded: number,
  maxPages = VIEWPORT_FILL_MAX_PAGES
): string {
  return pagesAutoLoaded >= maxPages
    ? 'Load earlier…'
    : '· · · older turns — scroll up ·';
}

/** Fill prepends must pin to the tail only while the user is still following.
 * If they scrolled away mid-flight, restore the prepend anchor instead. */
export function shouldPinFillToTail(fillPending: boolean, follow: boolean): boolean {
  return fillPending && follow;
}
