import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPrefixMutation,
  classifyHostPrefixMutation,
  evaluateCacheMissChip,
  formatCacheMissSummary,
  formatCacheTokens,
  parseCacheMissMode,
  parseCacheUsage
} from '../../src/shared/cacheMissChip';
import { ClaudeNormalizer } from '../../src/host/transports/normalizers/claude';
import { CodexNormalizer } from '../../src/host/transports/normalizers/codex';
import { reduce, initialState } from '../../webview-ui/src/store';

/** Claude Cache Diagnostics class — system prefix changed, 40k catalog missed. */
const CLAUDE_SYSTEM_MISS = {
  input_tokens: 120,
  cache_read_input_tokens: 800,
  cache_creation_input_tokens: 40_000,
  cache_missed_input_tokens: 40_000,
  system_changed: true,
  cache_diagnostics: {
    segments: { model: 'hit', tools: 'hit', system: 'miss', history: 'miss' }
  }
};

/** Generic ACP UsageInfo (camelCase) with cache fields, no segment. */
const GENERIC_USAGE = {
  inputTokens: 200,
  cacheReadTokens: 1800,
  cacheCreationTokens: 200
};

/** Codex turn.completed — cached_input_tokens ⊆ input_tokens. */
const CODEX_USAGE = {
  input_tokens: 11_779,
  cached_input_tokens: 4480,
  output_tokens: 6
};

test('formatCacheTokens compact labels', () => {
  assert.equal(formatCacheTokens(512), '512');
  assert.equal(formatCacheTokens(4200), '4.2k');
  assert.equal(formatCacheTokens(40_000), '40k');
  assert.equal(formatCacheTokens(1_200_000), '1.2m');
});

test('Claude system miss — chip available, warn, segment system', () => {
  const chip = evaluateCacheMissChip({
    usage: CLAUDE_SYSTEM_MISS,
    previous: {
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 40_800,
      missTokens: 40_800,
      totalPromptTokens: 40_900
    }
  });
  assert.equal(chip.available, true);
  assert.equal(chip.lastMissSegment, 'system');
  assert.equal(chip.warn, true);
  assert.match(chip.label, /cache /);
  assert.match(chip.label, /sys \+/);
  assert.match(chip.warnReason ?? '', /system/i);
  assert.match(formatCacheMissSummary(chip), /last miss: system/);
});

test('Claude diagnostics prefix-order: first miss is system (tools held)', () => {
  const chip = evaluateCacheMissChip({
    usage: {
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 5000,
      cache_diagnostics: {
        segments: { model: '✓', tools: '✓', system: '✗' }
      }
    }
  });
  assert.equal(chip.lastMissSegment, 'system');
  assert.equal(chip.warn, true);
});

test('tools_changed flag — tools segment, warn', () => {
  const chip = evaluateCacheMissChip({
    usage: {
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 9000,
      tools_changed: true
    }
  });
  assert.equal(chip.lastMissSegment, 'tools');
  assert.equal(chip.warn, true);
  assert.match(chip.label, /tools \+/);
});

test('history_changed — no warn (expected conversation growth)', () => {
  const chip = evaluateCacheMissChip({
    usage: {
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 400,
      input_tokens: 80,
      history_changed: true
    }
  });
  assert.equal(chip.lastMissSegment, 'history');
  assert.equal(chip.warn, false);
  assert.match(chip.label, /hist \+/);
});

test('first-turn cache write is not a consecutive miss', () => {
  const chip = evaluateCacheMissChip({
    usage: {
      input_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 40_000
    }
  });
  assert.equal(chip.available, true);
  assert.equal(chip.lastMissSegment, null);
  assert.equal(chip.warn, false);
  assert.match(chip.label, /cache write \+40k/);
  assert.match(chip.sourceDetail ?? '', /first-turn/i);
});

test('generic UsageInfo degrades to hit% when segment unknown', () => {
  const chip = evaluateCacheMissChip({ usage: GENERIC_USAGE });
  assert.equal(chip.available, true);
  assert.ok(chip.hitPct != null && chip.hitPct > 0);
  assert.equal(chip.lastMissSegment, 'unknown');
  assert.match(chip.label, /unk \+/);
  assert.match(formatCacheMissSummary(chip), /last miss: unknown/);
});

test('Codex cached_input_tokens — inclusive accounting, hit%', () => {
  const snap = parseCacheUsage(CODEX_USAGE);
  assert.ok(snap);
  assert.equal(snap.cacheReadTokens, 4480);
  assert.equal(snap.totalPromptTokens, 11_779);
  assert.equal(snap.missTokens, 11_779 - 4480);

  const chip = evaluateCacheMissChip({ usage: CODEX_USAGE });
  assert.equal(chip.available, true);
  assert.ok(chip.hitPct != null && chip.hitPct > 30 && chip.hitPct < 50);
  assert.equal(chip.lastMissSegment, 'unknown');
});

