import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Span,
  formatTraceHuman,
  initTrace,
  recentTraces,
  resetTraceForTests,
  startFileSink,
  getHostTask
} from '../../src/host/hostTrace';

describe('hostTrace', () => {
  beforeEach(() => {
    resetTraceForTests();
    initTrace('cb', '0.19.0');
  });

  it('records mark deltas and tags SLOW when over budget', () => {
    let t = 1_000;
    const s = new Span('cb.newConversation', 'abcd', () => t);
    t = 1_018;
    s.mark('panel');
    t = 1_258;
    s.mark('webview.ready');
    t = 6_123;
    const total = s.end();
    assert.equal(total, 5123);
    const ev = recentTraces();
    assert.equal(ev[0]?.t, 'start');
    assert.equal(ev[0]?.name, 'cb.newConversation');
    const done = ev[ev.length - 1];
    assert.equal(done?.t, 'end');
    assert.equal(done?.slow, true);
    assert.equal(done?.marks?.[0]?.name, 'panel');
    assert.equal(done?.marks?.[0]?.durMs, 18);
    const human = formatTraceHuman(done!);
    assert.match(human, /DONE cb.newConversation 5123ms SLOW/);
    assert.match(human, /panel:18/);
    assert.match(human, /webview.ready:240/);
  });

  it('tracks last-started task for lag STALL lines', () => {
    const s = new Span('cb.newConversation', 'x', () => 0);
    assert.equal(getHostTask(), 'cb.newConversation');
    s.mark('hydrate.detectAll');
    assert.equal(getHostTask(), 'cb.newConversation.hydrate.detectAll');
    s.end();
    assert.equal(getHostTask(), '');
  });

  it('appends JSON to the file sink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-trace-'));
    const path = join(dir, 'host-trace.ndjson');
    const stop = startFileSink(path, 1024);
    const s = new Span('cb.activate', 'zz', () => 5);
    s.end();
    await new Promise((r) => setTimeout(r, 40));
    const raw = await readFile(path, 'utf8');
    assert.match(raw, /"name":"cb.activate"/);
    assert.match(raw, /"t":"end"/);
    stop();
  });

  it('rotates when the file exceeds maxBytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-trace-'));
    const path = join(dir, 'host-trace.ndjson');
    await writeFile(path, 'x'.repeat(200));
    const stop = startFileSink(path, 50);
    new Span('cb.activate', 'yy', () => 1); // one append → rotate then write
    await new Promise((r) => setTimeout(r, 40));
    const prev = await readFile(`${path}.prev`, 'utf8');
    assert.equal(prev.length, 200);
    stop();
  });
});
