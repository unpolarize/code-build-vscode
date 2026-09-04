import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFailoverOffer,
  failoverBannerMessage,
  FAILOVER_DEFAULT_LAST_N,
  FAILOVER_PREFERENCE
} from '../../src/shared/failoverOffer';
import { isFailoverClass } from '../../src/shared/backendErrorClass';

test('FAILOVER_DEFAULT_LAST_N is 5', () => {
  assert.equal(FAILOVER_DEFAULT_LAST_N, 5);
});

test('banner copy — overload vs unavailable', () => {
  assert.equal(
    failoverBannerMessage('overload', 'Grok'),
    'Primary overloaded — continue on Grok?'
  );
  assert.equal(
    failoverBannerMessage('unavailable', 'Codex'),
    'Primary unavailable — continue on Codex?'
  );
});

test('buildFailoverOffer returns null for quota/auth/other', () => {
  const backends = [
    { id: 'claude' as const, available: true, label: 'Claude Code' },
    { id: 'grok' as const, available: true, label: 'Grok' }
  ];
  for (const cls of ['quota', 'auth', 'other'] as const) {
    assert.equal(
      buildFailoverOffer({
        errorClass: cls,
        fromBackend: 'claude',
        backends
      }),
      null,
      cls
    );
    assert.equal(isFailoverClass(cls), false);
  }
});

test('buildFailoverOffer — Claude overload suggests Grok when available', () => {
  const offer = buildFailoverOffer({
    errorClass: 'overload',
    fromBackend: 'claude',
    backends: [
      { id: 'claude', available: true, label: 'Claude Code' },
      { id: 'grok', available: true, label: 'Grok' },
      { id: 'codex', available: true, label: 'Codex' },
      { id: 'opencode', available: false },
      { id: 'cline', available: false }
    ]
  });
  assert.ok(offer);
  assert.equal(offer!.suggestedBackend, 'grok');
  assert.equal(offer!.suggestedLabel, 'Grok');
  assert.equal(offer!.message, 'Primary overloaded — continue on Grok?');
  assert.deepEqual(
    offer!.alternatives.map((a) => a.id),
    ['grok', 'codex']
  );
  assert.equal(offer!.fromBackend, 'claude');
  assert.equal(offer!.errorClass, 'overload');
});

test('buildFailoverOffer — Grok unavailable skips self, prefers Codex then Claude', () => {
  const offer = buildFailoverOffer({
    errorClass: 'unavailable',
    fromBackend: 'grok',
    backends: [
      { id: 'claude', available: true },
      { id: 'grok', available: true },
      { id: 'codex', available: true }
    ]
  });
  assert.ok(offer);
  assert.equal(offer!.suggestedBackend, 'codex');
  assert.equal(offer!.message, 'Primary unavailable — continue on Codex?');
  assert.deepEqual(
    offer!.alternatives.map((a) => a.id),
    ['codex', 'claude']
  );
});

test('buildFailoverOffer — no peer available → null', () => {
  assert.equal(
    buildFailoverOffer({
      errorClass: 'overload',
      fromBackend: 'claude',
      backends: [
        { id: 'claude', available: true },
        { id: 'grok', available: false },
        { id: 'codex', available: false }
      ]
    }),
    null
  );
});

test('buildFailoverOffer — preference override for tests', () => {
  const offer = buildFailoverOffer({
    errorClass: 'overload',
    fromBackend: 'claude',
    preference: ['codex', 'grok', 'claude'],
    backends: [
      { id: 'claude', available: true },
      { id: 'grok', available: true },
      { id: 'codex', available: true }
    ]
  });
  assert.ok(offer);
  assert.equal(offer!.suggestedBackend, 'codex');
});

test('FAILOVER_PREFERENCE lists multi-vendor peers first', () => {
  assert.equal(FAILOVER_PREFERENCE[0], 'grok');
  assert.equal(FAILOVER_PREFERENCE[1], 'codex');
  assert.ok(FAILOVER_PREFERENCE.includes('claude'));
});
