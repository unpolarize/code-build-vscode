import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionLoadReplayWindow,
  persistUserTurnTiming,
  isFirstEventProgress,
  DEFAULT_SESSION_LOAD_DRAIN_MS
} from '../../src/shared/sessionLoadReplayWindow';

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
  advance(ms: number): void {
    const target = this.now + ms;
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
}

function make(drainMs = DEFAULT_SESSION_LOAD_DRAIN_MS) {
  const clock = new FakeClock();
  const w = new SessionLoadReplayWindow(drainMs, clock);
  return { w, clock };
}

test('idle does not drop live updates', () => {
  const { w } = make();
  assert.equal(w.phase, 'idle');
  assert.equal(w.shouldDropSessionUpdate(), false);
});

test('drops session/update while session/load is in flight', () => {
  const { w } = make();
  w.beginLoad();
  assert.equal(w.phase, 'loading');
  assert.equal(w.shouldDropSessionUpdate(), true);
});

test('keeps dropping during drain after load settles (late notifications)', () => {
  const { w, clock } = make(250);
  w.beginLoad();
  w.markLoadSettled();
  assert.equal(w.phase, 'draining');
  assert.equal(w.shouldDropSessionUpdate(), true);
  clock.advance(249);
  assert.equal(w.shouldDropSessionUpdate(), true);
  clock.advance(2);
  assert.equal(w.phase, 'idle');
  assert.equal(w.shouldDropSessionUpdate(), false);
});

test('markPromptSent closes the window immediately (live turn not dropped)', () => {
  const { w, clock } = make(250);
  w.beginLoad();
  w.markLoadSettled();
  w.markPromptSent();
  assert.equal(w.phase, 'idle');
  assert.equal(w.shouldDropSessionUpdate(), false);
  clock.advance(250);
  assert.equal(w.shouldDropSessionUpdate(), false);
});

test('two load cycles: each window is independent (no flood across restarts)', () => {
  const { w, clock } = make(50);
  const dropped: boolean[] = [];
  w.beginLoad();
  dropped.push(w.shouldDropSessionUpdate());
  w.markLoadSettled();
  dropped.push(w.shouldDropSessionUpdate());
  clock.advance(50);
  dropped.push(w.shouldDropSessionUpdate());
  w.beginLoad();
  dropped.push(w.shouldDropSessionUpdate());
  w.markLoadSettled();
  clock.advance(50);
  dropped.push(w.shouldDropSessionUpdate());
  assert.deepEqual(dropped, [true, true, false, true, false]);
});

test('markLoadSettled is a no-op when not loading', () => {
  const { w } = make();
  w.markLoadSettled();
  assert.equal(w.phase, 'idle');
  w.markPromptSent();
  w.markLoadSettled();
  assert.equal(w.phase, 'idle');
});

test('dispose cancels drain and returns to idle', () => {
  const { w, clock } = make(250);
  w.beginLoad();
  w.markLoadSettled();
  w.dispose();
  assert.equal(w.phase, 'idle');
  clock.advance(250);
  assert.equal(w.shouldDropSessionUpdate(), false);
});

test('idle-resume with known meta persists the user turn before ensureSession', () => {
  assert.equal(persistUserTurnTiming(true), 'before-ensure-session');
  assert.equal(persistUserTurnTiming(false), 'after-ensure-session');
});

test('onFirstEvent includes user_message_chunk (clears restoring nudge)', () => {
  assert.equal(isFirstEventProgress('user_message_chunk'), true);
  assert.equal(isFirstEventProgress('agent_thought_chunk'), true);
  assert.equal(isFirstEventProgress('system_init'), true);
  assert.equal(isFirstEventProgress('usage'), false);
  assert.equal(isFirstEventProgress('current_mode_update'), false);
});
