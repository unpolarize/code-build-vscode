// Live end-to-end check of the xai STT engine — NOT part of test:unit.
// Synthesizes speech with macOS `say`, converts to 16 kHz mono PCM16, streams
// it to wss://api.x.ai/v1/stt with the grok CLI credential, and prints the
// transcript events. Run: npx tsx test/manual/xaiSttLive.ts ["phrase"]
//
// Verifies: grokAuth token resolution, socket auth, Quill wire protocol,
// XaiTranscriptAccumulator segmentation — everything except the mic helper.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { resolveXaiCreds, isExpired } from '../../src/host/voice/grokAuth';
import { XaiTranscriptAccumulator, xaiSttUrl } from '../../src/host/voice/xaiStt';

const phrase = process.argv[2] ?? 'hello world, this is a code build voice input test';

const creds = resolveXaiCreds({ env: process.env });
if (!creds) {
  console.error('No xAI credential: log into the grok CLI or set XAI_API_KEY.');
  process.exit(1);
}
if (isExpired(creds)) {
  console.error('Grok session expired — open grok once to refresh.');
  process.exit(1);
}
console.log(`creds: ${creds.source}${creds.email ? ` (${creds.email})` : ''}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-stt-live-'));
const aiff = path.join(dir, 'x.aiff');
const wav = path.join(dir, 'x.wav');
execFileSync('say', ['-o', aiff, phrase]);
execFileSync('afconvert', [aiff, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', wav]);
const pcm = fs.readFileSync(wav).subarray(44); // strip WAVE header
console.log(`audio: ${pcm.length} bytes PCM16 @16kHz (~${(pcm.length / 32000).toFixed(1)}s)`);

const finals: string[] = [];
let done = false;
const acc = new XaiTranscriptAccumulator({
  onInterim: (t) => console.log(`  interim: ${t}`),
  onFinal: (t) => {
    finals.push(t);
    console.log(`  FINAL:   ${t}`);
  },
  onError: (m) => {
    console.error(`  server error: ${m}`);
    process.exitCode = 1;
  },
  onDone: () => {
    done = true;
    finish('transcript.done');
  }
});

const ws = new WebSocket(xaiSttUrl('en-US'), {
  headers: { Authorization: `Bearer ${creds.token}` },
  handshakeTimeout: 20_000
});

const overall = setTimeout(() => finish('timeout after 30s'), 30_000);

ws.on('open', () => {
  console.log('socket open — streaming audio');
  // 3200 bytes = 100ms of 16kHz PCM16; pace roughly realtime/4.
  let off = 0;
  const tick = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(tick);
      ws.send('{"type":"audio.done"}');
      console.log('audio.done sent — waiting for tail');
      return;
    }
    ws.send(pcm.subarray(off, off + 12800));
    off += 12800;
  }, 100);
});
ws.on('message', (d) => acc.handleMessage(d.toString()));
ws.on('unexpected-response', (_r, res) => {
  console.error(`HTTP ${res.statusCode} — auth rejected?`);
  process.exit(1);
});
ws.on('error', (e) => {
  if (!done && !acc.transcript) {
    console.error(`socket error: ${e.message}`);
    process.exit(1);
  }
});
ws.on('close', (code) => {
  if (!done) finish(`socket closed (${code})`);
});

function finish(reason: string) {
  clearTimeout(overall);
  acc.flushOpen();
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  const transcript = finals.join(' ');
  console.log(`\nreason: ${reason}\ntranscript: "${transcript}"`);
  const gotIt = /hello world/i.test(transcript);
  console.log(gotIt ? 'PASS — transcript matches phrase' : 'FAIL — expected phrase not found');
  process.exit(gotIt ? 0 : 1);
}
