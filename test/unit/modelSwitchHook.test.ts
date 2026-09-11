// Pre/Post model-switch host hook bus (kp:
// ideas/cb-pre-post-model-switch-host-hook-bus-block-con). Mock ACP
// initialize + model override via ModelSwitchTracker — no VS Code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelSwitchTracker,
  applyModelSwitch,
  estimateRecache,
  evaluatePreModelSwitch,
  formatModelSwitchChipLabel,
  formatRecacheCost,
  formatRecacheTokens,
  measurePostSwitchMiss,
  modelSwitchChip,
  normalizeModelId,
  parseModelSwitchPolicy
} from '../../src/shared/modelSwitchHook';
import { reduce, initialState } from '../../webview-ui/src/store';

test('parseModelSwitchPolicy defaults to confirm', () => {
  assert.equal(parseModelSwitchPolicy('confirm'), 'confirm');
  assert.equal(parseModelSwitchPolicy('allow'), 'allow');
  assert.equal(parseModelSwitchPolicy('block'), 'block');
  for (const bad of [null, undefined, '', 'warn', 'off', 1]) {
    assert.equal(parseModelSwitchPolicy(bad), 'confirm');
  }
});

test('normalizeModelId collapses default/auto/empty', () => {
  assert.equal(normalizeModelId(undefined), '');
  assert.equal(normalizeModelId('default'), '');
  assert.equal(normalizeModelId('auto'), '');
  assert.equal(normalizeModelId('  '), '');
  assert.equal(normalizeModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('estimateRecache prefers warm cache_read; never invents dollars', () => {
  assert.deepEqual(estimateRecache(null), { tokens: null, dollars: null });
  assert.deepEqual(estimateRecache({ cacheReadTokens: 4200, inputTokens: 800 }), {
    tokens: 4200,
    dollars: null
  });
  assert.deepEqual(estimateRecache({ inputTokens: 800 }), {
    tokens: 800,
    dollars: null
  });
  assert.equal(formatRecacheCost(null), 'unknown');
  assert.equal(formatRecacheTokens(4200), '~4.2k');
  assert.equal(formatRecacheTokens(null), 'unknown');
});

test('chip label: switch · ~Nk re-cache / unknown', () => {
  assert.equal(
    formatModelSwitchChipLabel({ tokens: 4200, dollars: null }),
    'switch · ~4.2k re-cache'
  );
  assert.equal(
    formatModelSwitchChipLabel({ tokens: null, dollars: null }),
    'switch · unknown re-cache'
  );
  const chip = modelSwitchChip({
    from: 'claude-sonnet-4-6',
    to: 'grok-build',
    estimatedTokens: 12_000,
    measuredMissTokens: null
  });
  assert.equal(chip.label, 'switch · ~12k re-cache');
  assert.equal(chip.warn, true);
});

test('same model is noop — does not send', () => {
  const r = applyModelSwitch({
    policy: 'confirm',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'claude-sonnet-4-6',
    source: 'picker',
    cacheReadTokens: 4000
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.sent, false);
  assert.equal(r.applied, false);
});

test('initial pick before telemetry is noop', () => {
  const r = applyModelSwitch({
    policy: 'confirm',
    fromModel: undefined,
    toModel: 'claude-sonnet-4-6',
    source: 'picker'
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.sent, false);
});

test('failover source always allows (distinct from this gate)', () => {
  const r = applyModelSwitch({
    policy: 'block',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'grok-build',
    source: 'failover',
    cacheReadTokens: 4000
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.sent, true);
  assert.match(r.reason ?? '', /failover/);
});

test('mock ACP initialize + model override: confirm does not send until approved', () => {
  const t = new ModelSwitchTracker();
  // Warm cache after a turn (ACP initialize + usage).
  t.observeCache({ cacheReadTokens: 4200, lastMissTokens: 0, inputTokens: 800 });
  const pending = t.apply({
    policy: 'confirm',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'grok-build',
    source: 'picker'
  });
  assert.equal(pending.action, 'confirm');
  assert.equal(pending.sent, false);
  assert.equal(pending.applied, false);
  assert.equal(pending.chip, null);
  assert.ok(pending.dialog);
  assert.match(pending.dialog!.title, /claude-sonnet-4-6.*grok-build/);
  assert.match(pending.dialog!.detail, /~4\.2k/);
  assert.match(pending.dialog!.detail, /\$ unknown/);
  assert.equal(t.lastChip, null);

  const approved = t.apply({
    policy: 'confirm',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'grok-build',
    source: 'picker',
    confirmed: true
  });
  assert.equal(approved.action, 'confirm');
  assert.equal(approved.sent, true);
  assert.equal(approved.applied, true);
  assert.equal(approved.chip?.label, 'switch · ~4.2k re-cache');
  assert.equal(approved.record?.to, 'grok-build');
});

test('block path never sends — keeps prior model', () => {
  const t = new ModelSwitchTracker();
  t.observeCache({ cacheReadTokens: 9000, inputTokens: 200 });
  const r = t.apply({
    policy: 'block',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'grok-build',
    source: 'override'
  });
  assert.equal(r.action, 'block');
  assert.equal(r.sent, false);
  assert.equal(r.applied, false);
  assert.equal(r.chip, null);
  assert.match(r.notice ?? '', /kept claude-sonnet-4-6/);
  assert.equal(t.pending, null);
});

test('allow policy commits immediately', () => {
  const r = applyModelSwitch({
    policy: 'allow',
    fromModel: 'claude-sonnet-4-6',
    toModel: 'claude-opus-4-7',
    source: 'picker',
    cacheReadTokens: 1500
  });
  assert.equal(r.action, 'allow');
  assert.equal(r.sent, true);
  assert.equal(r.applied, true);
  assert.equal(r.chip?.label, 'switch · ~1.5k re-cache');
});

test('post-hook folds measured cache miss into the chip', () => {
  const t = new ModelSwitchTracker();
  t.observeCache({ cacheReadTokens: 8000, inputTokens: 400 });
  const committed = t.apply({
    policy: 'allow',
    fromModel: 'a',
    toModel: 'b',
    source: 'picker'
  });
  assert.equal(committed.record?.measuredMissTokens, null);
  const chip = t.observeCache({ lastMissTokens: 8100, cacheReadTokens: 0, inputTokens: 8100 });
  assert.ok(chip);
  assert.equal(chip!.measuredMissTokens, 8100);
  assert.equal(chip!.label, 'switch · ~8.1k re-cache');
  assert.equal(t.pending, null);
});

test('measurePostSwitchMiss does not invent when next usage is empty', () => {
  const updated = measurePostSwitchMiss(
    {
      from: 'a',
      to: 'b',
      at: 1,
      estimatedTokens: null,
      measuredMissTokens: null
    },
    {}
  );
  assert.equal(updated.measuredMissTokens, null);
});

test('evaluatePreModelSwitch confirm dialog mentions unknown when no tokens', () => {
  const d = evaluatePreModelSwitch({
    policy: 'confirm',
    fromModel: 'sonnet',
    toModel: 'opus',
    source: 'picker',
    estimate: { tokens: null, dollars: null },
    hasTelemetry: true
  });
  assert.equal(d.action, 'confirm');
  assert.match(d.dialog?.detail ?? '', /unknown tokens/);
});

test('webview reducer stores HostToWebview modelSwitch chip', () => {
  const next = reduce(initialState, {
    type: 'modelSwitch',
    chip: {
      available: true,
      label: 'switch · ~4.2k re-cache',
      fromModel: 'claude-sonnet-4-6',
      toModel: 'grok-build',
      estimatedTokens: 4200,
      measuredMissTokens: null,
      warn: false
    }
  });
  assert.equal(next.modelSwitch?.label, 'switch · ~4.2k re-cache');
  assert.equal(next.modelSwitch?.toModel, 'grok-build');
});

test('historyLoaded clears stale modelSwitch (live-only chip)', () => {
  const withChip = reduce(initialState, {
    type: 'modelSwitch',
    chip: {
      available: true,
      label: 'switch · ~4.2k re-cache',
      fromModel: 'a',
      toModel: 'b',
      estimatedTokens: 4200,
      measuredMissTokens: null,
      warn: false
    }
  });
  assert.equal(withChip.modelSwitch?.label, 'switch · ~4.2k re-cache');
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
  assert.equal(cleared.modelSwitch, null);
});

test('modelSwitch null clears the chip', () => {
  const withChip = reduce(initialState, {
    type: 'modelSwitch',
    chip: {
      available: true,
      label: 'switch · unknown re-cache',
      fromModel: 'a',
      toModel: 'b',
      estimatedTokens: null,
      measuredMissTokens: null,
      warn: false
    }
  });
  const cleared = reduce(withChip, { type: 'modelSwitch', chip: null });
  assert.equal(cleared.modelSwitch, null);
});
