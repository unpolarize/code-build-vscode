import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCompactMarker,
  buildCompactPrimer,
  compactBlockReason,
  hasCompactableTurns,
  prepareCompactLineage,
  resolveRespawnResumeId,
  type CompactIdleFlags
} from '../../src/host/compact';
import { applyBackendSessionId } from '../../src/host/backendIdentity';
import { SessionStore } from '../../src/host/persistence/store';
import { parseCompactFocus } from '../../webview-ui/src/builtinCommands';
import type { SessionMeta } from '../../src/shared/protocol';

function idleFlags(over: Partial<CompactIdleFlags> = {}): CompactIdleFlags {
  return {
    turnActive: false,
    openToolCalls: 0,
    awaitingPermission: false,
    pendingQuestions: 0,
    primerPending: false,
    queuedPrompt: false,
    ...over
  };
}

function freshMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'cb-local-1',
    backend: 'claude',
    title: 'Test',
    mode: 'default',
    cwd: '/repo',
    createdAt: 1_700_000_000_000,
    ...over
  };
}

// ── idle guard ────────────────────────────────────────────────────────────

test('compactBlockReason: idle session → undefined', () => {
  assert.equal(compactBlockReason(idleFlags()), undefined);
});

test('compactBlockReason: every busy flag blocks with a reason', () => {
  const cases: Partial<CompactIdleFlags>[] = [
    { turnActive: true },
    { openToolCalls: 2 },
    { awaitingPermission: true },
    { pendingQuestions: 1 },
    { primerPending: true },
    { queuedPrompt: true }
  ];
  for (const over of cases) {
    const reason = compactBlockReason(idleFlags(over));
    assert.equal(typeof reason, 'string', JSON.stringify(over));
    assert.ok(reason!.length > 0);
  }
});

// ── empty session ─────────────────────────────────────────────────────────

test('hasCompactableTurns: notices/updates-only counts as empty', () => {
  assert.equal(hasCompactableTurns([]), false);
  assert.equal(
    hasCompactableTurns([
      { type: 'update', update: { kind: 'system_init' } },
      { type: 'update', update: { kind: 'agent_message_chunk' } }
    ]),
    false
  );
  assert.equal(hasCompactableTurns([{ type: 'user', text: 'hi' }]), true);
});

// ── marker ────────────────────────────────────────────────────────────────

test('buildCompactMarker: preview capped at 200 chars, focus/preTokens optional', () => {
  const long = 'x'.repeat(500);
  const m = buildCompactMarker({ now: 42, preTokens: 123_456, summary: long, focus: 'tests' });
  assert.equal(m.at, 42);
  assert.equal(m.preTokens, 123_456);
  assert.equal(m.summaryPreview.length, 200);
  assert.equal(m.instructions, 'tests');
  const bare = buildCompactMarker({ now: 1, summary: ' short ' });
  assert.equal(bare.summaryPreview, 'short');
  assert.equal('preTokens' in bare, false);
  assert.equal('instructions' in bare, false);
});

// ── primer ────────────────────────────────────────────────────────────────

test('buildCompactPrimer: hybrid shape — summary + last N verbatim + breadcrumb + focus', () => {
  const records = [
    { type: 'user', text: 'turn one' },
    { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'reply one' } } },
    { type: 'user', text: 'turn two' },
    { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'reply two' } } },
    { type: 'user', text: 'turn three' }
  ];
  const primer = buildCompactPrimer({
    records,
    summary: 'THE SUMMARY',
    backendLabel: 'Claude',
    lastNTurns: 2,
    focus: 'the webpack config',
    transcriptPath: '/tmp/sessions/cb-local-1.jsonl'
  });
  assert.match(primer, /mode="compact"/);
  assert.match(primer, /YOUR OWN conversation/);
  assert.match(primer, /== SUMMARY ==\nTHE SUMMARY/);
  assert.match(primer, /LAST 2 TURNS \(verbatim\)/);
  // Last 2 turns only — turn one must be elided.
  assert.match(primer, /turn three/);
  assert.doesNotMatch(primer, /turn one/);
  assert.match(primer, /focus on: the webpack config/);
  assert.match(primer, /\/tmp\/sessions\/cb-local-1\.jsonl/);
  assert.match(primer, /Do NOT respond to this context block directly/);
});