test('no cache fields → cache n/a', () => {
  const chip = evaluateCacheMissChip({ usage: { input_tokens: 100, output_tokens: 20 } });
  assert.equal(chip.available, false);
  assert.equal(chip.label, 'cache n/a');
  assert.equal(chip.warn, false);
  assert.match(formatCacheMissSummary(chip), /n\/a/);
});

test('null / empty usage → n/a, never throws', () => {
  assert.equal(evaluateCacheMissChip({ usage: null }).available, false);
  assert.equal(evaluateCacheMissChip({}).available, false);
  assert.equal(evaluateCacheMissChip({ usage: {} }).available, false);
});

test('full cache hit — no miss segment, high hit%', () => {
  const chip = evaluateCacheMissChip({
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 0
    }
  });
  assert.equal(chip.available, true);
  assert.ok((chip.hitPct ?? 0) >= 99);
  assert.equal(chip.label, `cache ${chip.hitPct}%`);
  assert.equal(chip.warn, false);
});

test('consecutive miss: prefix cache-read dropped vs prior write', () => {
  const previous = parseCacheUsage({
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 40_000
  });
  const chip = evaluateCacheMissChip({
    usage: {
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 40_000
    },
    previous
  });
  assert.equal(chip.lastMissSegment, 'unknown');
  assert.match(chip.sourceDetail ?? '', /dropped/i);
});

test('consecutive history: prefix held, new tokens are history', () => {
  const previous = parseCacheUsage({
    cache_read_input_tokens: 40_000,
    cache_creation_input_tokens: 200
  });
  const chip = evaluateCacheMissChip({
    usage: {
      cache_read_input_tokens: 40_200,
      cache_creation_input_tokens: 150,
      input_tokens: 40
    },
    previous
  });
  assert.equal(chip.lastMissSegment, 'history');
  assert.equal(chip.warn, false);
});

test('host clock mutation overlays segment when vendor omitted it', () => {
  const chip = evaluateCacheMissChip({
    usage: GENERIC_USAGE,
    hostMutation: { injectsClock: true }
  });
  assert.equal(chip.lastMissSegment, 'system');
  assert.equal(chip.warn, true);
  assert.match(chip.sourceDetail ?? '', /clock/i);
});

test('classifyHostPrefixMutation maps flags to segments', () => {
  assert.equal(classifyHostPrefixMutation({ injectsNonce: true })?.segment, 'system');
  assert.equal(
    classifyHostPrefixMutation({ dynamicHeaderBeforeStablePrefix: true })?.segment,
    'system'
  );
  assert.equal(classifyHostPrefixMutation({ toolsReordered: true })?.segment, 'tools');
  assert.equal(classifyHostPrefixMutation({ toolsAdded: true })?.segment, 'tools');
  assert.equal(classifyHostPrefixMutation({}), null);
});

test('pre-send prefix mutation warns, never blocks; off skips', () => {
  const warn = checkPrefixMutation({
    mutation: { injectsClock: true },
    mode: 'warn'
  });
  assert.equal(warn.action, 'warn');
  assert.equal(warn.segment, 'system');
  assert.match(warn.message ?? '', /clock/i);

  const off = checkPrefixMutation({
    mutation: { injectsClock: true },
    mode: 'off'
  });
  assert.equal(off.action, 'allow');

  const none = checkPrefixMutation({ mutation: {}, mode: 'warn' });
  assert.equal(none.action, 'allow');
});

test('parseCacheMissMode defaults to warn', () => {
  assert.equal(parseCacheMissMode('off'), 'off');
  assert.equal(parseCacheMissMode('warn'), 'warn');
  assert.equal(parseCacheMissMode('nope'), 'warn');
  assert.equal(parseCacheMissMode(undefined), 'warn');
});

test('vendor miss_segment string aliases', () => {
  assert.equal(
    evaluateCacheMissChip({
      usage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 9, miss_segment: 'sys' }
    }).lastMissSegment,
    'system'
  );
  assert.equal(
    evaluateCacheMissChip({
      usage: { cache_read_input_tokens: 1, cache_creation_input_tokens: 9, cacheMissReason: 'mcp' }
    }).lastMissSegment,
    'tools'
  );
});

