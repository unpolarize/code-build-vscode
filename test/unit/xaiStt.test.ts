import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XaiTranscriptAccumulator, xaiSttUrl } from '../../src/host/voice/xaiStt';

function collect() {
  const events: { interim: string[]; finals: string[]; errors: string[]; done: boolean } = {
    interim: [],
    finals: [],
    errors: [],
    done: false
  };
  const acc = new XaiTranscriptAccumulator({
    onInterim: (t) => events.interim.push(t),
    onFinal: (t) => events.finals.push(t),
    onError: (m) => events.errors.push(m),
    onDone: () => (events.done = true)
  });
  return { acc, events };
}

const partial = (start: number, text: string, isFinal = false) =>
  JSON.stringify({ type: 'transcript.partial', start, text, is_final: isFinal });

test('partials are cumulative per segment — last write wins, never append', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'hello'));
  acc.handleMessage(partial(0.1, 'hello world'));
  acc.handleMessage(partial(0.1, 'hello world again'));
  assert.equal(events.interim.at(-1), 'hello world again');
  assert.equal(acc.transcript, 'hello world again');
  assert.deepEqual(events.finals, []);
});

test('is_final emitted twice with identical text produces one final chunk', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'first utterance'));
  acc.handleMessage(partial(0.1, 'first utterance', true));
  acc.handleMessage(partial(0.1, 'first utterance', true)); // speech_final duplicate
  assert.deepEqual(events.finals, ['first utterance']);
});

test('interim empties never wipe recorded text', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'keep me'));
  acc.handleMessage(partial(0.1, '   '));
  assert.equal(acc.transcript, 'keep me');
  assert.equal(events.errors.length, 0);
});

test('multiple segments stream as separate final chunks', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'segment one', true));
  acc.handleMessage(partial(2.5, 'segment'));
  acc.handleMessage(partial(2.5, 'segment two', true));
  assert.deepEqual(events.finals, ['segment one', 'segment two']);
  assert.equal(acc.transcript, 'segment one segment two');
});

test('transcript.done flushes open segments and completes', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'tail text'));
  acc.handleMessage(JSON.stringify({ type: 'transcript.done', text: '' }));
  assert.deepEqual(events.finals, ['tail text']);
  assert.equal(events.done, true);
});

test('transcript.done consolidated text is used only when nothing streamed', () => {
  const { acc, events } = collect();
  acc.handleMessage(JSON.stringify({ type: 'transcript.done', text: 'server says all' }));
  assert.deepEqual(events.finals, ['server says all']);
  assert.equal(events.done, true);

  const second = collect();
  second.acc.handleMessage(partial(0.1, 'already streamed', true));
  second.acc.handleMessage(JSON.stringify({ type: 'transcript.done', text: 'already streamed' }));
  assert.deepEqual(second.events.finals, ['already streamed']); // no duplicate
});

test('flushOpen emits remaining text once and is idempotent', () => {
  const { acc, events } = collect();
  acc.handleMessage(partial(0.1, 'unfinished'));
  acc.flushOpen();
  acc.flushOpen();
  assert.deepEqual(events.finals, ['unfinished']);
});

test('error messages surface via onError', () => {
  const { acc, events } = collect();
  acc.handleMessage(JSON.stringify({ type: 'error', message: 'boom' }));
  assert.deepEqual(events.errors, ['boom']);
});

test('malformed json and unknown types are ignored', () => {
  const { acc, events } = collect();
  acc.handleMessage('not json');
  acc.handleMessage(JSON.stringify({ type: 'transcript.created', id: 'x' }));
  assert.equal(events.errors.length, 0);
  assert.equal(acc.transcript, '');
});

test('xaiSttUrl carries Quill query params and primary language subtag', () => {
  assert.equal(
    xaiSttUrl('en-US'),
    'wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true&language=en'
  );
  assert.ok(!xaiSttUrl('auto').includes('language'));
  assert.ok(!xaiSttUrl('').includes('language'));
});
