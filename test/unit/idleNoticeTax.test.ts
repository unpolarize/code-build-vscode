import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_IDLE_NOTICE_TAX_CONFIG,
  IDLE_NOTICE_TAX_HINT,
  IdleNoticeTaxTracker,
  classifyIdleNoticeText,
  evaluateIdleNoticeChip,
  extractNoticeText,
  type IdleNoticeTaxConfig
} from '../../src/shared/idleNoticeTax';
import { reduce, initialState } from '../../webview-ui/src/store';

// ---------------------------------------------------------------------------
// Fixtures: idle / notify_when_idle-class message shapes seen in agent-team
// transcripts (wrapper tags + stock phrasings). Classifier is heuristic —
// these pin the shapes it must recognize.
// ---------------------------------------------------------------------------
const FIXTURE_TEAMMATE_IDLE_TAG =
  '<teammate-idle agent="researcher">researcher is idle and waiting for instructions.</teammate-idle>';
const FIXTURE_NOTIFY_MARKER =
  'Agent spawned with notify_when_idle: true — you will receive a message when it goes idle.';
const FIXTURE_WENT_IDLE_PHRASE =
  'Teammate "builder" is now idle after finishing the styling pass. No pending work remains in its queue.';
const FIXTURE_IDLE_NOTIFICATION =
  'idle notification: worker-2 has no remaining tasks and is awaiting further direction from the lead.';
const FIXTURE_TASK_NOTIFICATION_TAG =
  '<task-notification agent="explore-1">Search completed. Findings: 3 files reference the flag.</task-notification>';
const FIXTURE_TASK_COMPLETE_PHRASE =
  'Background task "typecheck" has completed with exit code 0. Output attached below.';
const FIXTURE_PLAIN_CHAT =
  'Here is the diff for the reducer change you asked about — the store now clears the chip on session switch.';
const FIXTURE_IDLE_WORD_ONLY =
  'The event loop was idle for 30ms between frames, which is expected under vsync.';

describe('classifyIdleNoticeText', () => {
  it('classifies teammate-idle wrapper tags as idle', () => {
    const c = classifyIdleNoticeText(FIXTURE_TEAMMATE_IDLE_TAG);
    assert.equal(c.kind, 'idle');
    assert.equal(c.reason, 'teammate-idle-tag');
    assert.ok(c.estimatedTokens > 0);
    assert.equal(c.byteLength, FIXTURE_TEAMMATE_IDLE_TAG.length);
  });

  it('does not classify notify_when_idle spawn echoes (config text, not a notice)', () => {
    const c = classifyIdleNoticeText(FIXTURE_NOTIFY_MARKER);
    assert.equal(c.kind, 'none');
  });

  it('classifies "teammate is now idle" phrasing as idle', () => {
    const c = classifyIdleNoticeText(FIXTURE_WENT_IDLE_PHRASE);
    assert.equal(c.kind, 'idle');
    assert.equal(c.reason, 'peer-went-idle-phrase');
  });

  it('classifies "idle notification:" phrasing as idle', () => {
    const c = classifyIdleNoticeText(FIXTURE_IDLE_NOTIFICATION);
    assert.equal(c.kind, 'idle');
    assert.equal(c.reason, 'idle-notification-phrase');
  });

  it('classifies task-notification tags as task_notice', () => {
    const c = classifyIdleNoticeText(FIXTURE_TASK_NOTIFICATION_TAG);
    assert.equal(c.kind, 'task_notice');
    assert.equal(c.reason, 'task-notification-tag');
  });

  it('classifies task-completed phrasing as task_notice', () => {
    const c = classifyIdleNoticeText(FIXTURE_TASK_COMPLETE_PHRASE);
    assert.equal(c.kind, 'task_notice');
    assert.equal(c.reason, 'task-complete-phrase');
  });

  it('idle-class match wins when both idle and task shapes appear', () => {
    const c = classifyIdleNoticeText(
      `${FIXTURE_TASK_NOTIFICATION_TAG}\nTeammate "explore-1" is now idle.`
    );
    assert.equal(c.kind, 'idle');
  });

  it('does not classify ordinary chat text', () => {
    const c = classifyIdleNoticeText(FIXTURE_PLAIN_CHAT);
    assert.equal(c.kind, 'none');
    assert.equal(c.estimatedTokens, 0);
  });

  it('does not classify incidental uses of the word idle', () => {
    const c = classifyIdleNoticeText(FIXTURE_IDLE_WORD_ONLY);
    assert.equal(c.kind, 'none');
  });

  it('taxes only the notice span inside a large unrelated payload', () => {
    const bigPayload =
      `${'x'.repeat(20_000)}\nBackground task "lint" has completed with exit code 0.\n${'y'.repeat(20_000)}`;
    const c = classifyIdleNoticeText(bigPayload);
    assert.equal(c.kind, 'task_notice');
    // span = the containing line, not the 40k payload
    assert.ok(c.byteLength < 200, `span too large: ${c.byteLength}`);
    assert.ok(c.estimatedTokens < 50);
  });

  it('taxes the wrapper body through its close tag', () => {
    const body = 'z'.repeat(1_000);
    const text = `prefix log line\n<task-notification>${body}</task-notification>\ntrailing`;
    const c = classifyIdleNoticeText(text);
    assert.equal(c.kind, 'task_notice');
    assert.ok(c.byteLength >= body.length && c.byteLength < text.length);
  });

  it('never throws on non-string input', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const c = classifyIdleNoticeText(bad);
      assert.equal(c.kind, 'none');
    }
  });
});

