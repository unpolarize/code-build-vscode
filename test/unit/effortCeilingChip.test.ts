import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEffortAgainstCeiling,
  compareEffort,
  evaluateEffortCeilingChip,
  isEffortAboveCeiling,
  parseEffortCeilingFromAgent,
  parseEffortCeilingMode,
  parseHostMaxEffortLevel,
  resolveEffortCeiling
} from '../../src/shared/effortCeilingChip';
import { reduce, initialState } from '../../webview-ui/src/store';

/** Claude 2.1.267 top-level maxEffortLevel (org/user settings class). */
const CLAUDE_MANAGED_FIXTURE = {
  maxEffortLevel: 'high'
};

/** Per-model ceiling under modelSettings. */
const CLAUDE_MODEL_SETTINGS_FIXTURE = {
  modelSettings: {
    'claude-opus-4-7': { maxEffortLevel: 'medium' },
    'claude-sonnet-4-6': { maxEffortLevel: 'high' }
  }
};

/** codex-acp 1.11.0 recommended model + reasoning effort. */
const CODEX_RECOMMENDED_FIXTURE = {
  recommended: { model: 'gpt-5', effort: 'high' }
};

test('Claude managed maxEffortLevel — chip available, no warn under ceiling', () => {
  const chip = evaluateEffortCeilingChip({
    agentFields: CLAUDE_MANAGED_FIXTURE,
    selected: 'medium'
  });
  assert.equal(chip.available, true);
  assert.equal(chip.ceiling, 'high');
  assert.equal(chip.source, 'managed');
  assert.equal(chip.label, 'ceil high · managed');
  assert.equal(chip.warn, false);
  assert.match(chip.sourceDetail ?? '', /maxEffortLevel/);
});

test('Selected above managed ceiling — warn chip', () => {
  const chip = evaluateEffortCeilingChip({
    agentFields: CLAUDE_MANAGED_FIXTURE,
    selected: 'max'
  });
  assert.equal(chip.warn, true);
  assert.match(chip.warnReason ?? '', /max.*above.*high/i);
});

test('default effort never counts as above ceiling', () => {
  assert.equal(isEffortAboveCeiling('default', 'low'), false);
  assert.equal(isEffortAboveCeiling('high', 'medium'), true);
  assert.equal(isEffortAboveCeiling('medium', 'medium'), false);
  assert.ok(compareEffort('max', 'low') > 0);
});

test('Per-model modelSettings.maxEffortLevel respects modelId', () => {
  const opus = parseEffortCeilingFromAgent(CLAUDE_MODEL_SETTINGS_FIXTURE, {
    modelId: 'claude-opus-4-7'
  });
  assert.equal(opus?.ceiling, 'medium');
  assert.equal(opus?.source, 'managed');

  const sonnet = parseEffortCeilingFromAgent(CLAUDE_MODEL_SETTINGS_FIXTURE, {
    modelId: 'claude-sonnet-4-6'
  });
  assert.equal(sonnet?.ceiling, 'high');
});

test('codex-acp recommended effort — agent-recommended source', () => {
  const hit = parseEffortCeilingFromAgent(CODEX_RECOMMENDED_FIXTURE);
  assert.equal(hit?.ceiling, 'high');
  assert.equal(hit?.source, 'agent-recommended');
  assert.match(hit?.sourceDetail ?? '', /codex-acp/i);

  const chip = evaluateEffortCeilingChip({
    agentFields: CODEX_RECOMMENDED_FIXTURE,
    selected: 'xhigh'
  });
  assert.equal(chip.label, 'ceil high · rec');
  assert.equal(chip.warn, true);
});

test('managed maxEffortLevel beats recommended when both present', () => {
  const hit = parseEffortCeilingFromAgent({
    maxEffortLevel: 'medium',
    recommended: { effort: 'max' }
  });
  assert.equal(hit?.ceiling, 'medium');
  assert.equal(hit?.source, 'managed');
});

test('Host codeBuild.maxEffortLevel wins over agent managed', () => {
  const hit = resolveEffortCeiling({
    hostMaxEffortLevel: 'low',
    agentFields: CLAUDE_MANAGED_FIXTURE
  });
  assert.equal(hit?.ceiling, 'low');
  assert.equal(hit?.source, 'local');
  assert.equal(hit?.sourceDetail, 'codeBuild.maxEffortLevel');
});

test('parseHostMaxEffortLevel — empty/default/none → null', () => {
  for (const bad of [null, undefined, '', 'none', 'off', 'default', 'nope']) {
    assert.equal(parseHostMaxEffortLevel(bad), null);
  }
  assert.equal(parseHostMaxEffortLevel('xhigh')?.ceiling, 'xhigh');
});

