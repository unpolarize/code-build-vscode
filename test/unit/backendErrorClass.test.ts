import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBackendError,
  isFailoverClass
} from '../../src/shared/backendErrorClass';
import { ClaudeNormalizer } from '../../src/host/transports/normalizers/claude';
import { CodexNormalizer } from '../../src/host/transports/normalizers/codex';

// ---------------------------------------------------------------------------
// overload — the 529 class that SHOULD offer cross-backend failover
// ---------------------------------------------------------------------------

test('Claude API 529 envelope → overload', () => {
  // Anthropic wire shape for capacity errors.
  const fixture = {
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' }
  };
  assert.equal(classifyBackendError(fixture), 'overload');
});

test('bare HTTP 529 status → overload', () => {
  assert.equal(classifyBackendError({ status: 529, message: 'upstream error' }), 'overload');
  assert.equal(classifyBackendError('API error: 529 {"type":"overloaded_error"}'), 'overload');
});

test('Codex "overloaded" turn.failed text → overload', () => {
  assert.equal(
    classifyBackendError('The server is overloaded, please try again later'),
    'overload'
  );
});

// ---------------------------------------------------------------------------
// unavailable — model/service down, also failover-eligible
// ---------------------------------------------------------------------------

test('Grok "model unavailable" → unavailable', () => {
  assert.equal(
    classifyBackendError('model grok-4.5 is currently unavailable'),
    'unavailable'
  );
  assert.equal(classifyBackendError({ error: { type: 'model_unavailable' } }), 'unavailable');
});

test('503 service unavailable → unavailable', () => {
  assert.equal(classifyBackendError({ status: 503 }), 'unavailable');
  assert.equal(classifyBackendError('503 Service Unavailable'), 'unavailable');
});

// ---------------------------------------------------------------------------
// quota — MUST NOT be failover (limit-aware switch / Continuity Relay owns it)
// ---------------------------------------------------------------------------

test('429 / rate limit → quota, never overload', () => {
  assert.equal(classifyBackendError({ status: 429, message: 'Too Many Requests' }), 'quota');
  assert.equal(
    classifyBackendError({ type: 'rate_limit_error', message: 'Rate limit exceeded' }),
    'quota'
  );
  assert.equal(classifyBackendError('usage limit reached — resets at 3pm'), 'quota');
  assert.equal(classifyBackendError("You've hit your spend limit"), 'quota');
});

test('mixed vocabulary "429 … server overloaded" still → quota', () => {
  // The constraint case: quota wording wins even when overload words appear.
  assert.equal(
    classifyBackendError('429 Too Many Requests: server overloaded, slow down'),
    'quota'
  );
});

// ---------------------------------------------------------------------------
// auth / other
// ---------------------------------------------------------------------------

test('auth failures → auth', () => {
  assert.equal(classifyBackendError({ status: 401, message: 'invalid x-api-key' }), 'auth');
  assert.equal(classifyBackendError('Error: Not logged in. Run `grok login`.'), 'auth');
  assert.equal(classifyBackendError({ error: { type: 'authentication_error' } }), 'auth');
});

test('unrelated errors → other', () => {
  assert.equal(classifyBackendError('SyntaxError: Unexpected token in JSON'), 'other');
  assert.equal(classifyBackendError({ code: 'ECONNREFUSED', message: 'connect refused' }), 'other');
  assert.equal(classifyBackendError(''), 'other');
});

test('stderr-tail noise words do not misclassify', () => {
  // Scoped regexes: generic tool chatter must not look like auth/quota/
  // unavailable (these strings show up in real stderr tails).
  assert.equal(classifyBackendError('git: credential helper not found'), 'other');
  assert.equal(classifyBackendError('see billing docs at https://example.com'), 'other');
  assert.equal(classifyBackendError('warning: feature unavailable in this build'), 'other');
});

test('isFailoverClass gates to overload|unavailable only', () => {
  assert.equal(isFailoverClass('overload'), true);
  assert.equal(isFailoverClass('unavailable'), true);
  assert.equal(isFailoverClass('quota'), false);
  assert.equal(isFailoverClass('auth'), false);
  assert.equal(isFailoverClass('other'), false);
});

// ---------------------------------------------------------------------------
// normalizer wiring — error updates carry errorClass end-to-end
// ---------------------------------------------------------------------------

test('Claude normalizer tags mid-turn overload result with errorClass', () => {
  const n = new ClaudeNormalizer();
  const updates = n.parseLine({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    error: '529 overloaded_error: Overloaded'
  } as never);
  const err = updates.find((u) => u.kind === 'error');
  assert.ok(err && err.kind === 'error');
  assert.equal(err.errorClass, 'overload');
});

test('Codex normalizer tags turn.failed quota error as quota', () => {
  const n = new CodexNormalizer();
  const updates = n.parseLine({
    type: 'turn.failed',
    error: { message: 'Rate limit exceeded for gpt-5-codex' }
  } as never);
  const err = updates.find((u) => u.kind === 'error');
  assert.ok(err && err.kind === 'error');
  assert.equal(err.errorClass, 'quota');
});
