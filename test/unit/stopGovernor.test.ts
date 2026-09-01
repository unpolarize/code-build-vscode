import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StopGovernor, GOVERNOR_LAST_TOOLS, type GovernorConfig } from '../../src/host/stopGovernor';

const base: GovernorConfig = {
  mode: 'warn',
  maxToolCalls: 0,
  maxWallMs: 0,
  maxEstUsd: 0,
  enableDupToolStop: false,
  enableNoProgressStop: false
};

// --- tool-call budget ---------------------------------------------------------

test('tool-call budget trips once at the limit, warn action in warn mode', () => {
  const g = new StopGovernor({ ...base, maxToolCalls: 3 });
  g.startTurn(0);
  g.noteToolCall('Read');
  g.noteToolCall('Bash');
  assert.equal(g.check(10), undefined);
  g.noteToolCall('Edit');
  const trip = g.check(20);
  assert.ok(trip);
  assert.equal(trip.budget, 'toolCalls');
  assert.equal(trip.action, 'warn');
  assert.equal(trip.limit, 3);
  assert.equal(trip.toolCalls, 3);
  assert.deepEqual(trip.lastTools, ['Read', 'Bash', 'Edit']);
  // Fires once: further calls past the limit stay silent.
  g.noteToolCall('Bash');
  assert.equal(g.check(30), undefined);
});

test('hard mode returns a stop action', () => {
  const g = new StopGovernor({ ...base, mode: 'hard', maxToolCalls: 1 });
  g.noteToolCall('Bash');
  assert.equal(g.check(0)?.action, 'stop');
});

test('mode off never trips even past every limit', () => {
  const g = new StopGovernor({ ...base, mode: 'off', maxToolCalls: 1, maxEstUsd: 0.01 });
  g.noteToolCall('Bash');
  g.noteUsage(99);
  assert.equal(g.check(0), undefined);
});

test('disabled budgets (limit 0) never trip', () => {
  const g = new StopGovernor(base);
  for (let i = 0; i < 1000; i++) g.noteToolCall('Bash');
  g.noteUsage(500);
  g.startTurn(0);
  assert.equal(g.check(86_400_000), undefined);
});

test('lastTools keeps only the most recent titles, oldest first', () => {
  const g = new StopGovernor({ ...base, maxToolCalls: GOVERNOR_LAST_TOOLS + 3 });
  for (let i = 1; i <= GOVERNOR_LAST_TOOLS + 3; i++) g.noteToolCall(`t${i}`);
  const trip = g.check(0);
  assert.ok(trip);
  assert.equal(trip.lastTools.length, GOVERNOR_LAST_TOOLS);
  assert.equal(trip.lastTools[0], 't4');
  assert.equal(trip.lastTools[GOVERNOR_LAST_TOOLS - 1], `t${GOVERNOR_LAST_TOOLS + 3}`);
});

// --- wall-clock budget ---------------------------------------------------------

test('wall clock counts only active turn spans, including the open turn', () => {
  const g = new StopGovernor({ ...base, maxWallMs: 10_000 });
  g.startTurn(0);
  g.endTurn(4000); // 4s active
  // 100s of idle time between turns must not count.
  assert.equal(g.check(104_000), undefined);
  g.startTurn(104_000);
  assert.equal(g.check(109_000), undefined); // 4s + 5s = 9s < 10s
  const trip = g.check(110_000); // 4s + 6s = 10s → trip
  assert.ok(trip);
  assert.equal(trip.budget, 'wallClock');
  assert.equal(trip.activeMs, 10_000);
});

test('startTurn is idempotent while a turn is open; endTurn without start is a no-op', () => {
  const g = new StopGovernor(base);
  g.endTurn(50); // no open turn
  g.startTurn(100);
  g.startTurn(500); // ignored — turn already open
  g.endTurn(1100);
  assert.equal(g.activeMs(9999), 1000);
});

// --- spend budget ---------------------------------------------------------------

test('estUsd is a cumulative high-water mark and trips at the limit', () => {
  const g = new StopGovernor({ ...base, maxEstUsd: 5 });
  g.noteUsage(2.5);
  g.noteUsage(1.0); // partial/out-of-order snapshot never winds back
  g.noteUsage(undefined);
  g.noteUsage(Number.NaN);
  assert.equal(g.check(0), undefined);
  g.noteUsage(5.01);
  const trip = g.check(0);
  assert.ok(trip);
  assert.equal(trip.budget, 'estUsd');
  assert.equal(trip.estUsd, 5.01);
});

// --- independence / ordering ------------------------------------------------------

test('setConfig swaps mode/limits without resetting counters or fired budgets', () => {
  const g = new StopGovernor({ ...base, maxToolCalls: 2 });
  g.noteToolCall('Bash');
  g.noteToolCall('Bash');
  assert.equal(g.check(0)?.action, 'warn'); // toolCalls budget now fired
  // Flip to hard + add a spend limit mid-session: counters survive,
  // the already-fired toolCalls budget stays fired, spend trips as stop.
  g.setConfig({ ...base, mode: 'hard', maxToolCalls: 2, maxEstUsd: 1 });
  g.noteToolCall('Bash');
  assert.equal(g.check(1), undefined);
  g.noteUsage(1.5);
  const trip = g.check(2);
  assert.equal(trip?.budget, 'estUsd');
  assert.equal(trip?.action, 'stop');
  assert.equal(trip?.toolCalls, 3);
});

test('each budget fires independently, tool calls take precedence', () => {
  const g = new StopGovernor({ ...base, maxToolCalls: 1, maxEstUsd: 1 });
  g.noteToolCall('Bash');
  g.noteUsage(2);
  assert.equal(g.check(0)?.budget, 'toolCalls'); // both crossed → tool calls first
  assert.equal(g.check(1)?.budget, 'estUsd'); // then the spend budget, once
  assert.equal(g.check(2), undefined);
});

// --- compact cost-base seeding ------------------------------------------------

test('maxEstUsd trips on the folded total after a compact respawn rebuild', () => {
  // Teardown drops the governor at compact; the rebuild is seeded with
  // meta.costBaseUsd so the spend counter never restarts at $0.
  const g = new StopGovernor({ ...base, maxEstUsd: 1.3 });
  g.noteUsage(1.25); // seed = costBaseUsd (pre-compact total + summarize spend)
  g.startTurn(0);
  assert.equal(g.check(1), undefined); // 1.25 < 1.30 — no trip yet
  g.noteUsage(1.25 + 0.15); // first folded post-respawn snapshot
  const trip = g.check(2);
  assert.ok(trip);
  assert.equal(trip.budget, 'estUsd');
  assert.ok(Math.abs(trip.estUsd - 1.4) < 1e-9);
  // Undefined seed (no compact yet) is a no-op.
  const g2 = new StopGovernor({ ...base, maxEstUsd: 1 });
  g2.noteUsage(undefined);
  g2.startTurn(0);
  assert.equal(g2.check(1), undefined);
});