test('ClaudeNormalizer emits cache_miss_update from assistant usage', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: CLAUDE_SYSTEM_MISS
    }
  } as never);
  const miss = out.find((u) => u.kind === 'cache_miss_update');
  assert.ok(miss && miss.kind === 'cache_miss_update');
  assert.equal(miss.available, true);
  assert.equal(miss.lastMissSegment, 'system');
  assert.equal(miss.warn, true);
  const usage = out.find((u) => u.kind === 'usage');
  assert.ok(usage && usage.kind === 'usage');
  assert.equal(usage.usage.cacheCreationTokens, 40_000);

  const dup = n.parseLine({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'again' }],
      usage: CLAUDE_SYSTEM_MISS
    }
  } as never);
  assert.ok(!dup.some((u) => u.kind === 'cache_miss_update'));
});

test('ClaudeNormalizer result usage includes cache_creation and cache_miss_update', () => {
  const n = new ClaudeNormalizer();
  const out = n.parseLine({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 120,
      output_tokens: 10,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40_000,
      system_changed: true
    }
  } as never);
  const result = out.find((u) => u.kind === 'result');
  assert.ok(result && result.kind === 'result');
  assert.equal(result.usage?.cacheCreationTokens, 40_000);
  const miss = out.find((u) => u.kind === 'cache_miss_update');
  assert.ok(miss && miss.kind === 'cache_miss_update');
  assert.equal(miss.lastMissSegment, 'system');
});

test('CodexNormalizer emits cache_miss_update on turn.completed', () => {
  const n = new CodexNormalizer();
  const out = n.parseLine({
    type: 'turn.completed',
    usage: CODEX_USAGE
  });
  const miss = out.find((u) => u.kind === 'cache_miss_update');
  assert.ok(miss && miss.kind === 'cache_miss_update');
  assert.equal(miss.available, true);
  assert.ok((miss.hitPct ?? 0) > 30);
});

test('webview reducer stores cache_miss_update on ChatState.cacheMiss', () => {
  const chip = evaluateCacheMissChip({ usage: CLAUDE_SYSTEM_MISS });
  const next = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'cache_miss_update',
      available: chip.available,
      hitPct: chip.hitPct,
      lastMissSegment: chip.lastMissSegment,
      lastMissTokens: chip.lastMissTokens,
      cacheReadTokens: chip.cacheReadTokens,
      cacheCreationTokens: chip.cacheCreationTokens,
      label: chip.label,
      warn: chip.warn,
      warnReason: chip.warnReason,
      sourceDetail: chip.sourceDetail
    }
  });
  assert.ok(next.cacheMiss);
  assert.equal(next.cacheMiss!.lastMissSegment, 'system');
  assert.equal(next.cacheMiss!.warn, true);
});

test('historyLoaded clears stale cacheMiss until a persisted update re-applies', () => {
  const withChip = reduce(initialState, {
    type: 'sessionUpdate',
    sessionId: 's1',
    update: {
      kind: 'cache_miss_update',
      available: true,
      hitPct: 12,
      lastMissSegment: 'system',
      lastMissTokens: 40_000,
      cacheReadTokens: 800,
      cacheCreationTokens: 40_000,
      label: 'cache 12% · sys +40k',
      warn: true
    }
  });
  assert.equal(withChip.cacheMiss?.label, 'cache 12% · sys +40k');

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
  assert.equal(cleared.cacheMiss, null);

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
          kind: 'cache_miss_update',
          available: true,
          hitPct: 80,
          lastMissSegment: 'history',
          lastMissTokens: 400,
          cacheReadTokens: 8000,
          cacheCreationTokens: 400,
          label: 'cache 80% · hist +400',
          warn: false
        }
      }
    ]
  });
  assert.equal(restored.cacheMiss?.label, 'cache 80% · hist +400');
  assert.equal(restored.cacheMiss?.lastMissSegment, 'history');
});

test('HostToWebview cacheMiss message updates chip without SessionUpdate', () => {
  const next = reduce(initialState, {
    type: 'cacheMiss',
    chip: {
      available: true,
      hitPct: 1.5,
      lastMissSegment: 'tools',
      lastMissTokens: 12_000,
      cacheReadTokens: 200,
      cacheCreationTokens: 12_000,
      label: 'cache 1.5% · tools +12k',
      warn: true,
      warnReason: 'Last prompt-cache miss was tools.'
    }
  });
  assert.equal(next.cacheMiss?.label, 'cache 1.5% · tools +12k');
  assert.equal(next.cacheMiss?.warn, true);

  const cleared = reduce(next, { type: 'cacheMiss', chip: null });
  assert.equal(cleared.cacheMiss, null);
});
