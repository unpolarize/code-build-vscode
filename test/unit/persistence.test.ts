import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, writeFileAtomic } from '../../src/host/persistence/store';
import {
  exportToClaudeJsonl,
  exportToMarkdown,
  exportHasTurns
} from '../../src/host/persistence/jsonlExporter';
import type { SessionMeta } from '../../src/shared/protocol';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-store-'));
}

const meta: SessionMeta = {
  id: 'sess-1',
  backend: 'claude',
  title: 'Test',
  mode: 'default',
  cwd: '/repo',
  createdAt: 1_700_000_000_000
};

test('store persists meta, user text, and updates; loads them back', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'hello');
  store.appendUpdate('sess-1', { kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  store.appendUpdate('sess-1', { kind: 'result', stopReason: 'end_turn' });

  const { meta: loadedMeta, records } = store.load('sess-1');
  assert.equal(loadedMeta?.id, 'sess-1');
  assert.equal(records.length, 3);
  assert.equal(records[0].type, 'user');
  assert.equal((records[0] as { text: string }).text, 'hello');

  const list = store.list();
  assert.equal(list[0].id, 'sess-1');
});

test('createSession alone does not index; an empty session never appears in history', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta); // opened but no prompt sent
  assert.equal(store.list().length, 0, 'empty session must not be listed');
  assert.equal(store.hasContent('sess-1'), false);
});

test('commitSession + content makes the session appear in history', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'do a thing');
  assert.equal(store.hasContent('sess-1'), true);
  assert.equal(store.list()[0].id, 'sess-1');
});

test('list() defensively hides indexed-but-empty sessions', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta); // indexed but transcript has only the meta header
  assert.equal(store.list().length, 0);
});

test('updateMeta rewrites the title in index and transcript header', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'hi');
  const retitled = { ...meta, title: 'Fix the parser bug' };
  store.updateMeta(retitled);
  assert.equal(store.list()[0].title, 'Fix the parser bug');
  assert.equal(store.load('sess-1').meta?.title, 'Fix the parser bug');
});

test('updateMeta patch RMW: title-then-bsid leaves both intact', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'hi');

  const afterTitle = store.updateMeta('sess-1', { title: 'Fix the parser bug' });
  assert.equal(afterTitle?.title, 'Fix the parser bug');
  assert.equal(afterTitle?.backendSessionId, undefined);

  const afterBsid = store.updateMeta('sess-1', {
    backendSessionId: 'native-abc',
    native: { format: 'claude-jsonl', id: 'native-abc' }
  });
  assert.equal(afterBsid?.title, 'Fix the parser bug', 'title must survive bsid patch');
  assert.equal(afterBsid?.backendSessionId, 'native-abc');
  assert.equal(afterBsid?.native?.id, 'native-abc');

  const loaded = store.load('sess-1').meta;
  assert.equal(loaded?.title, 'Fix the parser bug');
  assert.equal(loaded?.backendSessionId, 'native-abc');
  assert.equal(store.list()[0].title, 'Fix the parser bug');
  assert.equal(store.list()[0].backendSessionId, 'native-abc');
});

test('updateMeta patch RMW: bsid-then-title leaves both intact', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'hi');

  store.updateMeta('sess-1', {
    backendSessionId: 'native-xyz',
    native: { format: 'grok-jsonl', id: 'native-xyz' },
    backendSessionHistory: [
      { id: 'native-xyz', ts: 1_700_000_000_100, reason: 'initial' }
    ]
  });
  store.updateMeta('sess-1', { title: 'Retitled after bsid' });

  const loaded = store.load('sess-1').meta;
  assert.equal(loaded?.title, 'Retitled after bsid');
  assert.equal(loaded?.backendSessionId, 'native-xyz');
  assert.equal(loaded?.native?.format, 'grok-jsonl');
  assert.equal(loaded?.backendSessionHistory?.length, 1);
  assert.equal(loaded?.backendSessionHistory?.[0].id, 'native-xyz');
});

test('updateMeta full-meta RMW: stale object missing bsid does not erase disk bsid', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'seed');

  store.updateMeta('sess-1', {
    backendSessionId: 'native-keep',
    native: { format: 'claude-jsonl', id: 'native-keep' }
  });

  // Simulate a stale in-memory meta that never saw the bsid capture.
  const stale: SessionMeta = { ...meta, title: 'Stale retitle only' };
  assert.equal(stale.backendSessionId, undefined);
  store.updateMeta(stale);

  const loaded = store.load('sess-1').meta;
  assert.equal(loaded?.title, 'Stale retitle only');
  assert.equal(loaded?.backendSessionId, 'native-keep', 'disk bsid must survive stale full write');
  assert.equal(loaded?.native?.id, 'native-keep');
});

