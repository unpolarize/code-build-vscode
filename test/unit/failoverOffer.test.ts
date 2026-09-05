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

// ── Manager wiring: pending-offer latch vs webview reload ────────────────
// SessionManager imports `vscode` so it can't be instantiated under node:test;
// these are source-contract guards (same pattern as permissionDefaults.test.ts)
// for the orphaned-offer bug: the webview hydrate reducer resets failoverOffer
// to null, so hydrate() must re-post a pending offer, and teardownSession must
// clear the latch so a stale offer can't suppress every future one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'host', 'sessionManager.ts'),
  'utf8'
);

/** Slice one method body out of the source (start marker → next `\n  private`). */
function methodBody(marker: string): string {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `marker not found: ${marker}`);
  const end = src.indexOf('\n  private', start + marker.length);
  return src.slice(start, end > start ? end : undefined);
}

test('hydrate() re-posts a pending failover offer AFTER the last hydrate post', () => {
  const body = methodBody('private async hydrate(): Promise<void> {');
  const repost = body.indexOf('this.postFailoverOffer(this.pendingFailover)');
  assert.ok(repost >= 0, 'hydrate must re-post the pending offer');
  // Both hydrate posts wipe failoverOffer in the webview reducer — the
  // re-post is only effective if it comes after the LAST of them, and after
  // the autoStart openSession (whose teardown clears a dead session latch).
  const lastHydratePost = body.lastIndexOf("type: 'hydrate'");
  const autoStartOpen = body.indexOf('await this.openSession(defaultBackend)');
  assert.ok(repost > lastHydratePost, 're-post must follow the final hydrate post');
  assert.ok(autoStartOpen >= 0 && repost > autoStartOpen, 're-post must follow autoStart');
  assert.ok(body.slice(repost - 60, repost).includes('if (this.pendingFailover)'));
});

test('teardownSession() clears the failover latch', () => {
  const body = methodBody('private teardownSession(): void {');
  assert.ok(
    body.includes('this.clearFailoverOffer()'),
    'teardown must clear pendingFailover so a stale latch cannot suppress future offers'
  );
});

test('accept path clears the latch BEFORE spawning the target (teardown clear stays a no-op)', () => {
  const body = methodBody('private async applyFailoverDecision(');
  const clear = body.indexOf('this.clearFailoverOffer()');
  const open = body.indexOf('await this.openSession(');
  const load = body.indexOf('await this.loadExistingSession(');
  assert.ok(clear >= 0 && open > clear && load > clear);
});

test('newSession message still clears a pending offer', () => {
  const start = src.indexOf("case 'newSession':");
  const end = src.indexOf("case 'pickBackend':", start);
  assert.ok(src.slice(start, end).includes('this.clearFailoverOffer()'));
});
