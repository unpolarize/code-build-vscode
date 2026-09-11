// Finishability preflight gate
// (kp: ideas/cb-finishability-preflight-gate-block-rebind-fir)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EFFORT_WHEN_BOUND,
  DEFAULT_FINISHABILITY_SAFETY_FACTOR,
  EFFORT_WINDOW_PCT,
  FinishabilityPreflightTracker,
  estimateEffortWindowPct,
  evaluateFinishability,
  formatFinishabilityLog,
  formatFinishabilityTooltip,
  normalizeImplementEffort,
  pickRemainingWindow,
  readRemainingFromStatus,
  shouldArmFinishability,
  type FinishabilityEvent
} from '../../src/shared/finishabilityPreflight';

describe('effort table', () => {
  it('maps tiny/small/medium/large/xlarge', () => {
    assert.equal(estimateEffortWindowPct('tiny').estimatePct, 8);
    assert.equal(estimateEffortWindowPct('small').estimatePct, 20);
    assert.equal(estimateEffortWindowPct('medium').estimatePct, 45);
    assert.equal(estimateEffortWindowPct('large').estimatePct, 80);
    assert.equal(estimateEffortWindowPct('xlarge').estimatePct, 100);
    assert.equal(estimateEffortWindowPct('huge').estimatePct, 100);
    assert.equal(EFFORT_WINDOW_PCT.small, 20);
  });

  it('unknown / empty → medium when bound', () => {
    assert.equal(normalizeImplementEffort(null), DEFAULT_EFFORT_WHEN_BOUND);
    assert.equal(normalizeImplementEffort(''), DEFAULT_EFFORT_WHEN_BOUND);
    assert.equal(normalizeImplementEffort('SMALL'), 'small');
    assert.equal(estimateEffortWindowPct('nope').effort, DEFAULT_EFFORT_WHEN_BOUND);
    assert.equal(estimateEffortWindowPct('nope').estimatePct, 45);
  });
});

describe('shouldArmFinishability', () => {
  it('arms only KP-bound, multi-file, or force', () => {
    assert.equal(shouldArmFinishability({ kpBound: false }), false);
    assert.equal(shouldArmFinishability({ kpBound: true }), true);
    assert.equal(shouldArmFinishability({ kpBound: false, multiFileIntent: true }), true);
    assert.equal(shouldArmFinishability({ kpBound: false, force: true }), true);
  });
});

describe('pickRemainingWindow', () => {
  it('uses 5h when weekly is missing; weekly when tighter', () => {
    assert.deepEqual(pickRemainingWindow(40, null), {
      remainingPct: 40,
      window: 'five_hour'
    });
    assert.deepEqual(pickRemainingWindow(40, 12), {
      remainingPct: 12,
      window: 'seven_day'
    });
    assert.deepEqual(pickRemainingWindow(null, 55), {
      remainingPct: 55,
      window: 'seven_day'
    });
    assert.deepEqual(pickRemainingWindow(null, null), {
      remainingPct: null,
      window: 'unknown'
    });
  });
});