test('updateMeta interleaved with N appends loses no body lines', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);

  const N = 20;
  for (let i = 0; i < N; i++) {
    store.appendUserText('sess-1', `user-${i}`);
    store.appendUpdate('sess-1', {
      kind: 'agent_message_chunk',
      content: { type: 'text', text: `chunk-${i}` }
    });
    // Alternate patch fields so each rewrite is a real RMW.
    if (i % 2 === 0) {
      store.updateMeta('sess-1', { title: `title-${i}` });
    } else {
      store.updateMeta('sess-1', {
        backendSessionId: `native-${i}`,
        native: { format: 'claude-jsonl', id: `native-${i}` }
      });
    }
  }

  const { meta: loaded, records } = store.load('sess-1');
  assert.equal(records.length, N * 2, 'every user + update line must survive meta rewrites');
  for (let i = 0; i < N; i++) {
    assert.equal(records[i * 2].type, 'user');
    assert.equal((records[i * 2] as { text: string }).text, `user-${i}`);
    assert.equal(records[i * 2 + 1].type, 'update');
  }
  // Last even title patch was i=N-2 if N even, or last odd leaves prior title.
  assert.equal(loaded?.title, `title-${N - 2}`);
  assert.equal(loaded?.backendSessionId, `native-${N - 1}`);
  assert.equal(loaded?.native?.id, `native-${N - 1}`);
});

test('exporter produces Claude-style turn JSONL Code Sessions can read', () => {
  const records = [
    { type: 'user', text: 'build X' },
    { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'done' } } as const },
    { type: 'update', update: { kind: 'result', stopReason: 'end_turn', usage: { costUsd: 0.01 } } as const }
  ];
  const jsonl = exportToClaudeJsonl(meta, records as never);
  const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'summary');
  assert.equal(lines[0].source, 'code-build');
  assert.equal(lines[1].type, 'user');
  assert.equal(lines[1].message.content[0].text, 'build X');
  assert.equal(lines[2].type, 'assistant');
  assert.equal(lines[3].type, 'result');
  assert.equal(lines[3].total_cost_usd, 0.01);
  assert.ok(jsonl.trim().length > 0);
  assert.equal(exportHasTurns(records as never), true);
  assert.equal(exportHasTurns([]), false);
});

// Dual-write identity (CROSS-LINK.md): summary fields are additive only.
test('exporter summary omits backendSessionId/native when absent (no null spam)', () => {
  const records = [{ type: 'user', text: 'hi' }];
  const jsonl = exportToClaudeJsonl(meta, records as never);
  // Golden: pre-dual-write shape — key order and absence of null fields.
  assert.equal(
    jsonl,
    [
      JSON.stringify({
        type: 'summary',
        sessionId: 'sess-1',
        source: 'code-build',
        backend: 'claude',
        cwd: '/repo',
        timestamp: new Date(1_700_000_000_000).toISOString()
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      }),
      ''
    ].join('\n')
  );
  const summary = JSON.parse(jsonl.trim().split('\n')[0]);
  assert.equal('backendSessionId' in summary, false);
  assert.equal('native' in summary, false);
  assert.equal(summary.backendSessionId, undefined);
  assert.equal(summary.native, undefined);
});

test('exporter summary includes backendSessionId + native when present', () => {
  const withId: SessionMeta = {
    ...meta,
    backendSessionId: 'native-abc',
    native: { format: 'claude-jsonl', id: 'native-abc' }
  };
  const records = [{ type: 'user', text: 'hi' }];
  const jsonl = exportToClaudeJsonl(withId, records as never);
  const summary = JSON.parse(jsonl.trim().split('\n')[0]);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.sessionId, 'sess-1');
  assert.equal(summary.backendSessionId, 'native-abc');
  assert.deepEqual(summary.native, { format: 'claude-jsonl', id: 'native-abc' });
  // Golden full first line (additive keys after the stable prefix).
  assert.equal(
    jsonl.split('\n')[0],
    JSON.stringify({
      type: 'summary',
      sessionId: 'sess-1',
      source: 'code-build',
      backend: 'claude',
      cwd: '/repo',
      timestamp: new Date(1_700_000_000_000).toISOString(),
      backendSessionId: 'native-abc',
      native: { format: 'claude-jsonl', id: 'native-abc' }
    })
  );
});

test('exporter summary includes backendSessionId alone when native is unset', () => {
  // Unmapped backends (opencode/cline) track id/history but no native pointer.
  const withBsidOnly: SessionMeta = {
    ...meta,
    backend: 'opencode' as SessionMeta['backend'],
    backendSessionId: 'native-only'
  };
  const summary = JSON.parse(exportToClaudeJsonl(withBsidOnly, []).trim().split('\n')[0]);
  assert.equal(summary.backendSessionId, 'native-only');
  assert.equal('native' in summary, false);
});