test('Missing ceiling → available:false / ceil n/a (never invent)', () => {
  for (const bad of [null, undefined, {}, { agentCapabilities: {} }]) {
    const chip = evaluateEffortCeilingChip({ agentFields: bad as any, selected: 'high' });
    assert.equal(chip.available, false);
    assert.equal(chip.label, 'ceil n/a');
    assert.equal(chip.ceiling, null);
    assert.equal(chip.warn, false);
  }
});

test('camelCase / snake_case / _meta shapes accepted', () => {
  assert.equal(
    parseEffortCeilingFromAgent({ max_effort_level: 'low' })?.ceiling,
    'low'
  );
  assert.equal(
    parseEffortCeilingFromAgent({
      _meta: { maxEffortLevel: 'medium' }
    })?.ceiling,
    'medium'
  );
  assert.equal(
    parseEffortCeilingFromAgent({
      _meta: { recommended_effort: 'high' }
    })?.source,
    'agent-recommended'
  );
});

test('Gate — warn mode allows with message; block mode blocks', () => {
  const warn = checkEffortAgainstCeiling({
    selected: 'max',
    agentFields: CLAUDE_MANAGED_FIXTURE,
    mode: 'warn'
  });
  assert.equal(warn.action, 'warn');
  assert.match(warn.message ?? '', /exceeds.*high/i);

  const block = checkEffortAgainstCeiling({
    selected: 'max',
    agentFields: CLAUDE_MANAGED_FIXTURE,
    mode: 'block'
  });
  assert.equal(block.action, 'block');
  assert.match(block.message ?? '', /Send blocked/i);

  const off = checkEffortAgainstCeiling({
    selected: 'max',
    agentFields: CLAUDE_MANAGED_FIXTURE,
    mode: 'off'
  });
  assert.equal(off.action, 'allow');

  const under = checkEffortAgainstCeiling({
    selected: 'medium',
    agentFields: CLAUDE_MANAGED_FIXTURE,
    mode: 'block'
  });
  assert.equal(under.action, 'allow');
});

test('parseEffortCeilingMode defaults to warn', () => {
  assert.equal(parseEffortCeilingMode('block'), 'block');
  assert.equal(parseEffortCeilingMode('off'), 'off');
  assert.equal(parseEffortCeilingMode('nope'), 'warn');
  assert.equal(parseEffortCeilingMode(undefined), 'warn');
});

test('webview reducer stores effort_ceiling_update on ChatState.effortCeiling', () => {
  const chip = evaluateEffortCeilingChip({
    agentFields: CLAUDE_MANAGED_FIXTURE,
    selected: 'max'
  });
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'effort_ceiling_update',
      available: chip.available,
      ceiling: chip.ceiling,
      selected: chip.selected,
      source: chip.source,
      sourceDetail: chip.sourceDetail,
      label: chip.label,
      warn: chip.warn,
      warnReason: chip.warnReason
    }
  });
  assert.ok(next.effortCeiling);
  assert.equal(next.effortCeiling!.label, 'ceil high · managed');
  assert.equal(next.effortCeiling!.warn, true);
  assert.equal(next.effortCeiling!.source, 'managed');
});

test('historyLoaded clears stale effortCeiling until a persisted update re-applies', () => {
  const withChip = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'effort_ceiling_update',
      available: true,
      ceiling: 'high',
      selected: 'medium',
      source: 'local',
      sourceDetail: 'codeBuild.maxEffortLevel',
      label: 'ceil high · local',
      warn: false
    }
  });
  assert.equal(withChip.effortCeiling?.label, 'ceil high · local');

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
  assert.equal(cleared.effortCeiling, null);

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
          kind: 'effort_ceiling_update',
          available: true,
          ceiling: 'medium',
          selected: 'low',
          source: 'managed',
          label: 'ceil med · managed',
          warn: false
        }
      }
    ]
  });
  assert.equal(restored.effortCeiling?.label, 'ceil med · managed');
  assert.equal(restored.effortCeiling?.ceiling, 'medium');
});

test('HostToWebview effortCeiling message updates chip without SessionUpdate', () => {
  const next = reduce(initialState, {
    type: 'effortCeiling',
    chip: {
      available: true,
      ceiling: 'low',
      selected: 'high',
      source: 'local',
      sourceDetail: 'codeBuild.maxEffortLevel',
      label: 'ceil low · local',
      warn: true,
      warnReason: 'Selected effort "high" is above the local ceiling "low".'
    }
  });
  assert.equal(next.effortCeiling?.label, 'ceil low · local');
  assert.equal(next.effortCeiling?.warn, true);

  const cleared = reduce(next, { type: 'effortCeiling', chip: null });
  assert.equal(cleared.effortCeiling, null);
});
