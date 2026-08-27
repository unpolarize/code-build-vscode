// Fixture-stream tests for the write-checkpoint timeline (kp:
// ideas/cb-host-write-checkpoint-timeline-snapshot-acp-w). Pure — injected
// in-memory CheckpointFs, no VS Code, no disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WriteCheckpointEngine,
  extractCheckpointPaths,
  isCheckpointEditClass,
  type CheckpointFs
} from '../../src/host/writeCheckpoint';
import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';

const CWD = '/ws';
const DIR = '/ckpt';

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: CheckpointFs & { files: Map<string, string> } = {
    files,
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => void files.set(p, c),
    deleteFile: (p) => void files.delete(p),
    appendFile: (p, t) => void files.set(p, (files.get(p) ?? '') + t),
    fileKind: (p) => (files.has(p) ? 'file' : 'missing')
    // no realpath — normalizePathKey degrades to path.resolve, keys stay literal
  };
  return fs;
}

function engine(fs: CheckpointFs, extra: Partial<ConstructorParameters<typeof WriteCheckpointEngine>[0]> = {}) {
  return new WriteCheckpointEngine({ dir: DIR, cwd: CWD, fs, now: () => 1_700_000_000_000, ...extra });
}

function toolCall(tc: Partial<ToolCall> & { toolCallId: string }): SessionUpdate {
  return { kind: 'tool_call', toolCall: { title: 'Edit', status: 'pending', kind: 'edit', ...tc } as ToolCall };
}

function toolUpdate(tc: Partial<ToolCall> & { toolCallId: string }): SessionUpdate {
  return { kind: 'tool_call_update', toolCall: tc };
}

test('grok flow: pending → fs/write → completed captures the pre-image; restore reverts', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'a.ts' }] }));
  e.onFsWrite('/ws/a.ts'); // bridge hook fires; path already captured at pending
  fs.files.set('/ws/a.ts', 'v1'); // the agent's write lands
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));

  assert.deepEqual(e.listCheckpointIds(), ['t1']);
  const res = e.restore('t1');
  assert.ok(res);
  assert.equal(res.written, 1);
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
});

test('write-then-announce: fs/write stages the pre-image before any tool_call names the path', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs);
  e.onFsWrite('/ws/a.ts'); // no open tool yet — staged
  fs.files.set('/ws/a.ts', 'v1');
  // tool_call arrives already completed, naming the path — disk is post-image
  e.observeUpdate(toolCall({ toolCallId: 't1', status: 'completed', locations: [{ path: 'a.ts' }] }));

  assert.deepEqual(e.listCheckpointIds(), ['t1']);
  e.restore('t1');
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
});

test('Write-new: null pre-image → restore deletes the created file', () => {
  const fs = memFs();
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', kind: 'write', rawInput: { file_path: 'new.ts', content: 'x' } }));
  fs.files.set('/ws/new.ts', 'x');
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));

  assert.deepEqual(e.listCheckpointIds(), ['t1']);
  const res = e.restore('t1');
  assert.ok(res);
  assert.equal(res.deleted, 1);
  assert.equal(fs.files.has('/ws/new.ts'), false);
});

test('version chain: two edits to one file restore to either point', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'a.ts' }] }));
  fs.files.set('/ws/a.ts', 'v1');
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));
  e.observeUpdate(toolCall({ toolCallId: 't2', locations: [{ path: 'a.ts' }] }));
  fs.files.set('/ws/a.ts', 'v2');
  e.observeUpdate(toolUpdate({ toolCallId: 't2', status: 'completed' }));

  assert.deepEqual(e.listCheckpointIds(), ['t1', 't2']);
  e.restore('t2');
  assert.equal(fs.files.get('/ws/a.ts'), 'v1');
  // Timeline semantics: restoring to t1 uses the EARLIEST pre-image ≥ t1.
  fs.files.set('/ws/a.ts', 'v2');
  e.restore('t1');
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
});

test('paths arriving only on tool_call_update are merged by toolCallId before capture', () => {
  const fs = memFs({ '/ws/late.ts': 'v0' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', kind: undefined, title: 'mystery' }));
  // update brings kind + paths while still pending — capture happens HERE
  e.observeUpdate(
    toolUpdate({ toolCallId: 't1', kind: 'edit', status: 'in_progress', locations: [{ path: 'late.ts' }] })
  );
  fs.files.set('/ws/late.ts', 'v1');
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));

  assert.deepEqual(e.listCheckpointIds(), ['t1']);
  e.restore('t1');
  assert.equal(fs.files.get('/ws/late.ts'), 'v0');
});

