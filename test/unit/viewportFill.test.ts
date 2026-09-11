import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsViewportFill,
  shouldContinueLoadAll,
  shouldPinFillToTail,
  viewportFillAffordanceLabel,
  VIEWPORT_FILL_MARGIN_PX,
  VIEWPORT_FILL_MAX_PAGES,
  type ViewportFillInput
} from '../../webview-ui/src/util/viewportFill';

const BASE: ViewportFillInput = {
  scrollHeight: 200,
  clientHeight: 800,
  hasOlder: true,
  olderLoading: false,
  pagesAutoLoaded: 0,
  follow: true,
  stalled: false
};

describe('needsViewportFill', () => {
  it('short tail → fill', () => {
    assert.equal(needsViewportFill(BASE), true);
  });

  it('filled (overflow past margin) → stop', () => {
    assert.equal(
      needsViewportFill({
        ...BASE,
        scrollHeight: BASE.clientHeight + VIEWPORT_FILL_MARGIN_PX + 1
      }),
      false
    );
  });

  it('barely overflowing (at or under margin) still fills once', () => {
    assert.equal(
      needsViewportFill({
        ...BASE,
        scrollHeight: BASE.clientHeight + VIEWPORT_FILL_MARGIN_PX
      }),
      true
    );
  });

  it('cap reached → stop', () => {
    assert.equal(
      needsViewportFill({ ...BASE, pagesAutoLoaded: VIEWPORT_FILL_MAX_PAGES }),
      false
    );
    assert.equal(
      needsViewportFill({ ...BASE, pagesAutoLoaded: VIEWPORT_FILL_MAX_PAGES - 1 }),
      true
    );
  });

  it('no-older → stop', () => {
    assert.equal(needsViewportFill({ ...BASE, hasOlder: false }), false);
  });

  it('in-flight older load → stop', () => {
    assert.equal(needsViewportFill({ ...BASE, olderLoading: true }), false);
  });

  it('clientHeight === 0 (hidden / pre-layout) → stop', () => {
    assert.equal(needsViewportFill({ ...BASE, clientHeight: 0 }), false);
  });

  it('follow broken → stop', () => {
    assert.equal(needsViewportFill({ ...BASE, follow: false }), false);
  });

  it('stalled (no item growth) → stop even if hasOlder', () => {
    assert.equal(needsViewportFill({ ...BASE, stalled: true }), false);
  });

  it('custom maxPages / marginPx', () => {
    assert.equal(needsViewportFill({ ...BASE, pagesAutoLoaded: 2, maxPages: 2 }), false);
    assert.equal(
      needsViewportFill({
        ...BASE,
        scrollHeight: 810,
        clientHeight: 800,
        marginPx: 8
      }),
      false
    );
  });
});

describe('viewportFillAffordanceLabel', () => {
  it('default copy before the cap', () => {
    assert.equal(
      viewportFillAffordanceLabel(0),
      '· · · older turns — scroll up ·'
    );
    assert.equal(
      viewportFillAffordanceLabel(VIEWPORT_FILL_MAX_PAGES - 1),
      '· · · older turns — scroll up ·'
    );
  });

  it('switches to Load earlier… when the auto-page cap hits', () => {
    assert.equal(viewportFillAffordanceLabel(VIEWPORT_FILL_MAX_PAGES), 'Load earlier…');
    assert.equal(viewportFillAffordanceLabel(VIEWPORT_FILL_MAX_PAGES + 2), 'Load earlier…');
  });
});

describe('shouldPinFillToTail', () => {
  it('pins only while an auto-fill page is in flight and follow is on', () => {
    assert.equal(shouldPinFillToTail(true, true), true);
    assert.equal(shouldPinFillToTail(true, false), false);
    assert.equal(shouldPinFillToTail(false, true), false);
  });
});

describe('shouldContinueLoadAll', () => {
  const ALL = { loadAll: true, hasOlder: true, olderLoading: false, stalled: false };

  it('keeps paging while load-all is on and older remains', () => {
    assert.equal(shouldContinueLoadAll(ALL), true);
  });

  it('stops when the file is exhausted', () => {
    assert.equal(shouldContinueLoadAll({ ...ALL, hasOlder: false }), false);
  });

  it('waits for the in-flight page', () => {
    assert.equal(shouldContinueLoadAll({ ...ALL, olderLoading: true }), false);
  });

  it('stops on an empty page even if hasOlder stayed true', () => {
    assert.equal(shouldContinueLoadAll({ ...ALL, stalled: true }), false);
  });

  it('does nothing unless the user asked for load-all', () => {
    assert.equal(shouldContinueLoadAll({ ...ALL, loadAll: false }), false);
  });

  it('does not honor the viewport-fill page cap (load-all drains the file)', () => {
    // The helper has no pagesAutoLoaded on purpose — a 200-turn transcript
    // must not stop after 6 fill pages when the user clicked Load entire.
    assert.equal(shouldContinueLoadAll(ALL), true);
  });
});
