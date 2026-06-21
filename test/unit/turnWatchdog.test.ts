import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnWatchdog, type TurnWatchdogOptions } from '../../src/host/turnWatchdog';

/** Minimal virtual clock so the watchdog tests don't sleep on real time. */
class FakeClock {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { due: number; fn: () => void }>();
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { due: this.now + ms, fn });
    return id;
  };
  clearTimer = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  /** Advance virtual time, firing every timer whose deadline is crossed. */
  advance(ms: number): void {
    const target = this.now + ms;
    // Loop because a fired timer may schedule a new one within the window.
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      }
      if (!next) break;
      this.now = next[1].due;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.now = target;
  }
  get pending(): number {
    return this.timers.size;
  }
}

function make(opts: Partial<TurnWatchdogOptions>, clock: FakeClock) {
  const calls = { warn: 0, autoCancel: 0, lastWarnMs: 0, lastCancelMs: 0 };
  const wd = new TurnWatchdog({
    warnMs: 45_000,
    autoCancelMs: 120_000,
    onWarn: (ms) => {
      calls.warn++;
      calls.lastWarnMs = ms;
    },
    onAutoCancel: (ms) => {
      calls.autoCancel++;
      calls.lastCancelMs = ms;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts
  });
  return { wd, calls };
}

test('warns after warnMs of silence', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({}, clock);
  wd.arm();
  clock.advance(44_999);
  assert.equal(calls.warn, 0, 'must not warn before threshold');
  clock.advance(2);
  assert.equal(calls.warn, 1);
  assert.equal(calls.lastWarnMs, 45_000);
});

test('auto-cancels after autoCancelMs of continuous silence (no open tool)', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({}, clock);
  wd.arm();
  clock.advance(120_001);
  assert.equal(calls.warn, 1);
  assert.equal(calls.autoCancel, 1);
  assert.equal(calls.lastCancelMs, 120_000);
  assert.equal(wd.active, false, 'watchdog goes idle after auto-cancel');
});

test('progress resets the silence clock — no warn while output keeps arriving', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({}, clock);
  wd.arm();
  for (let i = 0; i < 10; i++) {
    clock.advance(40_000); // under the 45s warn threshold
    wd.progress();
  }
  assert.equal(calls.warn, 0, 'streaming output must keep the watchdog quiet');
  // ...but once output stops, the warn still fires.
  clock.advance(45_001);
  assert.equal(calls.warn, 1);
});

test('clear() stops the watchdog — a finished turn never warns or cancels', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({}, clock);
  wd.arm();
  clock.advance(10_000);
  wd.clear();
  clock.advance(1_000_000);
  assert.equal(calls.warn, 0);
  assert.equal(calls.autoCancel, 0);
  assert.equal(clock.pending, 0, 'no dangling timers');
});

test('an in-progress tool suppresses auto-cancel (long commands are not killed)', () => {
  const clock = new FakeClock();
  let toolOpen = true;
  const { wd, calls } = make({ hasOpenTool: () => toolOpen }, clock);
  wd.arm();
  clock.advance(600_000); // 10 minutes of a silent build
  assert.equal(calls.warn, 1, 'still warns once');
  assert.equal(calls.autoCancel, 0, 'but never kills a running command');
  // When the command finally finishes and the turn goes silent for real,
  // the next window auto-cancels.
  toolOpen = false;
  clock.advance(120_001);
  assert.equal(calls.autoCancel, 1);
});

test('autoCancelMs <= warnMs means warn-only (user stays in control)', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({ warnMs: 30_000, autoCancelMs: 0 }, clock);
  wd.arm();
  clock.advance(10_000_000);
  assert.equal(calls.warn, 1);
  assert.equal(calls.autoCancel, 0);
});

test('warnMs <= 0 disables the watchdog entirely', () => {
  const clock = new FakeClock();
  const { wd, calls } = make({ warnMs: 0 }, clock);
  wd.arm();
  assert.equal(wd.active, false);
  clock.advance(10_000_000);
  assert.equal(calls.warn, 0);
  assert.equal(calls.autoCancel, 0);
});

test('awaiting a user answer suppresses BOTH warn and auto-cancel', () => {
  const clock = new FakeClock();
  let awaiting = true;
  const { wd, calls } = make({ isAwaitingUser: () => awaiting }, clock);
  wd.arm();
  // Far past both thresholds while the user is being asked a question.
  clock.advance(10 * 60_000);
  assert.equal(calls.warn, 0, 'must not warn while awaiting the user');
  assert.equal(calls.autoCancel, 0, 'must not auto-cancel while awaiting the user');
  assert.ok(wd.active, 'watchdog keeps watching (re-polls), still armed');
  // User answers → normal stall watching resumes and can warn/cancel again.
  awaiting = false;
  clock.advance(45_001);
  assert.equal(calls.warn, 1, 'warns once the user has responded and silence continues');
  clock.advance(75_001);
  assert.equal(calls.autoCancel, 1, 'auto-cancels after the full window post-answer');
});
