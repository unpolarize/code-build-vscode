import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPauseForReset,
  buildResumePrimer,
  canAutoWake,
  cancelPause,
  resumeChipLabel,
  shouldWake,
  takeWake
} from '../../src/shared/resumeAfterReset';
import { classifyBackendError } from '../../src/shared/backendErrorClass';

const NOW = 1_800_000_000_000; // fixed epoch-ms clock
const RESET_SEC = NOW / 1000 + 3600; // window resets in 1h

function pausedWithReset() {
  const p = buildPauseForReset({
    errorClass: 'quota',
    backend: 'claude',
    now: NOW,
    resetsAtEpochSec: RESET_SEC,
    kpItemId: 'ideas/cb-host-resume-after-reset-coordinator-park-goal',
    goalSnapshot: '- pause state machine\n- chip renders resume_at',
    reason: '429 rate_limit_error'
  });
  assert.ok(p);
  return p!;
}

test('buildPauseForReset — only quota parks; overload/unavailable/auth/other do not', () => {
  for (const cls of ['overload', 'unavailable', 'auth', 'other'] as const) {
    assert.equal(
      buildPauseForReset({ errorClass: cls, backend: 'claude', now: NOW }),
      null,
      cls
    );
  }
  assert.equal(pausedWithReset().state, 'paused_for_reset');
});

test('classifier integration — a real 429 envelope reaches the park path', () => {
  const cls = classifyBackendError({
    type: 'error',
    error: { type: 'rate_limit_error', message: '429 Too Many Requests' }
  });
  assert.equal(cls, 'quota');
  const p = buildPauseForReset({ errorClass: cls, backend: 'claude', now: NOW });
  assert.ok(p);
});

test('resumeAt derives from epoch-seconds signal; ms accepted; missing → null', () => {
  assert.equal(pausedWithReset().resumeAt, RESET_SEC * 1000);

  const ms = buildPauseForReset({
    errorClass: 'quota',
    backend: 'grok',
    now: NOW,
    resetsAtEpochSec: RESET_SEC * 1000 // ms sneaking through
  });
  assert.equal(ms!.resumeAt, RESET_SEC * 1000);

  for (const missing of [undefined, null, 0, -5, NaN]) {
    const p = buildPauseForReset({
      errorClass: 'quota',
      backend: 'claude',
      now: NOW,
      resetsAtEpochSec: missing as number | null | undefined
    });
    assert.equal(p!.resumeAt, null, String(missing));
  }
});

test('stale reset time (in the past) is treated as unknown — never instant wake', () => {
  const p = buildPauseForReset({
    errorClass: 'quota',
    backend: 'claude',
    now: NOW,
    resetsAtEpochSec: NOW / 1000 - 60
  });
  assert.equal(p!.resumeAt, null);
  assert.equal(shouldWake(p!, NOW), false);
});

test('shouldWake — false before resume_at, true at/after; unknown reset never wakes', () => {
  const p = pausedWithReset();
  assert.equal(shouldWake(p, NOW), false);
  assert.equal(shouldWake(p, p.resumeAt! - 1), false);
  assert.equal(shouldWake(p, p.resumeAt!), true);
  assert.equal(shouldWake(p, p.resumeAt! + 5000), true);

  const unknown = buildPauseForReset({ errorClass: 'quota', backend: 'claude', now: NOW })!;
  assert.equal(shouldWake(unknown, NOW + 365 * 24 * 3600 * 1000), false);
});

test('takeWake — single fire: consumes the pause, second tick emits nothing', () => {
  const p = pausedWithReset();
  const wakeAt = p.resumeAt! + 1000;

  assert.equal(takeWake(p, p.resumeAt! - 1), null); // not due yet

  const fired = takeWake(p, wakeAt, { verifyCommand: 'npm run test:unit' });
  assert.ok(fired);
  assert.equal(fired!.pause.state, 'resumed');
  assert.equal(fired!.pause.resumedAt, wakeAt);
  assert.match(fired!.primer, /same backend/i);

  // Second concurrent timer tick sees the resumed stamp → no second primer.
  assert.equal(takeWake(fired!.pause, wakeAt + 1), null);
  assert.equal(shouldWake(fired!.pause, wakeAt + 1), false);
});

test('resume primer carries KP id, goal snapshot, done/remaining/verify, no backend switch', () => {
  const primer = buildResumePrimer(pausedWithReset(), {
    doneSummary: 'wrote pause module',
    remaining: 'wire host timer',
    verifyCommand: 'npm run test:unit'
  });
  assert.match(primer, /Do not switch backends/);
  assert.match(primer, /ideas\/cb-host-resume-after-reset-coordinator-park-goal/);
  assert.match(primer, /pause state machine/);
  assert.match(primer, /wrote pause module/);
  assert.match(primer, /wire host timer/);
  assert.match(primer, /Verify with: npm run test:unit/);
});

test('cancelPause — cancel and switch_backend both close the park', () => {
  const p = pausedWithReset();
  const c = cancelPause(p, NOW + 10);
  assert.equal(c.state, 'cancelled');
  assert.equal(c.cancelReason, 'cancel');
  assert.equal(shouldWake(c, p.resumeAt! + 1), false);
  assert.equal(takeWake(c, p.resumeAt! + 1), null);

  const s = cancelPause(p, NOW + 20, 'switch_backend');
  assert.equal(s.cancelReason, 'switch_backend');
});

test('canAutoWake — requires explicit flag AND away window; default notify-only', () => {
  assert.equal(canAutoWake(undefined), false);
  assert.equal(canAutoWake(null), false);
  assert.equal(canAutoWake({}), false);
  assert.equal(canAutoWake({ autoWakeEnabled: true }), false);
  assert.equal(canAutoWake({ inAwayWindow: true }), false);
  assert.equal(canAutoWake({ autoWakeEnabled: true, inAwayWindow: true }), true);
});

test('resumeChipLabel — wakes HH:MM with known reset, unknown reset otherwise, null once closed', () => {
  const p = pausedWithReset();
  assert.equal(
    resumeChipLabel(p, () => '07:30'),
    'Resume after reset · wakes 07:30'
  );

  const unknown = buildPauseForReset({ errorClass: 'quota', backend: 'claude', now: NOW })!;
  assert.equal(resumeChipLabel(unknown), 'Resume after reset · unknown reset');

  assert.equal(resumeChipLabel(cancelPause(p, NOW)), null);
  const fired = takeWake(p, p.resumeAt!)!;
  assert.equal(resumeChipLabel(fired.pause), null);
});

test('default chip time formatter renders local HH:MM', () => {
  const p = pausedWithReset();
  const d = new Date(p.resumeAt!);
  const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(resumeChipLabel(p), `Resume after reset · wakes ${expected}`);
});
