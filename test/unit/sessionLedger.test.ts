import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBaselineStore,
  foldToolCall,
  isEditToolCall,
  normalizePathKey,
  replayLedger,
  sha1Hex,
  type LedgerFs,
  type SessionLedger,
} from '../../src/host/sessionLedger';
import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';

const CWD = '/work';

function fakeFs(files: Record<string, string>): LedgerFs {
  return {
    readFile: (p) => (p in files ? files[p] : null),
    realpath: (p) => (p in files ? p : null),
  };
}

function editCall(overrides: Partial<ToolCall> & { path?: string }): ToolCall {
  const { path: p, ...rest } = overrides;
  return {
    toolCallId: 'tc-1',
    title: 'Edit',
    kind: 'edit',
    status: 'completed',
    content: p ? [{ type: 'diff', path: p, oldText: '', newText: '' }] : [],
    ...rest,
  };
}

test('completed edit produces one row with baseline-vs-disk counts', () => {
  const fs = fakeFs({ '/work/a.ts': 'a\nB\nc' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', 'a\nb\nc');
  const ledger: SessionLedger = new Map();
  const mutated = foldToolCall(ledger, editCall({ path: 'a.ts' }), { cwd: CWD, fs, baselines });
  assert.equal(mutated, true);
  assert.equal(ledger.size, 1);
  const row = ledger.get('/work/a.ts');
  assert.deepEqual(row, { path: '/work/a.ts', status: 'M', editCount: 1, added: 1, removed: 1 });
});

test('multi-edit same file folds to one row with editCount=2', () => {
  const fs = fakeFs({ '/work/a.ts': 'a\nB\nC' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', 'a\nb\nc');
  const ledger: SessionLedger = new Map();
  foldToolCall(ledger, editCall({ toolCallId: 'tc-1', path: 'a.ts' }), { cwd: CWD, fs, baselines });
  foldToolCall(ledger, editCall({ toolCallId: 'tc-2', path: './a.ts' }), { cwd: CWD, fs, baselines });
  assert.equal(ledger.size, 1);
  const row = ledger.get('/work/a.ts')!;
  assert.equal(row.editCount, 2);
  // Counts stay baseline-vs-disk, not accumulated per record.
  assert.deepEqual({ added: row.added, removed: row.removed }, { added: 2, removed: 2 });
});

test('write-new file (no baseline) → status A with all lines added', () => {
  const fs = fakeFs({ '/work/new.ts': 'x\ny' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/new.ts', null); // first touch: file absent
  const ledger: SessionLedger = new Map();
  foldToolCall(ledger, editCall({ path: 'new.ts' }), { cwd: CWD, fs, baselines });
  const row = ledger.get('/work/new.ts')!;
  assert.equal(row.status, 'A');
  assert.deepEqual({ added: row.added, removed: row.removed }, { added: 2, removed: 0 });
});

test('file deleted since baseline → status D', () => {
  const fs = fakeFs({}); // gone from disk
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', 'a\nb');
  const ledger: SessionLedger = new Map();
  foldToolCall(ledger, editCall({ path: 'a.ts' }), { cwd: CWD, fs, baselines });
  const row = ledger.get('/work/a.ts')!;
  assert.equal(row.status, 'D');
  assert.deepEqual({ added: row.added, removed: row.removed }, { added: 0, removed: 2 });
});

test('failed and non-completed tool calls mutate nothing', () => {
  const fs = fakeFs({ '/work/a.ts': 'x' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', '');
  const ledger: SessionLedger = new Map();
  for (const status of ['pending', 'in_progress', 'failed'] as const) {
    const mutated = foldToolCall(ledger, editCall({ path: 'a.ts', status }), { cwd: CWD, fs, baselines });
    assert.equal(mutated, false, `status=${status} must not mutate`);
  }
  assert.equal(ledger.size, 0);
});

test('non-edit tool calls mutate nothing', () => {
  const fs = fakeFs({ '/work/a.ts': 'x' });
  const ledger: SessionLedger = new Map();
  const read: ToolCall = { toolCallId: 'r1', title: 'Read', kind: 'read', status: 'completed' };
  assert.equal(foldToolCall(ledger, read, { cwd: CWD, fs, baselines: createBaselineStore() }), false);
  assert.equal(ledger.size, 0);
  assert.equal(isEditToolCall(read), false);
});

test('relative and absolute spellings collapse to one key', () => {
  const fs = fakeFs({ '/work/sub/x.ts': 'x' });
  assert.equal(normalizePathKey('./sub/x.ts', CWD, fs), '/work/sub/x.ts');
  assert.equal(normalizePathKey('/work/sub/x.ts', CWD, fs), '/work/sub/x.ts');
  // Not-yet-existing paths still normalize via resolve.
  assert.equal(normalizePathKey('./nope.ts', CWD, fs), '/work/nope.ts');
});

test('second capture does not overwrite the first-touch baseline', () => {
  const baselines = createBaselineStore();
  assert.equal(baselines.captureIfAbsent('/work/a.ts', 'original'), true);
  assert.equal(baselines.captureIfAbsent('/work/a.ts', 'later'), false);
  assert.equal(baselines.get('/work/a.ts')!.content, 'original');
});

test('replay rebuilds an identical map regardless of record order', () => {
  const fs = fakeFs({ '/work/a.ts': 'a2', '/work/b.ts': 'b1\nb2' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', 'a1');
  baselines.captureIfAbsent('/work/b.ts', null);
  const updates: SessionUpdate[] = [
    { kind: 'tool_call', toolCall: editCall({ toolCallId: 't1', path: 'a.ts', status: 'pending' }) },
    { kind: 'tool_call', toolCall: editCall({ toolCallId: 't2', path: './b.ts', status: 'pending' }) },
    { kind: 'tool_call_update', toolCall: { toolCallId: 't1', status: 'completed' } },
    { kind: 'tool_call_update', toolCall: { toolCallId: 't2', status: 'completed' } },
    { kind: 'tool_call', toolCall: editCall({ toolCallId: 't3', path: '/work/a.ts' }) },
  ];
  const opts = { cwd: CWD, fs, baselines };
  const forward = replayLedger(updates, opts);
  const reversed = replayLedger([...updates].reverse(), opts);
  assert.deepEqual(Object.fromEntries(forward), Object.fromEntries(reversed));
  assert.equal(forward.size, 2);
  assert.equal(forward.get('/work/a.ts')!.editCount, 2);
  assert.equal(forward.get('/work/b.ts')!.status, 'A');
});

test('replay ignores calls that never completed or that failed', () => {
  const fs = fakeFs({ '/work/a.ts': 'x' });
  const baselines = createBaselineStore();
  baselines.captureIfAbsent('/work/a.ts', '');
  const updates: SessionUpdate[] = [
    { kind: 'tool_call', toolCall: editCall({ toolCallId: 't1', path: 'a.ts', status: 'in_progress' }) },
    { kind: 'tool_call', toolCall: editCall({ toolCallId: 't2', path: 'a.ts', status: 'pending' }) },
    { kind: 'tool_call_update', toolCall: { toolCallId: 't2', status: 'failed' } },
  ];
  const ledger = replayLedger(updates, { cwd: CWD, fs, baselines });
  assert.equal(ledger.size, 0);
});

test('sha1Hex is stable and hex-shaped', () => {
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.match(sha1Hex('/work/a.ts'), /^[0-9a-f]{40}$/);
});
