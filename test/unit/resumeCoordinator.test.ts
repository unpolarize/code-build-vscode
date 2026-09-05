// Integration test for the resume-after-reset host coordinator
// (kp: ideas/cb-host-resume-after-reset-coordinator-park-goal).
//
// Drives the Done-when flow end-to-end against a fake clock/timer and a
// backend stub: mock 429 → pause meta written (bound to the 5h rate
// window) → fake clock past resume_at → resume primer emitted ONCE to the
// same backend — persist-before-inject, no second fire, notify-only
// outside the auto-wake gate.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResumeCoordinator, type ResumeCoordinatorHost } from '../../src/host/resumeCoordinator';
import { classifyBackendError } from '../../src/shared/backendErrorClass';
import type { AutoWakeConfig, ResumeAfterResetPause } from '../../src/shared/resumeAfterReset';

/** Real Claude 429 envelope shape — same fixture family as the classifier tests. */
const CLAUDE_429 = {
  type: 'error',
  error: { type: 'rate_limit_error', message: '429 Too Many Requests: usage limit reached' },
  status: 429
};

const T0 = 1_700_000_000_000; // fake epoch-ms origin
const RESET_SEC = Math.floor(T0 / 1000) + 3600; // 5h window resets in 1h

interface FakeTimer {
  delay: number;
  fn: () => void;
  disposed: boolean;
}

function makeHarness(opts?: { autoWake?: boolean; away?: boolean }) {
  const calls: string[] = [];
  const persisted: ResumeAfterResetPause[] = [];
  const chips: Array<ResumeAfterResetPause | null> = [];
  const primers: string[] = [];
  const notices: string[] = [];
  const timers: FakeTimer[] = [];
  let now = T0;

  const host: ResumeCoordinatorHost = {
    now: () => now,
    setTimer: (delay, fn) => {
      const t: FakeTimer = { delay, fn, disposed: false };
      timers.push(t);
      return { dispose: () => (t.disposed = true) };
    },
    persist: (p) => {
      calls.push(`persist:${p.state}`);
      persisted.push(p);
    },
    postChip: (p) => {
      chips.push(p);
    },
    injectPrimer: (primer) => {
      calls.push('inject');
      primers.push(primer);
    },
    notify: (text) => notices.push(text),
    autoWakeConfig: (): AutoWakeConfig => ({
      autoWakeEnabled: opts?.autoWake ?? true,
      inAwayWindow: opts?.away ?? true
    }),
    primerOptions: () => ({ verifyCommand: 'npm test' })
  };

  const coord = new ResumeCoordinator(host);
  return {
    coord,
    calls,
    persisted,
    chips,
    primers,
    notices,
    timers,
    advance(ms: number) {
      now += ms;
    },
    fireDueTimers() {
      for (const t of [...timers]) {
        if (!t.disposed) t.fn();
      }
    }
  };
}

function parkOn429(h: ReturnType<typeof makeHarness>, coord = h.coord): boolean {
  coord.noteRateWindowReset(RESET_SEC);
  return coord.onBackendError(classifyBackendError(CLAUDE_429), CLAUDE_429.error.message, {
    backend: 'claude',
    kpItemId: 'ideas/cb-host-resume-after-reset-coordinator-park-goal',
    goalSnapshot: '- integration test green\n- primer emitted once'
  });
}

test('mock 429 parks: stamp bound to 5h window, chip posted, timer armed', () => {
  const h = makeHarness();
  assert.equal(parkOn429(h), true);

  assert.equal(h.persisted.length, 1);
  const stamp = h.persisted[0];
  assert.equal(stamp.state, 'paused_for_reset');
  assert.equal(stamp.backend, 'claude');
  assert.equal(stamp.resumeAt, RESET_SEC * 1000);
  assert.equal(stamp.kpItemId, 'ideas/cb-host-resume-after-reset-coordinator-park-goal');
  assert.match(stamp.goalSnapshot ?? '', /primer emitted once/);

  assert.equal(h.chips.length, 1);
  assert.equal(h.chips[0]?.state, 'paused_for_reset');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, RESET_SEC * 1000 - T0);
  assert.match(h.notices[0], /wakes \d{2}:\d{2}/);
});

