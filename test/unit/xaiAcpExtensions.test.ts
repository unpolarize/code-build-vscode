import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_XAI_CAPS,
  XAI_COMPACT,
  XAI_GIT_INFO,
  XAI_REWIND_EXECUTE,
  compactConversationParams,
  decideCompactRoute,
  gitInfoParams,
  nativeCompactSummaryPreview,
  parseGitInfoBadge,
  parseXaiExtensionCaps,
  rewindExecuteParams,
  truncateRecordsToUserTurn,
  unsupportedNotice
} from '../../src/shared/xaiAcpExtensions';

// ── capability gating ─────────────────────────────────────────────────────

test('missing initialize → all caps false (safe default)', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const caps = parseXaiExtensionCaps(bad);
    assert.deepEqual(caps, EMPTY_XAI_CAPS);
    assert.equal(decideCompactRoute(caps), 'fallback');
  }
});

test('Claude-shaped initialize (no x.ai methods) → fallback compact, no rewind/git', () => {
  const caps = parseXaiExtensionCaps({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { close: {} }
    }
  });
  assert.equal(caps.compact, false);
  assert.equal(caps.rewind, false);
  assert.equal(caps.gitInfo, false);
  assert.equal(decideCompactRoute(caps), 'fallback');
});

test('methods list advertising x.ai extensions → all three v1 bridges', () => {
  const caps = parseXaiExtensionCaps({
    methods: [
      'session/prompt',
      'x.ai/compact_conversation',
      'x.ai/rewind/execute',
      'x.ai/git/info'
    ]
  });
  assert.equal(caps.compact, true);
  assert.equal(caps.rewind, true);
  assert.equal(caps.gitInfo, true);
  assert.equal(decideCompactRoute(caps), 'native');
});

test('compact-only methods list does not light rewind or git', () => {
  const caps = parseXaiExtensionCaps({
    methods: ['x.ai/compact_conversation']
  });
  assert.equal(caps.compact, true);
  assert.equal(caps.rewind, false);
  assert.equal(caps.gitInfo, false);
});

test('parent method prefix x.ai/rewind / x.ai/git advertises child bridges', () => {
  const caps = parseXaiExtensionCaps({
    methods: ['x.ai/rewind', 'x.ai/git']
  });
  assert.equal(caps.rewind, true);
  assert.equal(caps.gitInfo, true);
  assert.equal(caps.compact, false);
});

test('grokShell initialize (Grok does not list methods) → native compact + rewind + git', () => {
  const caps = parseXaiExtensionCaps({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      _meta: { 'x.ai/fs_notify': true }
    },
    _meta: {
      grokShell: true,
      cancelRewind: true,
      availableCommands: [{ name: 'compact' }, { name: 'rewind' }]
    }
  });
  assert.equal(caps.compact, true);
  assert.equal(caps.rewind, true);
  assert.equal(caps.gitInfo, true);
  assert.equal(decideCompactRoute(caps), 'native');
});

test('agentCapabilities._meta method flags', () => {
  const caps = parseXaiExtensionCaps({
    agentCapabilities: {
      _meta: {
        'x.ai/compact_conversation': true,
        'x.ai/rewind/execute': false
      }
    }
  });
  assert.equal(caps.compact, true);
  assert.equal(caps.rewind, false);
});

test('availableCommands compact without grokShell still gates compact', () => {
  const caps = parseXaiExtensionCaps({
    _meta: { availableCommands: [{ name: 'compact' }] }
  });
  assert.equal(caps.compact, true);
  assert.equal(caps.rewind, false);
});

test('decideCompactRoute: null/empty → fallback; compact true → native', () => {
  assert.equal(decideCompactRoute(null), 'fallback');
  assert.equal(decideCompactRoute(undefined), 'fallback');
  assert.equal(decideCompactRoute(EMPTY_XAI_CAPS), 'fallback');
  assert.equal(decideCompactRoute({ compact: true, rewind: false, gitInfo: false }), 'native');
});