describe('extractNoticeText', () => {
  it('passes strings through and reads text blocks', () => {
    assert.equal(extractNoticeText('hi'), 'hi');
    assert.equal(extractNoticeText({ type: 'text', text: 'hello' }), 'hello');
  });

  it('joins nested content arrays', () => {
    const t = extractNoticeText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' }
      ]
    });
    assert.equal(t, 'a\nb');
  });

  it('reads tool_result blocks whose content is a plain string', () => {
    assert.equal(
      extractNoticeText({ type: 'tool_result', content: FIXTURE_TEAMMATE_IDLE_TAG }),
      FIXTURE_TEAMMATE_IDLE_TAG
    );
  });

  it('returns undefined for unrecognized shapes', () => {
    assert.equal(extractNoticeText({ type: 'image', data: 'xxx' }), undefined);
    assert.equal(extractNoticeText(42), undefined);
  });
});

describe('IdleNoticeTaxTracker', () => {
  it('accumulates counts and token estimates by kind', () => {
    const t = new IdleNoticeTaxTracker();
    t.noteText(FIXTURE_TEAMMATE_IDLE_TAG);
    t.noteText(FIXTURE_WENT_IDLE_PHRASE);
    t.noteText(FIXTURE_TASK_COMPLETE_PHRASE);
    t.noteText(FIXTURE_PLAIN_CHAT); // ignored
    const snap = t.snapshot();
    assert.equal(snap.idleCount, 2);
    assert.equal(snap.taskNoticeCount, 1);
    assert.ok(snap.sessionNoticeTokens > 0);
    assert.equal(t.getEventCount(), 3);
  });

  it('counts a toolCallId only once', () => {
    const t = new IdleNoticeTaxTracker();
    t.noteText(FIXTURE_TASK_NOTIFICATION_TAG, { toolCallId: 'tc1' });
    t.noteText(FIXTURE_TASK_NOTIFICATION_TAG, { toolCallId: 'tc1' });
    assert.equal(t.getEventCount(), 1);
  });

  it('dedupes redelivered user chunks with identical text', () => {
    const t = new IdleNoticeTaxTracker();
    t.noteText(FIXTURE_TEAMMATE_IDLE_TAG);
    t.noteText(FIXTURE_TEAMMATE_IDLE_TAG);
    assert.equal(t.getEventCount(), 1);
  });

  it('reads text out of content-block shapes', () => {
    const t = new IdleNoticeTaxTracker();
    t.noteText({ type: 'text', text: FIXTURE_TEAMMATE_IDLE_TAG });
    assert.equal(t.getEventCount(), 1);
  });

  it('soft-gates on event count (default 8)', () => {
    const t = new IdleNoticeTaxTracker();
    for (let i = 0; i < 8; i++) t.noteText(`idle notification: worker-${i} is waiting.`);
    const { chip, newlyWarned, pauseReasons } = t.check();
    assert.equal(newlyWarned, true);
    assert.equal(chip.pause, true);
    assert.equal(chip.hint, IDLE_NOTICE_TAX_HINT);
    assert.match(pauseReasons.join(';'), /events 8 ≥ limit 8/);
    // fires once
    assert.equal(t.check().newlyWarned, false);
  });

  it('soft-gates on window percentage', () => {
    const cfg: IdleNoticeTaxConfig = { mode: 'warn', maxNotices: 0, maxWindowPct: 5 };
    const t = new IdleNoticeTaxTracker();
    t.noteText(`<task-notification>${'x'.repeat(4_000)}</task-notification>`);
    // ~1k tokens vs 10k window = ~10% ≥ 5%
    const { chip } = t.check(cfg, 10_000);
    assert.equal(chip.pause, true);
    // huge window → under threshold
    const t2 = new IdleNoticeTaxTracker();
    t2.noteText(FIXTURE_TASK_NOTIFICATION_TAG);
    assert.equal(t2.check(cfg, 200_000).chip.pause, false);
  });

  it('mode off never warns; count gate 0 disables', () => {
    const cfg: IdleNoticeTaxConfig = { mode: 'off', maxNotices: 1, maxWindowPct: 1 };
    const t = new IdleNoticeTaxTracker();
    t.noteText(FIXTURE_TEAMMATE_IDLE_TAG);
    t.noteText(FIXTURE_WENT_IDLE_PHRASE);
    assert.equal(t.check(cfg, 100).newlyWarned, false);
    const cfg2: IdleNoticeTaxConfig = { mode: 'warn', maxNotices: 0, maxWindowPct: 0 };
    assert.equal(t.check(cfg2, 100).chip.pause, false);
  });

  it('default config matches documented thresholds', () => {
    assert.equal(DEFAULT_IDLE_NOTICE_TAX_CONFIG.mode, 'warn');
    assert.equal(DEFAULT_IDLE_NOTICE_TAX_CONFIG.maxNotices, 8);
    assert.equal(DEFAULT_IDLE_NOTICE_TAX_CONFIG.maxWindowPct, 5);
  });
});