test('overload/unavailable never park — failover path keeps them', () => {
  const h = makeHarness();
  h.coord.noteRateWindowReset(RESET_SEC);
  const handled = h.coord.onBackendError(
    classifyBackendError({ type: 'error', error: { type: 'overloaded_error' }, status: 529 }),
    'overloaded',
    { backend: 'claude' }
  );
  assert.equal(handled, false);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.timers.length, 0);
});

test('clock past resume_at → primer emitted once to same backend; persist-before-inject; no second fire', () => {
  const h = makeHarness({ autoWake: true, away: true });
  parkOn429(h);

  h.advance(3600 * 1000 + 1);
  h.fireDueTimers();

  assert.equal(h.primers.length, 1);
  assert.match(h.primers[0], /same backend/i);
  assert.match(h.primers[0], /ideas\/cb-host-resume-after-reset-coordinator-park-goal/);
  assert.match(h.primers[0], /Verify with: npm test/);
  // Persist of the CLOSED stamp strictly precedes the injection.
  assert.deepEqual(h.calls, ['persist:paused_for_reset', 'persist:resumed', 'inject']);
  // Chip cleared after wake.
  assert.equal(h.chips.at(-1), null);

  // A duplicate timer fire (or stale second holder) must not double-fire.
  h.fireDueTimers();
  assert.equal(h.primers.length, 1);
  assert.equal(h.persisted.filter((p) => p.state === 'resumed').length, 1);
});

test('default gate (no auto-wake): timer fire notifies only; manual Resume emits the one primer', () => {
  const h = makeHarness({ autoWake: false, away: true });
  parkOn429(h);

  h.advance(3600 * 1000 + 1);
  h.fireDueTimers();
  assert.equal(h.primers.length, 0);
  assert.match(h.notices.at(-1) ?? '', /press Resume/);
  assert.equal(h.coord.isPaused, true);

  h.coord.manualResume();
  assert.equal(h.primers.length, 1);
  assert.equal(h.persisted.at(-1)?.state, 'resumed');

  // Second manual click is a no-op (stamp already closed).
  h.coord.manualResume();
  assert.equal(h.primers.length, 1);
});

test('no usage signal → unknown reset: no timer, manual Resume is the only wake', () => {
  const h = makeHarness();
  const handled = h.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', {
    backend: 'grok'
  });
  assert.equal(handled, true);
  assert.equal(h.persisted[0].resumeAt, null);
  assert.equal(h.timers.length, 0);
  assert.match(h.notices[0], /unknown/i);

  h.coord.manualResume();
  assert.equal(h.primers.length, 1);
});

test('stale reset time (in the past) is treated as unknown, never wakes instantly', () => {
  const h = makeHarness();
  h.coord.noteRateWindowReset(Math.floor(T0 / 1000) - 60);
  h.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', { backend: 'claude' });
  assert.equal(h.persisted[0].resumeAt, null);
  assert.equal(h.timers.length, 0);
});

test('repeat 429 while parked is absorbed — single stamp, single timer', () => {
  const h = makeHarness();
  parkOn429(h);
  assert.equal(parkOn429(h), true);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.timers.length, 1);
});

test('cancel closes the stamp, disposes the timer; a late fire is a no-op', () => {
  const h = makeHarness();
  parkOn429(h);
  h.coord.cancel('switch_backend');

  assert.equal(h.persisted.at(-1)?.state, 'cancelled');
  assert.equal(h.persisted.at(-1)?.cancelReason, 'switch_backend');
  assert.equal(h.timers[0].disposed, true);
  assert.equal(h.chips.at(-1), null);

  h.advance(3600 * 1000 + 1);
  h.fireDueTimers();
  assert.equal(h.primers.length, 0);
});

