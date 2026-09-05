import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateSpendLimitChip,
  formatSpendLimitReset,
  readFiveHourResetsAt,
  SPEND_LIMIT_WARN_AT
} from '../../src/shared/spendLimitChip';
import { ClaudeNormalizer } from '../../src/host/transports/normalizers/claude';
import { reduce, initialState } from '../../webview-ui/src/store';

/** Claude 2.1.251 statusline / gateway shape (docs rate_limits.spend_limit). */
const CLAUDE_SPEND_FIXTURE = {
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    spend_limit: { used_percentage: 62.8, resets_at: 1740787200 }
  }
};

test('Claude spend_limit fixture — remaining % + reset, no warn under 75', () => {
  const chip = evaluateSpendLimitChip(CLAUDE_SPEND_FIXTURE);
  assert.equal(chip.available, true);
  assert.equal(chip.usedPercentage, 62.8);
  assert.equal(chip.remainingPercentage, 37.2);
  assert.equal(chip.resetsAt, 1740787200);
  assert.equal(chip.label, 'spend 37.2% left');
  assert.equal(chip.warn, false);
  assert.equal(chip.warnReason, undefined);
});

test('Claude spend_limit at warn threshold — amber', () => {
  const chip = evaluateSpendLimitChip({
    rate_limits: { spend_limit: { used_percentage: SPEND_LIMIT_WARN_AT, resets_at: 1740787200 } }
  });
  assert.equal(chip.warn, true);
  assert.equal(chip.remainingPercentage, 25);
  assert.match(chip.warnReason ?? '', /Approaching spend limit/i);
});

test('Claude spend_limit over 100 — spend over, never fake remaining', () => {
  const chip = evaluateSpendLimitChip({
    rate_limits: { spend_limit: { used_percentage: 112, resets_at: 1740787200 } }
  });
  assert.equal(chip.available, true);
  assert.equal(chip.remainingPercentage, 0);
  assert.equal(chip.label, 'spend over');
  assert.equal(chip.warn, true);
});

test('Codex fixture — omitted rate_limits → spend n/a (never fake 100%)', () => {
  const chip = evaluateSpendLimitChip({
    // Codex status-ish payload without Claude gateway fields
    model: 'gpt-5',
    rate_limits: { five_hour: { used_percentage: 10 } }
  });
  assert.equal(chip.available, false);
  assert.equal(chip.usedPercentage, null);
  assert.equal(chip.remainingPercentage, null);
  assert.equal(chip.label, 'spend n/a');
  assert.equal(chip.warn, false);
});

test('Grok ACP fixture — empty initialize / no rate_limits → n/a', () => {
  for (const bad of [null, undefined, {}, { agentCapabilities: {} }, { rateLimits: {} }]) {
    const chip = evaluateSpendLimitChip(bad as any);
    assert.equal(chip.label, 'spend n/a');
    assert.equal(chip.available, false);
    assert.equal(chip.remainingPercentage, null);
  }
});

test('camelCase ACP-shaped rateLimits.spendLimit is accepted', () => {
  const chip = evaluateSpendLimitChip({
    rateLimits: { spendLimit: { usedPercentage: 40, resetsAt: 1740000000 } }
  });
  assert.equal(chip.available, true);
  assert.equal(chip.remainingPercentage, 60);
  assert.equal(chip.resetsAt, 1740000000);
  assert.equal(chip.label, 'spend 60% left');
});

test('spend_limit object without used_percentage → n/a (no invented math)', () => {
  const chip = evaluateSpendLimitChip({
    rate_limits: { spend_limit: { resets_at: 1740787200 } }
  });
  assert.equal(chip.available, false);
  assert.equal(chip.label, 'spend n/a');
  assert.equal(chip.resetsAt, 1740787200);
});

test('formatSpendLimitReset renders epoch seconds', () => {
  const s = formatSpendLimitReset(1740787200);
  assert.ok(s && s.length > 0);
  assert.equal(formatSpendLimitReset(null), undefined);
  assert.equal(formatSpendLimitReset(0), undefined);
});

test('ClaudeNormalizer emits spend_limit_update only when rate_limits are present', () => {
  const n = new ClaudeNormalizer();
  const first = n.parseLine({ type: 'system', session_id: 'sess-1' });
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'system_init');

  const withLimits = n.parseLine({
    type: 'system',
    session_id: 'sess-1',
    rate_limits: CLAUDE_SPEND_FIXTURE.rate_limits
  });
  assert.ok(!withLimits.some((u) => u.kind === 'system_init'));
  const spend = withLimits.find((u) => u.kind === 'spend_limit_update');
  assert.ok(spend && spend.kind === 'spend_limit_update');
  assert.equal(spend.label, 'spend 37.2% left');
  assert.equal(spend.available, true);

  // Identical label is not re-emitted (no JSONL spam).
  const dup = n.parseLine({
    type: 'system',
    session_id: 'sess-1',
    rate_limits: CLAUDE_SPEND_FIXTURE.rate_limits
  });
  assert.equal(dup.length, 0);
});

test('webview reducer stores spend_limit_update on ChatState.spendLimit', () => {
  const chip = evaluateSpendLimitChip(CLAUDE_SPEND_FIXTURE);
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'spend_limit_update',
      available: chip.available,
      usedPercentage: chip.usedPercentage,
      remainingPercentage: chip.remainingPercentage,
      resetsAt: chip.resetsAt,
      label: chip.label,
      warn: chip.warn
    }
  });
  assert.ok(next.spendLimit);
  assert.equal(next.spendLimit!.label, 'spend 37.2% left');
  assert.equal(next.spendLimit!.remainingPercentage, 37.2);
});

test('historyLoaded clears stale spendLimit until a persisted update re-applies', () => {
  const withChip = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'spend_limit_update',
      available: true,
      usedPercentage: 10,
      remainingPercentage: 90,
      resetsAt: null,
      label: 'spend 90% left',
      warn: false
    }
  });
  assert.equal(withChip.spendLimit?.label, 'spend 90% left');

  const cleared = reduce(withChip, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'grok',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: []
  });
  assert.equal(cleared.spendLimit, null);

  const restored = reduce(withChip, {
    type: 'historyLoaded',
    meta: {
      id: 's2',
      backend: 'claude',
      title: 't',
      mode: 'default',
      cwd: '/tmp',
      createdAt: 1
    },
    records: [
      {
        type: 'update',
        update: {
          kind: 'spend_limit_update',
          available: false,
          usedPercentage: null,
          remainingPercentage: null,
          resetsAt: null,
          label: 'spend n/a',
          warn: false
        }
      }
    ]
  });
  assert.equal(restored.spendLimit?.label, 'spend n/a');
  assert.equal(restored.spendLimit?.available, false);
});

test('readFiveHourResetsAt — binds the 5h RATE window, never spend_limit', () => {
  const status = {
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      spend_limit: { used_percentage: 10, resets_at: 1739999999 }
    }
  };
  assert.equal(readFiveHourResetsAt(status), 1738425600);
  // ms accepted defensively → normalized to seconds
  assert.equal(
    readFiveHourResetsAt({ rate_limits: { five_hour: { resets_at: 1738425600000 } } }),
    1738425600
  );
  // Missing five_hour (even with spend present) is unknown — null, never substituted.
  assert.equal(
    readFiveHourResetsAt({ rate_limits: { spend_limit: { resets_at: 1739999999 } } }),
    null
  );
  assert.equal(readFiveHourResetsAt(null), null);
  assert.equal(readFiveHourResetsAt({}), null);
});
