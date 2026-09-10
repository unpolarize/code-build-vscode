// In-flight Write atomic drain on rate-limit (kp:
// ideas/cb-in-flight-write-atomic-drain-on-rate-limit-fi). Fake ACP backend
// via injectable DrainFs — flush when disk matches tool-args hash, rollback
// when incomplete. No VS Code, no real disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WRITE_DRAIN_CHIP_LABEL,
  WriteAtomicDrainTracker,
  contentHash,
  decideDrainAction,
  extractWriteTargets,
  formatWriteDrainSummary,
  isWriteClassTool,
  writeDrainChip,
  type DrainFs
} from '../../src/shared/writeAtomicDrain';
import { classifyBackendError } from '../../src/shared/backendErrorClass';
import { reduce, initialState } from '../../webview-ui/src/store';
import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';

const CWD = '/ws';

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: DrainFs & { files: Map<string, string> } = {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    deleteFile: (p) => void files.delete(p)
  };
  return fs;
}

function tracker() {
  const t = new WriteAtomicDrainTracker();
  t.setCwd(CWD);
  return t;
}

function toolCall(tc: Partial<ToolCall> & { toolCallId: string }): SessionUpdate {
  return {
    kind: 'tool_call',
    toolCall: { title: 'Write', status: 'pending', kind: 'write', ...tc } as ToolCall
  };
}

function toolUpdate(tc: Partial<ToolCall> & { toolCallId: string }): SessionUpdate {
  return { kind: 'tool_call_update', toolCall: tc };
}

test('contentHash is stable SHA-1', () => {
  assert.equal(contentHash('hello'), contentHash('hello'));
  assert.notEqual(contentHash('hello'), contentHash('hello!'));
  assert.match(contentHash('hello'), /^[0-9a-f]{40}$/);
});

test('Read / Bash are not write-class — not drained', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  t.observeUpdate(
    {
      kind: 'tool_call',
      toolCall: {
        toolCallId: 'r1',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: { file_path: '/ws/a.ts' }
      }
    },
    fs,
    CWD
  );
  assert.equal(t.openCount, 0);
});

test('isWriteClassTool: kind, title, diff', () => {
  assert.equal(isWriteClassTool({ title: 'Read', kind: 'read' }), false);
  assert.equal(isWriteClassTool({ title: 'Write', kind: 'write' }), true);
  assert.equal(isWriteClassTool({ title: 'Edit worker.ts', kind: 'edit' }), true);
  assert.equal(isWriteClassTool({ title: 'Bash', kind: 'execute' }), false);
  assert.equal(
    isWriteClassTool({
      title: 'ApplyPatch',
      content: [{ type: 'diff', path: '/a.ts', oldText: '', newText: 'x' }]
    }),
    true
  );
});

test('extractWriteTargets: Write rawInput content is full intended body', () => {
  const targets = extractWriteTargets({
    title: 'Write',
    kind: 'write',
    rawInput: { file_path: 'a.ts', content: 'export const x = 1;\n' }
  });
  assert.deepEqual(targets, [{ path: 'a.ts', content: 'export const x = 1;\n' }]);
});

test('extractWriteTargets: patch-only Edit has null content (rollback preferred)', () => {
  const targets = extractWriteTargets({
    title: 'Edit',
    kind: 'edit',
    rawInput: { file_path: 'a.ts', old_string: 'x', new_string: 'y' }
  });
  assert.deepEqual(targets, [{ path: 'a.ts', content: null }]);
});

test('extractWriteTargets: diff newText is full intended body', () => {
  const targets = extractWriteTargets({
    title: 'Edit',
    kind: 'edit',
    content: [{ type: 'diff', path: '/ws/a.ts', oldText: 'v0', newText: 'v1' }]
  });
  assert.deepEqual(targets, [{ path: '/ws/a.ts', content: 'v1' }]);
});

test('decideDrainAction: hash match → flush', () => {
  const body = 'complete file\n';
  const d = decideDrainAction({
    intendedHash: contentHash(body),
    diskContent: body,
    hadPreImage: true
  });
  assert.equal(d.action, 'flush');
  assert.match(d.reason, /matches tool args hash/);
});

test('decideDrainAction: incomplete vs hash → rollback when pre-image exists', () => {
  const d = decideDrainAction({
    intendedHash: contentHash('complete file\n'),
    diskContent: 'complete',
    hadPreImage: true
  });
  assert.equal(d.action, 'rollback');
  assert.match(d.reason, /incomplete relative to tool args hash/);
});

