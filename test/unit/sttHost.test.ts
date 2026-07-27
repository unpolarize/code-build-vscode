import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostSttUnavailableDetail, resolveSttEngine } from '../../src/host/voice/sttResolve';

test('resolveSttEngine: auto prefers host when available', () => {
  assert.equal(resolveSttEngine('auto', true), 'host');
  assert.equal(resolveSttEngine(undefined, true), 'host');
});

test('resolveSttEngine: auto falls back to webview when host unavailable', () => {
  assert.equal(resolveSttEngine('auto', false), 'webview');
});

test('resolveSttEngine: host forces host or off', () => {
  assert.equal(resolveSttEngine('host', true), 'host');
  assert.equal(resolveSttEngine('host', false), 'off');
});

test('resolveSttEngine: webview and off are sticky', () => {
  assert.equal(resolveSttEngine('webview', true), 'webview');
  assert.equal(resolveSttEngine('webview', false), 'webview');
  assert.equal(resolveSttEngine('off', true), 'off');
});

test('hostSttUnavailableDetail mentions Speech extension and dictation', () => {
  const d = hostSttUnavailableDetail();
  assert.match(d, /VS Code Speech/i);
  assert.match(d, /Fn Fn|dictation/i);
  assert.match(d, /webview/i);
});
