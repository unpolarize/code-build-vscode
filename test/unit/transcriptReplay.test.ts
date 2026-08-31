import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  replayTranscriptFile,
  type ReplayEvent,
  type ReplayRecord
} from '../../src/host/persistence/transcriptReplay';

function tmpJsonl(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-replay-'));
  const p = path.join(dir, 's.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('replayTranscriptFile skips meta, batches records, keeps last N', async () => {
  const lines = [
    JSON.stringify({ type: 'meta', meta: { id: 's' } }),
    ...Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: 'user', text: `u${i}` }))
  ];
  const events: ReplayEvent[] = [];
  await replayTranscriptFile(tmpJsonl(lines), (ev) => {
    events.push(ev);
  }, { batchSize: 3 });
  assert.equal(events[0]?.type, 'progress');
  const batches = events.filter((e): e is Extract<ReplayEvent, { type: 'batch' }> => e.type === 'batch');
  const texts = batches.flatMap((b) => b.records.map((r) => (r as { text?: string }).text));
  assert.deepEqual(texts, Array.from({ length: 10 }, (_, i) => `u${i}`));
  const done = events.at(-1);
  assert.equal(done?.type, 'done');
  if (done?.type === 'done') {
    assert.equal(done.recordCount, 10);
    assert.equal((done.lastRecords.at(-1) as { text?: string }).text, 'u9');
  }
});

test('replayTranscriptFile empty file emits progress then done', async () => {
  const p = tmpJsonl([]);
  fs.writeFileSync(p, '');
  const types: string[] = [];
  await replayTranscriptFile(p, (ev) => {
    types.push(ev.type);
  });
  assert.deepEqual(types, ['progress', 'done']);
});

test('replayTranscriptFile skips corrupt lines', async () => {
  const p = tmpJsonl([
    JSON.stringify({ type: 'user', text: 'ok' }),
    'not-json',
    JSON.stringify({ type: 'user', text: 'ok2' })
  ]);
  const recs: ReplayRecord[] = [];
  await replayTranscriptFile(p, (ev) => {
    if (ev.type === 'batch') recs.push(...ev.records);
  }, { batchSize: 10 });
  assert.deepEqual(
    recs.map((r) => (r as { text?: string }).text),
    ['ok', 'ok2']
  );
});