test('decideDrainAction: no verifiable hash → rollback (preferred)', () => {
  const d = decideDrainAction({
    intendedHash: null,
    diskContent: 'whatever',
    hadPreImage: true
  });
  assert.equal(d.action, 'rollback');
  assert.match(d.reason, /no verifiable tool args hash/);
});

test('chip label is the KP acceptance copy', () => {
  const chip = writeDrainChip({
    flushed: 1,
    rolledBack: 1,
    skipped: 0,
    paths: ['/ws/a.ts', '/ws/b.ts']
  });
  assert.ok(chip);
  assert.equal(chip.label, WRITE_DRAIN_CHIP_LABEL);
  assert.equal(chip.label, 'drained write → paused');
  assert.equal(chip.warn, true);
  assert.match(formatWriteDrainSummary(chip), /2 files/);
  assert.match(formatWriteDrainSummary(chip), /flush 1/);
  assert.match(formatWriteDrainSummary(chip), /rollback 1/);
});

test('fake ACP: full write then quota → flush, disk stays complete', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  const body = 'export const done = true;\n';
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/a.ts', content: body }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', body); // agent/host finished the write
  const r = t.drain('quota', fs);
  assert.equal(r.fired, true);
  assert.equal(r.flushed, 1);
  assert.equal(r.rolledBack, 0);
  assert.equal(fs.files.get('/ws/a.ts'), body);
  assert.equal(r.chip?.label, WRITE_DRAIN_CHIP_LABEL);
  assert.equal(r.files[0].action, 'flush');
});

test('fake ACP: truncated write then quota → rollback to pre-image', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  const body = 'export const done = true;\n';
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/a.ts', content: body }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', 'export const'); // half-written
  const r = t.drain('quota', fs);
  assert.equal(r.fired, true);
  assert.equal(r.flushed, 0);
  assert.equal(r.rolledBack, 1);
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
  assert.equal(r.chip?.warn, true);
  assert.equal(r.files[0].action, 'rollback');
});

test('fake ACP: Write-new truncated → rollback deletes the file', () => {
  const fs = memFs();
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/new.ts', content: 'hello world\n' }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/new.ts', 'hello');
  const r = t.drain('quota', fs);
  assert.equal(r.rolledBack, 1);
  assert.equal(fs.files.has('/ws/new.ts'), false);
});

test('ACP fs/write_text_file intent: truncated then quota rolls back', () => {
  const fs = memFs({ '/ws/a.ts': 'orig' });
  const t = tracker();
  t.noteFsWriteIntent('/ws/a.ts', 'brand new body\n', fs);
  fs.files.set('/ws/a.ts', 'brand'); // writeFile in flight, partial
  const r = t.drain('quota', fs);
  assert.equal(r.rolledBack, 1);
  assert.equal(fs.files.get('/ws/a.ts'), 'orig');
});

test('ACP fs/write_text_file intent: complete then quota flushes', () => {
  const fs = memFs({ '/ws/a.ts': 'orig' });
  const t = tracker();
  const body = 'brand new body\n';
  t.noteFsWriteIntent('/ws/a.ts', body, fs);
  fs.files.set('/ws/a.ts', body);
  const r = t.drain('quota', fs);
  assert.equal(r.flushed, 1);
  assert.equal(fs.files.get('/ws/a.ts'), body);
});

test('commitFsWrite after rollback re-applies (racing writeFile)', () => {
  const fs = memFs({ '/ws/a.ts': 'orig' });
  const t = tracker();
  t.noteFsWriteIntent('/ws/a.ts', 'new body\n', fs);
  fs.files.set('/ws/a.ts', 'new');
  t.drain('quota', fs);
  assert.equal(fs.files.get('/ws/a.ts'), 'orig');
  // writeFile finishes after drain and would otherwise resurrect the body
  fs.files.set('/ws/a.ts', 'new body\n');
  t.commitFsWrite('/ws/a.ts', fs);
  assert.equal(fs.files.get('/ws/a.ts'), 'orig');
});

test('commitFsWrite on flushed path is a no-op drop', () => {
  const fs = memFs({ '/ws/a.ts': 'orig' });
  const t = tracker();
  t.noteFsWriteIntent('/ws/a.ts', 'new body\n', fs);
  fs.files.set('/ws/a.ts', 'new body\n');
  t.commitFsWrite('/ws/a.ts', fs);
  assert.equal(t.openCount, 0);
  const r = t.drain('quota', fs);
  assert.equal(r.fired, false);
  assert.equal(fs.files.get('/ws/a.ts'), 'new body\n');
});