test('markdown exporter renders user/assistant turns in order and coalesces chunks', () => {
  const records = [
    { type: 'user', text: 'build X' },
    {
      type: 'update',
      update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'part1 ' } } as const
    },
    {
      type: 'update',
      update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'part2' } } as const
    },
    { type: 'update', update: { kind: 'result', stopReason: 'end_turn' } as const },
    { type: 'user', text: 'next' },
    {
      type: 'update',
      update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } as const
    }
  ];
  const md = exportToMarkdown(meta, records as never);
  assert.match(md, /^# Test/m);
  assert.match(md, /\*\*User:\*\*\n\nbuild X/);
  assert.match(md, /\*\*Assistant:\*\*\n\npart1 part2/);
  assert.match(md, /\*\*User:\*\*\n\nnext/);
  assert.match(md, /\*\*Assistant:\*\*\n\nreply/);
  // role order: user before assistant before next user
  const iUser1 = md.indexOf('build X');
  const iAsst1 = md.indexOf('part1 part2');
  const iUser2 = md.indexOf('next');
  const iAsst2 = md.indexOf('reply');
  assert.ok(iUser1 < iAsst1 && iAsst1 < iUser2 && iUser2 < iAsst2);
});

test('writeFileAtomic replaces target and leaves no .tmp behind', () => {
  const dir = tmpRoot();
  const target = path.join(dir, 'index.json');
  fs.writeFileSync(target, JSON.stringify([{ id: 'old' }]));
  writeFileAtomic(target, JSON.stringify([{ id: 'new' }], null, 2));
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8'))[0].id, 'new');
  assert.equal(fs.existsSync(`${target}.tmp`), false);
});

test('writeFileAtomic crash window: prior file survives when rename never happens', () => {
  const dir = tmpRoot();
  const target = path.join(dir, 'index.json');
  const prior = JSON.stringify([{ id: 'prior-session', title: 'safe' }], null, 2);
  fs.writeFileSync(target, prior);
  // Simulate crash after tmp write, before rename: both files coexist.
  fs.writeFileSync(`${target}.tmp`, 'CORRUPT{{{not-json');
  const still = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(still[0].id, 'prior-session');
  assert.equal(still[0].title, 'safe');
});

test('SessionStore init cleans orphan .tmp next to index and transcripts', () => {
  const root = tmpRoot();
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const indexTmp = path.join(root, 'index.json.tmp');
  const transcriptTmp = path.join(sessionsDir, 'sess-1.jsonl.tmp');
  const perfTmp = path.join(sessionsDir, 'sess-1.perf.json.tmp');
  fs.writeFileSync(indexTmp, 'orphan-index');
  fs.writeFileSync(transcriptTmp, 'orphan-transcript');
  fs.writeFileSync(perfTmp, 'orphan-perf');
  // Keep a real index so list() has something to parse after cleanup.
  fs.writeFileSync(path.join(root, 'index.json'), '[]');

  new SessionStore(root);

  assert.equal(fs.existsSync(indexTmp), false);
  assert.equal(fs.existsSync(transcriptTmp), false);
  assert.equal(fs.existsSync(perfTmp), false);
  assert.equal(fs.existsSync(path.join(root, 'index.json')), true);
});

test('atomic index upsert: store commits leave parseable index.json (no bare writeFileSync)', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'seed');
  store.updateMeta('sess-1', { title: 'Atomic title' });
  store.writePerfExport('sess-1', { ok: true });

  const indexPath = path.join(store.getRoot(), 'index.json');
  const transcriptPath = store.transcriptPath('sess-1');
  const perfPath = path.join(store.getRoot(), 'sessions', 'sess-1.perf.json');

  assert.equal(fs.existsSync(`${indexPath}.tmp`), false);
  assert.equal(fs.existsSync(`${transcriptPath}.tmp`), false);
  assert.equal(fs.existsSync(`${perfPath}.tmp`), false);

  const indexed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as SessionMeta[];
  assert.equal(indexed[0].id, 'sess-1');
  assert.equal(indexed[0].title, 'Atomic title');
  assert.equal(store.load('sess-1').meta?.title, 'Atomic title');
  assert.deepEqual(JSON.parse(fs.readFileSync(perfPath, 'utf8')), { ok: true });
});

test('compact marker round-trips: order preserved between the two segments', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.commitSession(meta);
  store.appendUserText('sess-1', 'long conversation');
  store.appendUpdate('sess-1', { kind: 'agent_message_chunk', content: { type: 'text', text: 'reply' } });
  store.appendCompactMarker('sess-1', {
    at: 1_700_000_100_000,
    preTokens: 150_000,
    summaryPreview: 'Goal: ship the thing…',
    instructions: 'focus on the migration'
  });
  store.appendUserText('sess-1', 'post-compact prompt');

  const { records } = store.load('sess-1');
  assert.deepEqual(
    records.map((r) => r.type),
    ['user', 'update', 'compact', 'user']
  );
  const marker = (records[2] as { marker: { at: number; preTokens?: number; summaryPreview: string; instructions?: string } }).marker;
  assert.equal(marker.at, 1_700_000_100_000);
  assert.equal(marker.preTokens, 150_000);
  assert.equal(marker.summaryPreview, 'Goal: ship the thing…');
  assert.equal(marker.instructions, 'focus on the migration');
});

test('compact marker alone is not content', () => {
  const store = new SessionStore(tmpRoot());
  store.createSession(meta);
  store.appendCompactMarker('sess-1', { at: 1, summaryPreview: '' });
  assert.equal(store.hasContent('sess-1'), false);
});
