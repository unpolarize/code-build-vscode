import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExternalReplay, type ReplayRecord, type ReplayResult } from '../../src/host/persistence/externalReplay';

const user = (text: string): ReplayRecord => ({ type: 'user', text });

const native = (records: ReplayRecord[]): ReplayResult => ({
  records,
  totals: {},
  byModel: []
});

test('pickExternalReplay prefers native JSONL when it has turns', () => {
  const n = native([user('from jsonl')]);
  const picked = pickExternalReplay(n, [user('from git store')]);
  assert.equal(picked, n);
  assert.equal(picked?.records[0] && picked.records[0].type === 'user' ? picked.records[0].text : '', 'from jsonl');
});

test('pickExternalReplay uses injected git-store records when native is missing', () => {
  const injected = [user('hello'), user('again')];
  const picked = pickExternalReplay(null, injected);
  assert.ok(picked);
  assert.equal(picked!.records.length, 2);
  assert.equal(picked!.records[0] && picked!.records[0].type === 'user' ? picked!.records[0].text : '', 'hello');
});

test('pickExternalReplay uses injected records when native file is empty', () => {
  const picked = pickExternalReplay(native([]), [user('store')]);
  assert.equal(picked?.records.length, 1);
});

test('pickExternalReplay missing both stays missing', () => {
  assert.equal(pickExternalReplay(null, null), null);
  assert.equal(pickExternalReplay(null, []), null);
});
