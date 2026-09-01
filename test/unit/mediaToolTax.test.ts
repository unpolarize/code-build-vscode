import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_TAX_DOM_HINT,
  MediaToolTaxTracker,
  classifyToolResultContent,
  classifyToolResultPart,
  estimateMediaTokensFromBase64,
  evaluateMediaToolTaxChip,
  isMediaPart,
  type MediaToolTaxConfig
} from '../../src/shared/mediaToolTax';

const PNG_B64 = 'A'.repeat(12_000); // large enough for blob heuristic

describe('classifyToolResultPart', () => {
  it('classifies ACP image content blocks by type+mime', () => {
    const c = classifyToolResultPart({
      type: 'image',
      mimeType: 'image/png',
      data: PNG_B64
    });
    assert.equal(c.kind, 'image');
    assert.equal(c.mimeType, 'image/png');
    assert.ok(c.estimatedTokens >= 256);
    assert.ok(c.extraTokens > 0);
    assert.match(c.reason, /content-block-image|mime/);
  });

  it('classifies data:image URL strings', () => {
    const c = classifyToolResultPart(`data:image/jpeg;base64,${PNG_B64}`);
    assert.equal(c.kind, 'image');
    assert.equal(c.mimeType, 'image/jpeg');
    assert.ok(c.estimatedTokens > 0);
  });

  it('treats plain short text as text with zero media tax', () => {
    const c = classifyToolResultPart('DOM: <div id="root">hello</div>');
    assert.equal(c.kind, 'text');
    assert.equal(c.estimatedTokens, 0);
    assert.equal(c.extraTokens, 0);
  });

  it('flags large bare base64 as pixel', () => {
    const c = classifyToolResultPart(PNG_B64);
    assert.equal(c.kind, 'pixel');
    assert.ok(c.estimatedTokens > 0);
  });

  it('screenshot tool title + blob → image', () => {
    const c = classifyToolResultPart(
      { type: 'text', text: PNG_B64 },
      'browser_take_screenshot'
    );
    // text type with large blob still classified via embedded path when not type:image —
    // content-block-text wins for type:text. Use raw object with data field instead.
    const c2 = classifyToolResultPart({ data: PNG_B64 }, 'Take screenshot');
    assert.equal(c2.kind, 'image');
    assert.match(c2.reason, /screenshot/);
    // type:text stays text (DOM path preferred)
    assert.equal(c.kind, 'text');
  });

  it('never throws on garbage', () => {
    for (const bad of [null, undefined, 42, true, Symbol('x'), { foo: 1 }]) {
      const c = classifyToolResultPart(bad as unknown);
      assert.ok(c.kind === 'text' || c.kind === 'unknown');
      assert.equal(c.extraTokens, 0);
    }
  });
});

describe('classifyToolResultContent', () => {
  it('maps a tool_call.content array of mixed parts', () => {
    const parts = classifyToolResultContent([
      { type: 'text', text: 'ok' },
      { type: 'image', mimeType: 'image/webp', data: PNG_B64 }
    ]);
    assert.equal(parts.length, 2);
    assert.equal(parts[0]!.kind, 'text');
    assert.equal(parts[1]!.kind, 'image');
    assert.equal(parts.filter(isMediaPart).length, 1);
  });
});

describe('estimateMediaTokensFromBase64', () => {
  it('matches webview bounds (floor 256, cap 8000)', () => {
    assert.equal(estimateMediaTokensFromBase64(undefined), 256);
    assert.equal(estimateMediaTokensFromBase64(''), 256);
    assert.ok(estimateMediaTokensFromBase64('AAAA') >= 256);
    assert.ok(estimateMediaTokensFromBase64('A'.repeat(10_000_000)) <= 8_000);
  });
});

