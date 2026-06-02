import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore } from '../../src/host/persistence/store';
import { exportToClaudeJsonl } from '../../src/host/persistence/jsonlExporter';
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
});