// ── lineage + native-id clear ─────────────────────────────────────────────

test('prepareCompactLineage: seeds history with the old id, then clears it', () => {
  const meta = freshMeta({ backendSessionId: 'native-old' });
  assert.equal(prepareCompactLineage(meta), true);
  assert.equal(meta.backendSessionId, undefined);
  assert.deepEqual(meta.backendSessionHistory, [
    { id: 'native-old', ts: meta.createdAt, reason: 'initial' }
  ]);
  // The respawn's system_init then lands the NEW id with reason 'compact'.
  assert.equal(applyBackendSessionId(meta, 'native-new', 'compact', 999), true);
  assert.equal(meta.backendSessionId, 'native-new');
  assert.deepEqual(
    meta.backendSessionHistory!.map((h) => [h.id, h.reason]),
    [
      ['native-old', 'initial'],
      ['native-new', 'compact']
    ]
  );
});

test('prepareCompactLineage: old id already in history → no duplicate; no id → no-op', () => {
  const meta = freshMeta({
    backendSessionId: 'native-old',
    backendSessionHistory: [{ id: 'native-old', ts: 1, reason: 'initial' }]
  });
  assert.equal(prepareCompactLineage(meta), true);
  assert.equal(meta.backendSessionHistory!.length, 1);
  assert.equal(prepareCompactLineage(freshMeta()), false);
});

// ── respawn resume rule ───────────────────────────────────────────────────

test('resolveRespawnResumeId: compact respawn NEVER receives a pre-compact resume id', () => {
  // Captured native id — normally resumed…
  assert.equal(
    resolveRespawnResumeId(freshMeta({ backendSessionId: 'native-old' }), false),
    'native-old'
  );
  // …but never on a compact respawn.
  assert.equal(
    resolveRespawnResumeId(freshMeta({ backendSessionId: 'native-old' }), true),
    undefined
  );
  // Imported claude session (local id IS the native id) — same rule.
  assert.equal(resolveRespawnResumeId(freshMeta({ source: 'claude' }), false), 'cb-local-1');
  assert.equal(resolveRespawnResumeId(freshMeta({ source: 'claude' }), true), undefined);
  assert.equal(resolveRespawnResumeId(freshMeta(), false), undefined);
});

// ── store: the clear must actually persist ────────────────────────────────

test('SessionStore.clearBackendSessionId persists (updateMeta alone cannot clear)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-compact-'));
  const store = new SessionStore(root);
  const meta = freshMeta({ id: 'sess-c' });
  store.createSession(meta);
  store.commitSession(meta);
  store.updateMeta('sess-c', { backendSessionId: 'native-old' });
  assert.equal(store.loadMeta('sess-c')?.backendSessionId, 'native-old');
  // mergeSessionMeta skips undefined patch values — this is why the
  // explicit verb exists.
  store.updateMeta('sess-c', { backendSessionId: undefined });
  assert.equal(store.loadMeta('sess-c')?.backendSessionId, 'native-old');
  const cleared = store.clearBackendSessionId('sess-c');
  assert.equal(cleared?.backendSessionId, undefined);
  assert.equal(store.loadMeta('sess-c')?.backendSessionId, undefined);
});

// ── webview parse ─────────────────────────────────────────────────────────

test('parseCompactFocus: bare /compact → undefined; trailing text → focus', () => {
  assert.equal(parseCompactFocus('/compact'), undefined);
  assert.equal(parseCompactFocus('  /compact  '), undefined);
  assert.equal(parseCompactFocus('/compact keep the auth work'), 'keep the auth work');
});