test('codex kind:edit with full changes[].old diff: oldText is the trusted pre-image', () => {
  // Codex writes to disk itself; the tool_call lands completed with the diff.
  const fs = memFs({ '/ws/a.ts': 'v1' });
  const e = engine(fs, { trustDiffOldText: true });
  e.observeUpdate(
    toolCall({
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'v0', newText: 'v1' }]
    })
  );
  assert.deepEqual(e.listCheckpointIds(), ['c1']);
  e.restore('c1');
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
});

test('claude race: first sight at completed without a trusted source is degraded, not invented', () => {
  // Claude stream-json wrote the file itself; the synthesized diff oldText is
  // a fragment and must NOT be trusted; disk already holds the post-image.
  const fs = memFs({ '/ws/a.ts': 'POST' });
  const e = engine(fs); // trustDiffOldText: false
  e.observeUpdate(
    toolCall({
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'diff', path: 'a.ts', oldText: 'fragment', newText: 'POST' }]
    })
  );
  // degraded-only entry → no false restore target
  assert.deepEqual(e.listCheckpointIds(), []);
  assert.equal(e.restore('t1'), null);
  assert.equal(fs.files.get('/ws/a.ts'), 'POST');
});

test('failed tool calls are not restore targets', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'a.ts' }] }));
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'failed' }));
  assert.deepEqual(e.listCheckpointIds(), []);
});

test('all captures skipped (binary/oversize) → no entry at all', () => {
  const fs = memFs({ '/ws/bin.dat': 'a\0b' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'bin.dat' }] }));
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));
  assert.deepEqual(e.listCheckpointIds(), []);
});

test('ring cap: oldest entry dropped, orphan blob GC-ed, index rewritten', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs, { maxEntries: 2 });
  for (let i = 1; i <= 3; i++) {
    e.observeUpdate(toolCall({ toolCallId: `t${i}`, locations: [{ path: 'a.ts' }] }));
    fs.files.set('/ws/a.ts', `v${i}`);
    e.observeUpdate(toolUpdate({ toolCallId: `t${i}`, status: 'completed' }));
  }
  assert.deepEqual(e.listCheckpointIds(), ['t2', 't3']);
  // t1's pre-image blob ('v0') is orphaned and must be deleted.
  const blobContents = [...fs.files.entries()]
    .filter(([p]) => p.startsWith(`${DIR}/`) && !p.endsWith('index.ndjson'))
    .map(([, c]) => c)
    .sort();
  assert.deepEqual(blobContents, ['v1', 'v2']);
  const indexLines = (fs.files.get(`${DIR}/index.ndjson`) ?? '').trim().split('\n');
  assert.equal(indexLines.length, 2);
});

test('restore skips out-of-root paths via confine and counts them', () => {
  const fs = memFs({ '/ws/in.ts': 'v0', '/etc/out.conf': 'v0' });
  const e = engine(fs, {
    confine: (p) => {
      if (!p.startsWith('/ws/')) throw new Error('escape');
      return p;
    }
  });
  e.observeUpdate(
    toolCall({ toolCallId: 't1', locations: [{ path: '/ws/in.ts' }, { path: '/etc/out.conf' }] })
  );
  fs.files.set('/ws/in.ts', 'v1');
  fs.files.set('/etc/out.conf', 'v1');
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));

  const res = e.restore('t1');
  assert.ok(res);
  assert.equal(res.written, 1);
  assert.equal(res.skipped, 1);
  assert.equal(fs.files.get('/ws/in.ts'), 'v0');
  assert.equal(fs.files.get('/etc/out.conf'), 'v1'); // untouched
});

test('index + blobs persist: a fresh engine over the same dir restores', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e1 = engine(fs);
  e1.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'a.ts' }] }));
  fs.files.set('/ws/a.ts', 'v1');
  e1.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));

  const e2 = engine(fs); // reload from index.ndjson
  assert.deepEqual(e2.listCheckpointIds(), ['t1']);
  e2.restore('t1');
  assert.equal(fs.files.get('/ws/a.ts'), 'v0');
});

