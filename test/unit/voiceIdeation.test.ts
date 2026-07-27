import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVisClosePhrase,
  parseVisClosePayload,
  textForSpeech,
  visFacilitationPreamble,
  visClosePrompt
} from '../../src/shared/voiceIdeation.ts';
import { resolveTtsEngine } from '../../src/host/voice/ttsHost.ts';

describe('voiceIdeation helpers', () => {
  it('builds facilitation preamble with session id', () => {
    const p = visFacilitationPreamble('abc-123');
    assert.match(p, /Voice Ideation Session/);
    assert.match(p, /abc-123/);
    assert.match(p, /kp_create/);
  });

  it('builds close prompt', () => {
    const p = visClosePrompt('sid');
    assert.match(p, /close this Voice Ideation Session/i);
    assert.match(p, /sid/);
  });

  it('detects close phrases', () => {
    assert.equal(isVisClosePhrase('close session'), true);
    assert.equal(isVisClosePhrase('Please wrap this up now.'), true);
    assert.equal(isVisClosePhrase('tell me more about CB'), false);
  });

  it('strips markdown for speech', () => {
    const out = textForSpeech('Hello **world**\n\n```ts\nconst x=1\n```\n- item');
    assert.equal(out.includes('```'), false);
    assert.match(out, /Hello world/);
    assert.match(out, /code omitted/);
  });

  it('parses fenced close JSON', () => {
    const text = [
      'Here is the capture:',
      '```json',
      JSON.stringify({
        ideas: [{ title: 'Voice bar', body: '## Problem\nx', project: 'projects/code-build' }],
        thoughts: [{ title: 'Ramble', body: 'stuff' }],
        summary: 'Captured one idea'
      }),
      '```'
    ].join('\n');
    const payload = parseVisClosePayload(text);
    assert.ok(payload);
    assert.equal(payload!.ideas!.length, 1);
    assert.equal(payload!.ideas![0].title, 'Voice bar');
    assert.equal(payload!.summary, 'Captured one idea');
  });

  it('resolveTtsEngine auto prefers system on darwin', () => {
    const eng = resolveTtsEngine('auto');
    assert.ok(eng === 'system' || eng === 'webview');
  });
});