describe('evaluateMediaToolTaxChip', () => {
  it('chip render fixture — turn + session labels', () => {
    const chip = evaluateMediaToolTaxChip({
      turnMediaTokens: 2100,
      sessionMediaTokens: 8400,
      sessionMediaCount: 3,
      pause: false,
      pauseReasons: []
    });
    assert.equal(chip.label, 'media ~2.1k · sess 8.4k');
    assert.equal(chip.warn, false);
    assert.equal(chip.pause, false);
    assert.equal(chip.hint, undefined);
  });

  it('pause chip carries prefer-DOM hint', () => {
    const chip = evaluateMediaToolTaxChip({
      turnMediaTokens: 0,
      sessionMediaTokens: 12_000,
      sessionMediaCount: 6,
      pause: true,
      pauseReasons: ['media results 6 ≥ limit 5']
    });
    assert.equal(chip.warn, true);
    assert.equal(chip.pause, true);
    assert.equal(chip.hint, MEDIA_TAX_DOM_HINT);
    assert.match(chip.label, /media sess/);
  });

  it('zero tax → media 0', () => {
    const chip = evaluateMediaToolTaxChip({
      turnMediaTokens: 0,
      sessionMediaTokens: 0,
      sessionMediaCount: 0,
      pause: false,
      pauseReasons: []
    });
    assert.equal(chip.label, 'media 0');
  });
});

describe('MediaToolTaxTracker soft gate', () => {
  const cfg: MediaToolTaxConfig = {
    mode: 'warn',
    maxMediaResults: 3,
    maxMediaWindowPct: 10
  };

  it('counts media results once per toolCallId and pauses at N', () => {
    const t = new MediaToolTaxTracker();
    t.startTurn();
    const img = { type: 'image', mimeType: 'image/png', data: PNG_B64 };
    t.noteToolContent([img], { toolCallId: 't1', toolTitle: 'screenshot' });
    t.noteToolContent([img], { toolCallId: 't1' }); // dedupe
    assert.equal(t.getSessionMediaCount(), 1);

    t.noteToolContent([img], { toolCallId: 't2' });
    t.noteToolContent([img], { toolCallId: 't3' });
    const { chip, newlyPaused, pauseReasons } = t.check(cfg);
    assert.equal(newlyPaused, true);
    assert.equal(chip.pause, true);
    assert.ok(pauseReasons.some((r) => /media results/.test(r)));
    assert.equal(chip.hint, MEDIA_TAX_DOM_HINT);

    // fires once
    const again = t.check(cfg);
    assert.equal(again.newlyPaused, false);
    assert.equal(again.chip.pause, true);
  });

  it('window-% gate trips independently of count', () => {
    const t = new MediaToolTaxTracker();
    const img = { type: 'image', mimeType: 'image/png', data: PNG_B64 };
    t.noteToolContent([img], { toolCallId: 'a' });
    // Tiny window → one image exceeds 10%
    const { newlyPaused, pauseReasons } = t.check(
      { mode: 'warn', maxMediaResults: 99, maxMediaWindowPct: 10 },
      1_000
    );
    assert.equal(newlyPaused, true);
    assert.ok(pauseReasons.some((r) => /media tax/.test(r)));
  });

  it('mode off never pauses', () => {
    const t = new MediaToolTaxTracker();
    const img = { type: 'image', mimeType: 'image/png', data: PNG_B64 };
    for (let i = 0; i < 10; i++) {
      t.noteToolContent([img], { toolCallId: `x${i}` });
    }
    const { newlyPaused, chip } = t.check({
      mode: 'off',
      maxMediaResults: 1,
      maxMediaWindowPct: 1
    });
    assert.equal(newlyPaused, false);
    assert.equal(chip.pause, false);
  });

  it('text-only tool results add zero session media tax', () => {
    const t = new MediaToolTaxTracker();
    t.noteToolContent([{ type: 'text', text: '<html>DOM snapshot</html>' }], {
      toolCallId: 'dom1',
      toolTitle: 'browser_snapshot'
    });
    const snap = t.snapshot(cfg);
    assert.equal(snap.sessionMediaCount, 0);
    assert.equal(snap.sessionMediaTokens, 0);
    assert.equal(snap.pause, false);
  });
});