test('turn end drops never-completed tools and stale staged pre-images', () => {
  const fs = memFs({ '/ws/a.ts': 'v0' });
  const e = engine(fs);
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: 'a.ts' }] }));
  e.onFsWrite('/ws/other.ts');
  e.observeUpdate({ kind: 'result', stopReason: 'end_turn' });
  assert.deepEqual(e.listCheckpointIds(), []);
  // a completed tool in the NEXT turn must not consume last turn's staged read
  fs.files.set('/ws/other.ts', 'v1');
  e.observeUpdate(toolCall({ toolCallId: 't2', status: 'completed', locations: [{ path: 'other.ts' }] }));
  assert.deepEqual(e.listCheckpointIds(), []); // degraded (no staged source) → no target
});

test('bypass-mode captures still happen; out-of-root restore stays confined (documented behavior)', () => {
  // Capture is mode-independent: the engine snapshots whatever path the
  // stream names. Restore is where confinement applies (skip + count).
  const fs = memFs({ '/etc/out.conf': 'v0' });
  const e = engine(fs, {
    confine: (p) => {
      if (!p.startsWith('/ws/')) throw new Error('escape');
      return p;
    }
  });
  e.observeUpdate(toolCall({ toolCallId: 't1', locations: [{ path: '/etc/out.conf' }] }));
  fs.files.set('/etc/out.conf', 'v1');
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));
  assert.deepEqual(e.listCheckpointIds(), ['t1']); // snapshot exists…
  const res = e.restore('t1');
  assert.ok(res);
  assert.equal(res.skipped, 1); // …but restore never escapes the root
  assert.equal(fs.files.get('/etc/out.conf'), 'v1');
});

test('unreadable existing file never stages a null pre-image (restore must not delete it)', () => {
  const fs = memFs({ '/ws/locked.ts': 'v0' });
  const readFile = fs.readFile.bind(fs);
  fs.readFile = (p) => (p === '/ws/locked.ts' ? null : readFile(p)); // EACCES-style
  const e = engine(fs);
  e.onFsWrite('/ws/locked.ts'); // exists but unreadable — must NOT stage null
  fs.files.set('/ws/locked.ts', 'v1');
  e.observeUpdate(toolCall({ toolCallId: 't1', status: 'completed', locations: [{ path: 'locked.ts' }] }));
  // degraded-only → no restore target; the file is never deletable via restore
  assert.deepEqual(e.listCheckpointIds(), []);
  assert.equal(fs.files.get('/ws/locked.ts'), 'v1');
});

test('codex empty oldText is ambiguous (new vs empty file) — degraded, never delete-on-restore', () => {
  const fs = memFs({ '/ws/was-empty.ts': 'v1' });
  const e = engine(fs, { trustDiffOldText: true });
  e.observeUpdate(
    toolCall({
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'diff', path: 'was-empty.ts', oldText: '', newText: 'v1' }]
    })
  );
  assert.deepEqual(e.listCheckpointIds(), []);
  assert.equal(fs.files.get('/ws/was-empty.ts'), 'v1');
});

test('planRestorePaths applies confinement so the confirm modal never overlists', () => {
  const fs = memFs({ '/ws/in.ts': 'v0', '/etc/out.conf': 'v0' });
  const e = engine(fs, {
    confine: (p) => {
      if (!p.startsWith('/ws/')) throw new Error('escape');
      return p;
    }
  });
  e.observeUpdate(
    toolCall({ toolCallId: 't1', locations: [{ path: '/ws/in.ts' }, { path: '/etc/out.conf' }] })
  );
  e.observeUpdate(toolUpdate({ toolCallId: 't1', status: 'completed' }));
  assert.deepEqual(e.planRestorePaths('t1'), ['/ws/in.ts']);
});

test('extractCheckpointPaths unions diff paths, locations and rawInput keys', () => {
  const tc = {
    toolCallId: 'x',
    title: 'MultiEdit',
    status: 'pending',
    kind: 'edit',
    content: [{ type: 'diff', path: 'd.ts', oldText: '', newText: 'n' }],
    locations: [{ path: 'l.ts' }],
    rawInput: { file_path: 'r.ts', notebook_path: 'n.ipynb' }
  } as ToolCall;
  assert.deepEqual(extractCheckpointPaths(tc).sort(), ['d.ts', 'l.ts', 'n.ipynb', 'r.ts']);
  assert.equal(isCheckpointEditClass(tc), true);
  assert.equal(isCheckpointEditClass({ toolCallId: 'y', title: 'Bash', status: 'pending', kind: 'execute' } as ToolCall), false);
});
