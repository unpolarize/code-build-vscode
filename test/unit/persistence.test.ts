import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../../src/host/persistence/store';
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