describe('evaluateFinishability', () => {
  it('skips unbound sessions (no silent chip)', () => {
    const d = evaluateFinishability({
      kpBound: false,
      fiveHourRemainingPct: 10,
      effort: 'large'
    });
    assert.equal(d.verdict, 'skip');
    assert.equal(d.chip.available, false);
    assert.equal(d.actions.length, 0);
  });

  it('blocks first Write when large estimate > remaining × 0.85', () => {
    // remaining 12% × 0.85 = 10.2; large 80 > 10.2
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'large',
      fiveHourRemainingPct: 12,
      safetyFactor: DEFAULT_FINISHABILITY_SAFETY_FACTOR
    });
    assert.equal(d.verdict, 'block');
    assert.equal(d.estimatePct, 80);
    assert.equal(d.remainingPct, 12);
    assert.equal(d.thresholdPct, 10.2);
    assert.equal(d.chip.gated, true);
    assert.equal(d.chip.warn, true);
    assert.match(d.chip.label, /finish ⚠ large 80%>12%/);
    assert.deepEqual(d.actions, ['block', 'override', 'rebind', 'shrink']);
  });

  it('allows small effort when remaining is ample', () => {
    // remaining 77% × 0.85 = 65.45; small 20 ≤ 65.45
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'small',
      fiveHourRemainingPct: 77
    });
    assert.equal(d.verdict, 'allow');
    assert.equal(d.chip.gated, false);
    assert.match(d.chip.label, /finish ok · small 20%/);
    assert.equal(d.actions.length, 0);
  });

  it('gates small effort near the wall', () => {
    // remaining 15% × 0.85 = 12.75; small 20 > 12.75
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'small',
      fiveHourRemainingPct: 15
    });
    assert.equal(d.verdict, 'block');
    assert.equal(d.thresholdPct, 12.8);
  });

  it('medium / tiny table edges', () => {
    const med = evaluateFinishability({
      kpBound: true,
      effort: 'medium',
      fiveHourRemainingPct: 50
    });
    // 50 × 0.85 = 42.5; medium 45 > 42.5 → block
    assert.equal(med.verdict, 'block');
    const tiny = evaluateFinishability({
      kpBound: true,
      effort: 'tiny',
      fiveHourRemainingPct: 10
    });
    // 10 × 0.85 = 8.5; tiny 8 ≤ 8.5 → allow
    assert.equal(tiny.verdict, 'allow');
  });

  it('unknown remaining → allow, never invent 100%', () => {
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'large',
      fiveHourRemainingPct: null
    });
    assert.equal(d.verdict, 'allow');
    assert.equal(d.window, 'unknown');
    assert.equal(d.chip.label, 'finish n/a');
    assert.equal(d.chip.gated, false);
  });

  it('weekly wall tighter than 5h uses seven_day', () => {
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'small',
      fiveHourRemainingPct: 90,
      sevenDayRemainingPct: 10
    });
    assert.equal(d.window, 'seven_day');
    assert.equal(d.remainingPct, 10);
    assert.equal(d.verdict, 'block');
  });

  it('override / shrink / first-write-done allow', () => {
    const base = {
      kpBound: true,
      effort: 'large' as const,
      fiveHourRemainingPct: 5
    };
    assert.equal(evaluateFinishability({ ...base, overridden: true }).verdict, 'allow');
    assert.equal(evaluateFinishability({ ...base, shrunk: true }).verdict, 'allow');
    assert.equal(evaluateFinishability({ ...base, firstWriteDone: true }).verdict, 'allow');
  });

  it('multi-file intent arms without KP bind', () => {
    const d = evaluateFinishability({
      kpBound: false,
      multiFileIntent: true,
      effort: 'large',
      fiveHourRemainingPct: 8
    });
    assert.equal(d.verdict, 'block');
  });
});