test('hydrate re-arms a live park; a past-due stamp notifies instead of auto-injecting', () => {
  const h = makeHarness();
  const stamp: ResumeAfterResetPause = {
    state: 'paused_for_reset',
    backend: 'claude',
    pausedAt: T0 - 1000,
    resumeAt: RESET_SEC * 1000
  };
  h.coord.hydrate(stamp);
  assert.equal(h.chips.at(-1)?.state, 'paused_for_reset');
  assert.equal(h.timers.length, 1);

  const h2 = makeHarness();
  h2.advance(2 * 3600 * 1000); // reload happens after the reset passed
  h2.coord.hydrate(stamp);
  assert.equal(h2.timers.length, 0);
  assert.equal(h2.primers.length, 0);
  assert.match(h2.notices.at(-1) ?? '', /press Resume/);

  // Closed stamps hydrate to nothing.
  const h3 = makeHarness();
  h3.coord.hydrate({ ...stamp, state: 'resumed', resumedAt: T0 });
  assert.equal(h3.chips.length, 0);
  assert.equal(h3.timers.length, 0);
});

test('late usage signal re-binds an unknown-reset park and arms the timer', () => {
  const h = makeHarness();
  h.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', { backend: 'claude' });
  assert.equal(h.persisted[0].resumeAt, null);
  assert.equal(h.timers.length, 0);

  h.coord.noteRateWindowReset(RESET_SEC);
  assert.equal(h.persisted.at(-1)?.resumeAt, RESET_SEC * 1000);
  assert.equal(h.timers.length, 1);

  // Stale (past) signals never re-bind.
  const h2 = makeHarness();
  h2.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', { backend: 'claude' });
  h2.coord.noteRateWindowReset(Math.floor(T0 / 1000) - 5);
  assert.equal(h2.persisted.at(-1)?.resumeAt, null);
  assert.equal(h2.timers.length, 0);
});

test('explicit null clears the cached window; clear() drops it across sessions', () => {
  const h = makeHarness();
  h.coord.noteRateWindowReset(RESET_SEC);
  h.coord.noteRateWindowReset(null);
  h.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', { backend: 'claude' });
  assert.equal(h.persisted[0].resumeAt, null);

  const h2 = makeHarness();
  h2.coord.noteRateWindowReset(RESET_SEC);
  h2.coord.clear(); // session switch — next session must re-learn its window
  h2.coord.onBackendError(classifyBackendError(CLAUDE_429), '429', { backend: 'grok' });
  assert.equal(h2.persisted[0].resumeAt, null);
});

test('failed primer injection re-parks at unknown reset so manual Resume can retry', () => {
  const h = makeHarness({ autoWake: true, away: true });
  parkOn429(h);
  h.advance(3600 * 1000 + 1);
  h.fireDueTimers();
  assert.equal(h.primers.length, 1);

  // Host reports the injection never reached the backend.
  h.coord.notePrimerInjectFailed();
  assert.equal(h.coord.isPaused, true);
  const reparked = h.persisted.at(-1)!;
  assert.equal(reparked.state, 'paused_for_reset');
  assert.equal(reparked.resumeAt, null);
  assert.equal(reparked.kpItemId, 'ideas/cb-host-resume-after-reset-coordinator-park-goal');
  assert.match(h.notices.at(-1) ?? '', /retry/i);

  h.coord.manualResume();
  assert.equal(h.primers.length, 2);

  // No-op unless the stamp is freshly resumed.
  h.coord.notePrimerInjectFailed();
  h.coord.notePrimerInjectFailed();
  assert.equal(h.persisted.at(-1)?.state, 'paused_for_reset');
  assert.equal(h.persisted.filter((p) => p.state === 'paused_for_reset').length, 3);
});

test('clear() drops the park state and timer without rewriting the persisted stamp', () => {
  const h = makeHarness();
  parkOn429(h);
  h.coord.clear();
  assert.equal(h.timers[0].disposed, true);
  assert.equal(h.coord.isPaused, false);
  // Only the original park persist — clear never writes.
  assert.deepEqual(h.calls, ['persist:paused_for_reset']);
});