describe('evaluateIdleNoticeChip', () => {
  it('formats the label with event count and token estimate', () => {
    const chip = evaluateIdleNoticeChip({
      idleCount: 3,
      taskNoticeCount: 1,
      sessionNoticeTokens: 1_234,
      pause: false,
      pauseReasons: []
    });
    assert.equal(chip.label, 'idle 4 · ~1.2k');
    assert.equal(chip.warn, false);
    assert.equal(chip.hint, undefined);
  });

  it('omits token part at zero tokens and hints on pause', () => {
    const chip = evaluateIdleNoticeChip({
      idleCount: 9,
      taskNoticeCount: 0,
      sessionNoticeTokens: 0,
      pause: true,
      pauseReasons: ['x']
    });
    assert.equal(chip.label, 'idle 9');
    assert.equal(chip.warn, true);
    assert.equal(chip.hint, IDLE_NOTICE_TAX_HINT);
  });
});

describe('webview store idleNoticeTax', () => {
  it('reducer stores and clears the chip', () => {
    const chip = {
      label: 'idle 4 · ~1.2k',
      idleCount: 3,
      taskNoticeCount: 1,
      sessionNoticeTokens: 1_234,
      warn: false,
      pause: false
    };
    const withChip = reduce(initialState, { type: 'idleNoticeTax', chip });
    assert.deepEqual(withChip.idleNoticeTax, chip);
    const cleared = reduce(withChip, { type: 'idleNoticeTax', chip: null });
    assert.equal(cleared.idleNoticeTax, null);
  });
});
