import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  backfillNativeIds,
  nativeIdChanges,
  planBackfill
} from '../../src/host/persistence/backfillNativeIds';
import type { SessionMeta } from '../../src/shared/protocol';

// Fixture roots only — a fresh tmp dir per test, never the live ~/.codebuild.
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-backfill-'));
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  return root;
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    backend: 'claude',
    title: 'Fixture',
    mode: 'default',
    cwd: '/repo',
    createdAt: 1_700_000_000_000,
    ...extra
  };
}

function writeFixture(root: string, m: SessionMeta, nativeIds: string[]): string {
  const lines = [JSON.stringify({ type: 'meta', meta: m })];
  lines.push(JSON.stringify({ type: 'user', text: 'hello' }));
  for (const id of nativeIds) {
    lines.push(
      JSON.stringify({ type: 'update', update: { kind: 'system_init', backendSessionId: id } })
    );
    lines.push(
      JSON.stringify({
        type: 'update',
        update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
      })
    );
  }
  const p = path.join(root, 'sessions', `${m.id}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function readMeta(root: string, id: string): SessionMeta {
  const first = fs
    .readFileSync(path.join(root, 'sessions', `${id}.jsonl`), 'utf8')
    .split('\n')[0];
  return (JSON.parse(first) as { meta: SessionMeta }).meta;
}

test('nativeIdChanges: collapses consecutive re-inits, keeps revisited ids', () => {
  const lines = ['a', 'a', 'b', 'a', 'c'].map((id) =>
    JSON.stringify({ type: 'update', update: { kind: 'system_init', backendSessionId: id } })
  );
  lines.push('not json', JSON.stringify({ type: 'user', text: 'x' }));
  // a→b→a is a real change sequence (native resume back to a) — the revisit
  // must survive so the last element is the transcript's true final id.
  assert.deepEqual(nativeIdChanges(lines), ['a', 'b', 'a', 'c']);
});

test('revisited id (a→b→a): bsid is the true last init, not the last distinct id', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1'), ['native-a', 'native-b', 'native-a']);
  backfillNativeIds(root, { write: true });
  const m = readMeta(root, 's1');
  assert.equal(m.backendSessionId, 'native-a');
  assert.deepEqual(m.backendSessionHistory?.map((h) => h.id), [
    'native-a',
    'native-b',
    'native-a'
  ]);
  assert.deepEqual(m.native, { format: 'claude-jsonl', id: 'native-a' });
});

test('acceptance 5a: multi system_init → bsid = last, history = distinct-id changes', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1'), ['native-1', 'native-1', 'native-2']);
  const report = backfillNativeIds(root, { write: true });
  const m = readMeta(root, 's1');
  assert.equal(m.backendSessionId, 'native-2');
  assert.deepEqual(
    m.backendSessionHistory?.map((h) => [h.id, h.reason]),
    [
      ['native-1', 'initial'],
      ['native-2', 'respawn']
    ]
  );
  // ts is meta.createdAt — never an invented per-transition time.
  assert.ok(m.backendSessionHistory?.every((h) => h.ts === 1_700_000_000_000));
  assert.deepEqual(m.native, { format: 'claude-jsonl', id: 'native-2' });
  assert.equal(report.sessions[0].written, true);
});

test('acceptance 5b: zero system_init → bsid stays absent, session untouched', () => {
  const root = fixtureRoot();
  const p = writeFixture(root, meta('s1'), []);
  const before = fs.readFileSync(p, 'utf8');
  const report = backfillNativeIds(root, { write: true });
  assert.equal(report.sessions[0].status, 'no-init');
  assert.equal(readMeta(root, 's1').backendSessionId, undefined);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'no-init transcript must not be rewritten');
});

test('acceptance 5c: system_init present but meta.bsid empty → filled', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1'), ['native-9']);
  const report = backfillNativeIds(root, { write: true });
  assert.equal(report.sessions[0].status, 'fixable');
  const m = readMeta(root, 's1');
  assert.equal(m.backendSessionId, 'native-9');
  assert.deepEqual(m.backendSessionHistory?.map((h) => h.id), ['native-9']);
});

test('dry-run is the default: reports fixable but writes nothing, deterministic count line', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1'), ['native-1']);
  writeFixture(root, meta('s2'), []);
  const report = backfillNativeIds(root);
  assert.equal(report.dryRun, true);
  assert.equal(readMeta(root, 's1').backendSessionId, undefined, 'dry-run must not write');
  assert.equal(
    report.summary,
    'backfill (dry-run): scanned=2 fixable=1 written=0 ok=0 no-init=1 conflicts=0 unreadable=0'
  );
});

test('never overwrites: mismatched existing bsid is a conflict, not a rewrite', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1', { backendSessionId: 'stale-id' }), ['native-1']);
  const report = backfillNativeIds(root, { write: true });
  assert.equal(report.sessions[0].status, 'conflict');
  assert.equal(readMeta(root, 's1').backendSessionId, 'stale-id');
});

test('meta already in agreement (bsid + history + native) is ok, not rewritten', () => {
  const root = fixtureRoot();
  writeFixture(
    root,
    meta('s1', {
      backendSessionId: 'native-1',
      backendSessionHistory: [{ id: 'native-1', ts: 1, reason: 'initial' }],
      native: { format: 'claude-jsonl', id: 'native-1' }
    }),
    ['native-1']
  );
  const report = backfillNativeIds(root, { write: true });
  assert.equal(report.sessions[0].status, 'ok');
  assert.equal(report.sessions[0].written, false);
});

test('bsid present but history missing → history alone is filled', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1', { backendSessionId: 'native-2' }), ['native-1', 'native-2']);
  backfillNativeIds(root, { write: true });
  const m = readMeta(root, 's1');
  assert.equal(m.backendSessionId, 'native-2');
  assert.deepEqual(m.backendSessionHistory?.map((h) => h.id), ['native-1', 'native-2']);
});

test('unknown native format backend: ids/history fill, native pointer omitted', () => {
  const root = fixtureRoot();
  writeFixture(root, meta('s1', { backend: 'opencode' as SessionMeta['backend'] }), ['n-1']);
  backfillNativeIds(root, { write: true });
  const m = readMeta(root, 's1');
  assert.equal(m.backendSessionId, 'n-1');
  assert.equal(m.native, undefined);
});

test('write keeps body lines intact and updates the index row when present', () => {
  const root = fixtureRoot();
  const m = meta('s1');
  const p = writeFixture(root, m, ['native-1']);
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify([m], null, 2));
  const bodyBefore = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1);
  backfillNativeIds(root, { write: true });
  const bodyAfter = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(1);
  assert.deepEqual(bodyAfter, bodyBefore, 'body must survive header rewrite byte-for-byte');
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')) as SessionMeta[];
  assert.equal(idx[0].backendSessionId, 'native-1');
});

test('fails closed: missing root or missing sessions dir throws', () => {
  assert.throws(() => backfillNativeIds(''));
  assert.throws(() => backfillNativeIds(path.join(os.tmpdir(), 'codebuild-backfill-nonexistent')));
});

test('refuses live ~/.codebuild write without allowLive (dry-run report only)', () => {
  const live = path.join(os.homedir(), '.codebuild');
  if (!fs.existsSync(path.join(live, 'sessions'))) return; // no live store on this machine
  const report = backfillNativeIds(live, { write: true });
  assert.equal(report.dryRun, true);
  assert.ok(report.refused, 'live write without allowLive must be refused');
  assert.equal(report.sessions.length, 0, 'refusal must not even scan');
});

test('planBackfill is pure: no-init and conflict yield no patch', () => {
  assert.deepEqual(planBackfill(meta('x'), []), { status: 'no-init' });
  assert.equal(planBackfill(meta('x', { backendSessionId: 'a' }), ['b']).status, 'conflict');
});
