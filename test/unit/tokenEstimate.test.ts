import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokensFromText,
  estimateTokensFromImage,
  lookupContextWindow,
  computePreSendEstimate,
  formatTokenEstimate
} from '../../webview-ui/src/util/tokenEstimate';

// --- estimateTokensFromText -------------------------------------------------

test('empty text → 0 tokens', () => {
  assert.equal(estimateTokensFromText(''), 0);
  assert.equal(estimateTokensFromText(undefined as unknown as string), 0);
});

test('chars/4 heuristic rounds up', () => {
  assert.equal(estimateTokensFromText('abcd'), 1); // 4/4
  assert.equal(estimateTokensFromText('abcde'), 2); // 5/4 → 2
  assert.equal(estimateTokensFromText('x'.repeat(4000)), 1000);
});

// --- estimateTokensFromImage ------------------------------------------------

test('missing image data uses flat floor', () => {
  assert.equal(estimateTokensFromImage(undefined), 256);
  assert.equal(estimateTokensFromImage(''), 256);
});

test('image estimate is bounded', () => {
  const huge = 'A'.repeat(10_000_000);
  assert.ok(estimateTokensFromImage(huge) <= 8_000);
  assert.ok(estimateTokensFromImage('AAAA') >= 256);
});

// --- lookupContextWindow ----------------------------------------------------

test('known model families resolve to a window', () => {
  assert.equal(lookupContextWindow('claude-opus-4-7'), 200_000);
  assert.equal(lookupContextWindow('claude-sonnet-4-6'), 200_000);
  assert.equal(lookupContextWindow('grok-build'), 128_000);
  assert.equal(lookupContextWindow('grok-4.20'), 128_000);
  assert.equal(lookupContextWindow('gpt-5'), 128_000);
  assert.equal(lookupContextWindow('o3-mini'), 128_000);
});

test('default / unknown / empty → undefined', () => {
  assert.equal(lookupContextWindow('default'), undefined);
  assert.equal(lookupContextWindow(''), undefined);
  assert.equal(lookupContextWindow(null), undefined);
  assert.equal(lookupContextWindow(undefined), undefined);
  assert.equal(lookupContextWindow('totally-unknown-model-xyz'), undefined);
});

// --- computePreSendEstimate -------------------------------------------------

test('text-only estimate', () => {
  const est = computePreSendEstimate({ text: 'x'.repeat(4000) });
  assert.equal(est.tokens, 1000);
  assert.equal(est.windowTokens, undefined);
  assert.equal(est.windowPct, undefined);
});

test('includes primer chars and schema tokens', () => {
  const est = computePreSendEstimate({
    text: 'abcd', // 1 tok
    primerChars: 400, // 100 tok
    schemaTokens: 50
  });
  assert.equal(est.tokens, 1 + 100 + 50);
});

test('window % when model known', () => {
  const est = computePreSendEstimate({
    text: 'x'.repeat(8000), // 2000 tok
    model: 'claude-sonnet-4-6'
  });
  assert.equal(est.tokens, 2000);
  assert.equal(est.windowTokens, 200_000);
  assert.ok(est.windowPct != null);
  assert.ok(Math.abs(est.windowPct! - 1) < 0.01);
});

test('images contribute without throwing', () => {
  const est = computePreSendEstimate({
    text: '',
    imageData: ['AAAA', undefined as unknown as string]
  });
  assert.ok(est.tokens >= 256);
});

// --- formatTokenEstimate ----------------------------------------------------

test('format returns null for empty', () => {
  assert.equal(formatTokenEstimate({ tokens: 0 }), null);
});

test('format without window', () => {
  assert.equal(formatTokenEstimate({ tokens: 420 }), '~420 tok');
  assert.equal(formatTokenEstimate({ tokens: 1200 }), '~1.2k tok');
  assert.equal(formatTokenEstimate({ tokens: 12_000 }), '~12k tok');
});

test('format with window percent', () => {
  const s = formatTokenEstimate({
    tokens: 16_000,
    windowTokens: 200_000,
    windowPct: 8
  });
  assert.equal(s, '~16k tok · ~8% window');
});

test('format sub-1% window shows <1', () => {
  const s = formatTokenEstimate({
    tokens: 100,
    windowTokens: 200_000,
    windowPct: 0.05
  });
  assert.equal(s, '~100 tok · ~<1% window');
});
