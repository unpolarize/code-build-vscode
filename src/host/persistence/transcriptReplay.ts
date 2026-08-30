/**
 * Stream a JSONL transcript off the extension-host thread.
 * The worker (child process) calls this; tests call it in-process.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';

export const REPLAY_BATCH_SIZE = 80;
export const REPLAY_LAST_KEEP = 40;

export type ReplayRecord = { type: string; [k: string]: unknown };

export type ReplayEvent =
  | { type: 'progress'; bytesRead: number; bytesTotal: number; recordCount: number }
  | {
      type: 'batch';
      records: ReplayRecord[];
      bytesRead: number;
      bytesTotal: number;
      recordCount: number;
    }
  | {
      type: 'done';
      recordCount: number;
      bytesTotal: number;
      lastRecords: ReplayRecord[];
    }
  | { type: 'error'; message: string };

export async function replayTranscriptFile(
  filePath: string,
  emit: (ev: ReplayEvent) => void | Promise<void>,
  opts?: { batchSize?: number }
): Promise<void> {
  const batchSize = opts?.batchSize ?? REPLAY_BATCH_SIZE;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    await emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  const bytesTotal = st.size;
  await emit({ type: 'progress', bytesRead: 0, bytesTotal, recordCount: 0 });
  if (bytesTotal === 0) {
    await emit({ type: 'done', recordCount: 0, bytesTotal, lastRecords: [] });
    return;
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let batch: ReplayRecord[] = [];
  let recordCount = 0;
  const last: ReplayRecord[] = [];
  const pushLast = (rec: ReplayRecord) => {
    last.push(rec);
    if (last.length > REPLAY_LAST_KEEP) last.shift();
  };

  const flush = async () => {
    if (batch.length === 0) return;
    const records = batch;
    batch = [];
    await emit({
      type: 'batch',
      records,
      bytesRead: stream.bytesRead,
      bytesTotal,
      recordCount
    });
  };

  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec: ReplayRecord;
      try {
        rec = JSON.parse(line) as ReplayRecord;
      } catch {
        continue;
      }
      if (!rec || typeof rec.type !== 'string' || rec.type === 'meta') continue;
      batch.push(rec);
      pushLast(rec);
      recordCount += 1;
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    await emit({ type: 'done', recordCount, bytesTotal, lastRecords: last });
  } catch (e) {
    await emit({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    rl.close();
    stream.destroy();
  }
}
