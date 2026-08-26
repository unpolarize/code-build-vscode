import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampTurnIndex,
  isNearBottom,
  stepUserTurn,
  visibleUserTurnIndex
} from '../../webview-ui/src/util/messageNav';

const TOPS = [12, 400, 900, 1400, 2200]; // 5 user turns
const VIEW = 320;
const HEIGHT = 2800;

describe('visibleUserTurnIndex', () => {
  it('returns -1 when there are no user turns', () => {
    assert.equal(
      visibleUserTurnIndex({ scrollTop: 0, clientHeight: VIEW, scrollHeight: HEIGHT, userTops: [] }),
      -1
    );
  });

  it('reports the last turn when the viewport is on the live tail', () => {
    assert.equal(
      visibleUserTurnIndex({
        scrollTop: HEIGHT - VIEW - 10,
        clientHeight: VIEW,
        scrollHeight: HEIGHT,
        userTops: TOPS
      }),
      4
    );
  });

  it('identifies the turn whose prompt is at the read line', () => {
    // scrollTop 880 → read line 928, which is past turn 3 (900) and before turn 4 (1400)
    assert.equal(
      visibleUserTurnIndex({
        scrollTop: 880,
        clientHeight: VIEW,
        scrollHeight: HEIGHT,
        userTops: TOPS
      }),
      2
    );
  });

  it('stays on the earlier turn while reading its reply (next prompt still below the line)', () => {
    // Between turn 2 (400) and turn 3 (900)
    assert.equal(
      visibleUserTurnIndex({
        scrollTop: 500,
        clientHeight: VIEW,
        scrollHeight: HEIGHT,
        userTops: TOPS
      }),
      1
    );
  });

  it('is 0 at the top of the transcript', () => {
    assert.equal(
      visibleUserTurnIndex({
        scrollTop: 0,
        clientHeight: VIEW,
        scrollHeight: HEIGHT,
        userTops: TOPS
      }),
      0
    );
  });

  it('does not jump to last just because the last prompt is in the lower viewport', () => {
    // Last prompt at 2200, viewport showing 2000–2320 — not near the document end
    // (HEIGHT 2800, bottom of view 2320, 480px of content still below).
    assert.equal(
      visibleUserTurnIndex({
        scrollTop: 2000,
        clientHeight: VIEW,
        scrollHeight: HEIGHT,
        userTops: TOPS
      }),
      3
    );
  });
});

describe('isNearBottom / stepUserTurn', () => {
  it('matches the 64px slop used by follow-the-bottom', () => {
    assert.equal(isNearBottom(900, 80, 1000, 64), true);
    assert.equal(isNearBottom(100, 80, 1000, 64), false);
  });

  it('steps from the visible index, not a stale counter', () => {
    // User scrolled to turn 8 of 11 (idx 7). ↑ must go to 6, not last-1.
    assert.equal(stepUserTurn(7, -1, 11), 6);
    assert.equal(stepUserTurn(7, 1, 11), 8);
    assert.equal(stepUserTurn(0, -1, 11), 0);
    assert.equal(stepUserTurn(10, 1, 11), 10);
    assert.equal(stepUserTurn(7, 1, 11) === 10, false);
  });

  it('clamps after the conversation shrinks or grows', () => {
    assert.equal(clampTurnIndex(10, 3), 2);
    assert.equal(clampTurnIndex(-1, 3), 0);
    assert.equal(clampTurnIndex(1, 0), -1);
  });
});
