/**
 * Child process: parse a JSONL transcript and send batches over IPC.
 * Must not import vscode. Host forks dist/transcriptWorker.js.
 */
import { replayTranscriptFile, type ReplayEvent } from './transcriptReplay';

const filePath = process.argv[2];
if (!filePath) {
  process.send?.({ type: 'error', message: 'transcriptWorker: missing path' } satisfies ReplayEvent);
  process.exit(2);
}

let unlock: (() => void) | undefined;
function waitForMore(): Promise<void> {
  return new Promise((resolve) => {
    unlock = resolve;
  });
}

process.on('message', (msg: { type?: string }) => {
  if (msg && msg.type === 'more') unlock?.();
});

replayTranscriptFile(filePath, async (ev) => {
  process.send?.(ev);
  if (ev.type === 'batch') await waitForMore();
})
  .then(() => process.exit(0))
  .catch((e) => {
    process.send?.({
      type: 'error',
      message: e instanceof Error ? e.message : String(e)
    } satisfies ReplayEvent);
    process.exit(1);
  });