describe('FinishabilityPreflightTracker', () => {
  it('blocks first Write then allows after override', () => {
    const events: FinishabilityEvent[] = [];
    const t = new FinishabilityPreflightTracker(undefined, (e) => events.push(e));
    t.arm({ kpBound: true, effort: 'large' });
    t.noteRateWindow({ fiveHourRemainingPct: 12 });
    assert.equal(t.allowWrite('/tmp/a.ts'), false);
    assert.equal(t.getPhase(), 'gated');
    assert.equal(t.getTelemetry().hits, 1);
    assert.equal(t.allowWrite('/tmp/b.ts'), false);
    assert.equal(t.getTelemetry().hits, 1, 'second deny does not re-count the hit');
    t.applyDecision('override');
    assert.equal(t.getPhase(), 'overridden');
    assert.equal(t.allowWrite('/tmp/a.ts'), true);
    assert.equal(t.getTelemetry().overrides, 1);
    assert.ok(events.some((e) => e.type === 'deny'));
    assert.ok(events.some((e) => e.type === 'override'));
    assert.match(events.find((e) => e.type === 'override')?.log ?? '', /finishability action=override/);
  });

  it('rebind keeps writes blocked; shrink releases this gate', () => {
    const t = new FinishabilityPreflightTracker();
    t.arm({ kpBound: true, effort: 'large' });
    t.noteRateWindow({ fiveHourRemainingPct: 10 });
    assert.equal(t.allowWrite('/x'), false);
    t.applyDecision('rebind');
    assert.equal(t.getPhase(), 'rebound');
    assert.equal(t.allowWrite('/x'), false);
    t.applyDecision('shrink');
    assert.equal(t.getPhase(), 'shrunk');
    assert.equal(t.allowWrite('/x'), true);
    assert.equal(t.getTelemetry().rebinds, 1);
    assert.equal(t.getTelemetry().shrinks, 1);
  });

  it('passing first Write does not gate later Writes', () => {
    const t = new FinishabilityPreflightTracker();
    t.arm({ kpBound: true, effort: 'tiny' });
    t.noteRateWindow({ fiveHourRemainingPct: 80 });
    assert.equal(t.allowWrite('/a'), true);
    assert.equal(t.getPhase(), 'passed');
    t.noteRateWindow({ fiveHourRemainingPct: 2 });
    assert.equal(t.allowWrite('/b'), true, 'later writes stay allowed even if window collapses');
  });

  it('unbound tracker never blocks', () => {
    const t = new FinishabilityPreflightTracker();
    t.arm({ kpBound: false, effort: 'large' });
    t.noteRateWindow({ fiveHourRemainingPct: 1 });
    assert.equal(t.isActive(), false);
    assert.equal(t.allowWrite('/a'), true);
  });

  it('post-override 429 increments telemetry', () => {
    const t = new FinishabilityPreflightTracker();
    t.arm({ kpBound: true, effort: 'large' });
    t.noteRateWindow({ fiveHourRemainingPct: 8 });
    t.allowWrite('/a');
    t.applyDecision('override');
    t.noteQuotaError();
    t.noteQuotaError();
    assert.equal(t.getTelemetry().postOverride429, 2);
    t.clear();
    t.noteQuotaError();
    assert.equal(t.getTelemetry().postOverride429, 0, 'clear drops telemetry');
  });

  it('unknown window allows the first Write (n/a chip)', () => {
    const t = new FinishabilityPreflightTracker();
    t.arm({ kpBound: true, effort: 'large', reason: 'kp: ideas/x' });
    assert.equal(t.allowWrite('/a'), true);
    assert.equal(t.lastPostedChip()?.label, 'finish n/a');
  });
});

describe('status remaining + log/tooltip', () => {
  it('reads 5h and weekly remaining from Claude status fixture', () => {
    const r = readRemainingFromStatus({
      rate_limits: {
        five_hour: { used_percentage: 23.5 },
        seven_day: { used_percentage: 41.2 },
        spend_limit: { used_percentage: 62.8 }
      }
    });
    assert.equal(r.fiveHourRemainingPct, 76.5);
    assert.equal(r.sevenDayRemainingPct, 58.8);
  });

  it('omitted windows stay null (never fake 100%)', () => {
    const r = readRemainingFromStatus({ rate_limits: { spend_limit: { used_percentage: 10 } } });
    assert.equal(r.fiveHourRemainingPct, null);
    assert.equal(r.sevenDayRemainingPct, null);
  });

  it('formatFinishabilityLog and tooltip mention override actions', () => {
    const log = formatFinishabilityLog({
      action: 'deny',
      effort: 'large',
      estimatePct: 80,
      remainingPct: 12,
      factor: 0.85,
      hits: 1,
      overrides: 0,
      postOverride429: 0
    });
    assert.match(log, /finishability action=deny effort=large estimate=80 remaining=12/);
    const d = evaluateFinishability({
      kpBound: true,
      effort: 'large',
      fiveHourRemainingPct: 12
    });
    const tip = formatFinishabilityTooltip(d.chip);
    assert.match(tip, /Click: Override/);
    assert.match(tip, /walkaway co-stop/);
  });
});
