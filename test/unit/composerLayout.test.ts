import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampComposerHeight,
  COMPOSER_MIN_HEIGHT,
  isNearBottom,
  maximizedComposerHeight
} from '../../webview-ui/src/util/composerLayout';

describe('clampComposerHeight', () => {
  it('respects min and max fraction of the panel', () => {
    assert.equal(clampComposerHeight(10, 800), COMPOSER_MIN_HEIGHT);
    assert.equal(clampComposerHeight(900, 800), maximizedComposerHeight(800));
    assert.equal(clampComposerHeight(200, 800), 200);
  });
});

describe('isNearBottom', () => {
  it('is true within slop of the tail', () => {
    const el = { scrollHeight: 1000, scrollTop: 900, clientHeight: 80 } as HTMLElement;
    assert.equal(isNearBottom(el, 64), true);
    const up = { scrollHeight: 1000, scrollTop: 100, clientHeight: 80 } as HTMLElement;
    assert.equal(isNearBottom(up, 64), false);
  });
});