test('completed tool is dropped — later quota does not touch it', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/a.ts', content: 'v1' }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', 'v1');
  t.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }), fs, CWD);
  assert.equal(t.openCount, 0);
  const r = t.drain('quota', fs);
  assert.equal(r.fired, false);
  assert.equal(fs.files.get('/ws/a.ts'), 'v1');
});

test('non-quota error does not drain (failover/other keep the file)', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/a.ts', content: 'v1' }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', 'v');
  const r = t.drain('overload', fs);
  assert.equal(r.fired, false);
  assert.equal(fs.files.get('/ws/a.ts'), 'v'); // leftover — not our path
  assert.equal(t.openCount, 0);
});

test('hooks existing classifyBackendError — 429 is quota, 529 is not', () => {
  assert.equal(classifyBackendError({ type: 'rate_limit_error', message: '429' }), 'quota');
  assert.equal(classifyBackendError('usage limit reached'), 'quota');
  assert.equal(classifyBackendError({ type: 'overloaded_error', status: 529 }), 'overload');
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  t.noteFsWriteIntent('/ws/a.ts', 'v1', fs);
  fs.files.set('/ws/a.ts', 'v');
  const quota = t.drain(classifyBackendError('429 rate_limit_error'), fs);
  assert.equal(quota.fired, true);
  assert.equal(quota.rolledBack, 1);
});

test('patch-only Edit with pre-image rolls back on quota', () => {
  const fs = memFs({ '/ws/a.ts': 'old' });
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      title: 'Edit',
      kind: 'edit',
      rawInput: { file_path: '/ws/a.ts', old_string: 'old', new_string: 'new' }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', 'ne'); // truncated replace
  const r = t.drain('quota', fs);
  assert.equal(r.rolledBack, 1);
  assert.equal(fs.files.get('/ws/a.ts'), 'old');
});

test('successful result drops in-flight leftovers (no leak into later quota)', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: '/ws/a.ts', content: 'v1' }
    }),
    fs,
    CWD
  );
  fs.files.set('/ws/a.ts', 'v1');
  t.observeUpdate({ kind: 'result', stopReason: 'end_turn' }, fs, CWD);
  assert.equal(t.openCount, 0);
  const r = t.drain('quota', fs);
  assert.equal(r.fired, false);
  assert.equal(fs.files.get('/ws/a.ts'), 'v1');
});

test('quota with no in-flight writes does not fire chip', () => {
  const fs = memFs();
  const t = tracker();
  const r = t.drain('quota', fs);
  assert.equal(r.fired, false);
  assert.equal(r.chip, null);
});

test('relative path resolves against cwd', () => {
  const fs = memFs({ '/ws/src/a.ts': 'v0' });
  const t = tracker();
  t.observeUpdate(
    toolCall({
      toolCallId: 't1',
      rawInput: { file_path: 'src/a.ts', content: 'v1' }
    }),
    fs,
    CWD
  );
  assert.equal(t.listOpen()[0]?.path, '/ws/src/a.ts');
});

test('webview reducer stores HostToWebview writeDrain chip', () => {
  const next = reduce(initialState, {
    type: 'writeDrain',
    chip: {
      available: true,
      label: WRITE_DRAIN_CHIP_LABEL,
      flushed: 0,
      rolledBack: 1,
      skipped: 0,
      paths: ['/ws/a.ts'],
      warn: true,
      hint: 'rollback 1'
    }
  });
  assert.equal(next.writeDrain?.label, WRITE_DRAIN_CHIP_LABEL);
  assert.equal(next.writeDrain?.rolledBack, 1);
  assert.equal(next.writeDrain?.warn, true);
});

test('historyLoaded clears stale writeDrain (live-only chip)', () => {
  const withChip = reduce(initialState, {
    type: 'writeDrain',
    chip: {
      available: true,
      label: WRITE_DRAIN_CHIP_LABEL,
      flushed: 1,
      rolledBack: 0,
      skipped: 0,
      paths: ['/ws/a.ts'],
      warn: false
    }
  });
  assert.equal(withChip.writeDrain?.label, WRITE_DRAIN_CHIP_LABEL);
  const cleared = reduce(withChip, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'grok',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: []
  });
  assert.equal(cleared.writeDrain, null);
});

test('writeDrain null clears the chip', () => {
  const withChip = reduce(initialState, {
    type: 'writeDrain',
    chip: {
      available: true,
      label: WRITE_DRAIN_CHIP_LABEL,
      flushed: 1,
      rolledBack: 0,
      skipped: 0,
      paths: ['/ws/a.ts'],
      warn: false
    }
  });
  const cleared = reduce(withChip, { type: 'writeDrain', chip: null });
  assert.equal(cleared.writeDrain, null);
});