test('unsupported method → one-line notice, never an exception', () => {
  const n = unsupportedNotice(XAI_COMPACT);
  assert.match(n, /x\.ai\/compact_conversation/);
  assert.match(n, /not advertised/i);
  assert.match(n, /no-op/i);
});

// ── request builders ──────────────────────────────────────────────────────

test('compactConversationParams: sessionId required; focus → userContext', () => {
  assert.deepEqual(compactConversationParams('sess-1'), { sessionId: 'sess-1' });
  assert.deepEqual(compactConversationParams('sess-1', ' keep auth '), {
    sessionId: 'sess-1',
    userContext: 'keep auth'
  });
  assert.deepEqual(compactConversationParams('sess-1', '  '), { sessionId: 'sess-1' });
});

test('rewindExecuteParams + gitInfoParams', () => {
  assert.deepEqual(rewindExecuteParams('s', 3), {
    sessionId: 's',
    targetPromptIndex: 3,
    force: false
  });
  assert.deepEqual(gitInfoParams(), {});
  assert.deepEqual(gitInfoParams('s'), { sessionId: 's' });
});

// ── git badge ─────────────────────────────────────────────────────────────

test('parseGitInfoBadge: camelCase currentBranch', () => {
  const b = parseGitInfoBadge({
    currentBranch: 'auto/night-build',
    root: '/repo'
  });
  assert.equal(b?.branch, 'auto/night-build');
  assert.equal(b?.label, 'git auto/night-build');
  assert.equal(b?.root, '/repo');
});

test('parseGitInfoBadge: wrapped result + snake_case', () => {
  const b = parseGitInfoBadge({
    result: { current_branch: 'main', repo_root: '/x' }
  });
  assert.equal(b?.branch, 'main');
  assert.equal(b?.root, '/x');
});

test('parseGitInfoBadge: missing branch → null (no badge)', () => {
  assert.equal(parseGitInfoBadge(null), null);
  assert.equal(parseGitInfoBadge({}), null);
  assert.equal(parseGitInfoBadge({ root: '/repo' }), null);
});

// ── rewind truncation ─────────────────────────────────────────────────────

test('truncateRecordsToUserTurn: keeps target user row, drops later turns', () => {
  const recs = [
    { type: 'update', n: 0 },
    { type: 'user', n: 1 },
    { type: 'update', n: 2 },
    { type: 'user', n: 3 },
    { type: 'update', n: 4 },
    { type: 'user', n: 5 }
  ];
  const cut = truncateRecordsToUserTurn(recs, 1);
  assert.deepEqual(
    cut.map((r) => r.n),
    [0, 1, 2, 3]
  );
  assert.equal(cut[cut.length - 1].type, 'user');
});

test('truncateRecordsToUserTurn: index 0 keeps first user turn only (plus prefix)', () => {
  const recs = [
    { type: 'update' },
    { type: 'user' },
    { type: 'update' },
    { type: 'user' }
  ];
  const cut = truncateRecordsToUserTurn(recs, 0);
  assert.equal(cut.length, 2);
  assert.equal(cut[1].type, 'user');
});

test('truncateRecordsToUserTurn: missing/invalid index is a no-op', () => {
  const recs = [{ type: 'user' }, { type: 'user' }];
  assert.equal(truncateRecordsToUserTurn(recs, 9), recs);
  assert.equal(truncateRecordsToUserTurn(recs, -1), recs);
  assert.equal(truncateRecordsToUserTurn(recs, 1.5), recs);
  assert.deepEqual(truncateRecordsToUserTurn([], 0), []);
});

test('nativeCompactSummaryPreview includes optional focus', () => {
  assert.match(nativeCompactSummaryPreview(), /compact_conversation/);
  assert.match(nativeCompactSummaryPreview('auth'), /Focus: auth/);
});

test('v1 method constants match grok-build wire names', () => {
  assert.equal(XAI_COMPACT, 'x.ai/compact_conversation');
  assert.equal(XAI_REWIND_EXECUTE, 'x.ai/rewind/execute');
  assert.equal(XAI_GIT_INFO, 'x.ai/git/info');
});
