import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineUnavailableDetail,
  hostSttUnavailableDetail,
  resolveSttEngine,
  webviewSttEngine,
  type SttAvailability
} from '../../src/host/voice/sttResolve';

const none: SttAvailability = { xai: false, transcribe: false, speechExt: false };
const all: SttAvailability = { xai: true, transcribe: true, speechExt: true };

test('resolveSttEngine: auto prefers xai, then transcribe, then speech ext', () => {
  assert.equal(resolveSttEngine('auto', all), 'xai');
  assert.equal(resolveSttEngine(undefined, all), 'xai');
  assert.equal(resolveSttEngine('auto', { ...all, xai: false }), 'transcribe');
  assert.equal(resolveSttEngine('auto', { ...all, xai: false, transcribe: false }), 'host');
  assert.equal(resolveSttEngine('auto', none), 'webview');
});

test('resolveSttEngine: forced engines resolve or fall to off', () => {
  assert.equal(resolveSttEngine('xai', all), 'xai');
  assert.equal(resolveSttEngine('xai', none), 'off');
  assert.equal(resolveSttEngine('transcribe', all), 'transcribe');
  assert.equal(resolveSttEngine('transcribe', none), 'off');
  assert.equal(resolveSttEngine('host', all), 'host');
  assert.equal(resolveSttEngine('host', none), 'off');
});

test('resolveSttEngine: webview and off are sticky', () => {
  assert.equal(resolveSttEngine('webview', all), 'webview');
  assert.equal(resolveSttEngine('webview', none), 'webview');
  assert.equal(resolveSttEngine('off', all), 'off');
});

test('webviewSttEngine maps host engines to host', () => {
  assert.equal(webviewSttEngine('xai'), 'host');
  assert.equal(webviewSttEngine('transcribe'), 'host');
  assert.equal(webviewSttEngine('host'), 'host');
  assert.equal(webviewSttEngine('webview'), 'webview');
  assert.equal(webviewSttEngine('off'), 'off');
});

test('unavailability details are actionable per engine', () => {
  assert.match(engineUnavailableDetail('xai'), /grok|xaiApiKey/i);
  assert.match(engineUnavailableDetail('transcribe'), /AWS/i);
  assert.match(engineUnavailableDetail('host'), /VS Code Speech/i);
  const d = hostSttUnavailableDetail();
  assert.match(d, /VS Code Speech/i);
  assert.match(d, /Fn Fn|dictation/i);
});
