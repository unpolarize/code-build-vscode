// Concurrent-session permission ballot
// (kp: ideas/cb-concurrent-session-permission-ballot-majority)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionOutcome, ToolCall } from '../../src/shared/acpTypes';
import {
  BALLOT_AUTO_DENY_DEFAULT,
  BALLOT_AUTO_DENY_MS,
  PermissionBallotHub,
  ballotInfoForHead,
  classifyHighRisk,
  fingerprintToolCall,
  formatBallotLog,
  groupPendingBallots,
  isAutoDenyDue,
  normalizeCommand,
  normalizePath,
  pickAllowOutcome,
  pickDenyOutcome,
  reduceBallot,
  type BallotPending
} from '../../src/shared/permissionBallot';

const ALLOW = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
];

const writeTool = (path: string, extra?: Partial<ToolCall>): ToolCall => ({
  toolCallId: extra?.toolCallId ?? 'tc-write',
  title: 'Write',
  kind: 'write',
  status: 'pending',
  locations: [{ path }],
  ...extra
});

const bashTool = (command: string, extra?: Partial<ToolCall>): ToolCall => ({
  toolCallId: extra?.toolCallId ?? 'tc-bash',
  title: 'Bash',
  kind: 'execute',
  status: 'pending',
  rawInput: { command },
  ...extra
});

const pending = (
  requestId: string,
  sessionId: string,
  backend: string,
  tool: ToolCall,
  options = ALLOW
): BallotPending => ({ requestId, sessionId, backend, tool, options });

describe('normalizePath', () => {
  it('collapses slashes, dots, and file://', () => {
    assert.equal(normalizePath('file:///tmp/a.ts'), '/tmp/a.ts');
    assert.equal(normalizePath('file://localhost/tmp/a.ts'), '/tmp/a.ts');
    assert.equal(normalizePath('/tmp//foo/./bar/../a.ts'), '/tmp/foo/a.ts');
    assert.equal(normalizePath('/tmp/a.ts/'), '/tmp/a.ts');
    assert.equal(normalizePath('src\\foo.ts'), 'src/foo.ts');
  });
});

describe('normalizeCommand', () => {
  it('trims and collapses whitespace', () => {
    assert.equal(normalizeCommand('  git   status\n'), 'git status');
  });
});

describe('fingerprintToolCall', () => {
  it('is backend-agnostic: same Write path → same key', () => {
    const a = fingerprintToolCall(writeTool('/tmp/a.ts', { toolCallId: '1' }));
    const b = fingerprintToolCall(writeTool('/tmp/a.ts/', { toolCallId: '2', title: 'edit', kind: 'edit' }));
    assert.equal(a.method, 'write');
    assert.equal(a.key, b.key);
    assert.equal(a.key, 'write|/tmp/a.ts');
  });

  it('normalizes execute commands and ignores backend-specific titles', () => {
    const a = fingerprintToolCall(bashTool('git  status'));
    const b = fingerprintToolCall({
      toolCallId: 'x',
      title: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { cmd: 'git status' }
    });
    assert.equal(a.key, b.key);
    assert.equal(a.method, 'execute');
  });

  it('does not group unknown-target writes (unique per toolCallId)', () => {
    const a = fingerprintToolCall({ toolCallId: 'a', title: 'Write', kind: 'write', status: 'pending' });
    const b = fingerprintToolCall({ toolCallId: 'b', title: 'Write', kind: 'write', status: 'pending' });
    assert.notEqual(a.key, b.key);
  });

  it('reads Write path from rawInput / diff when locations are missing', () => {
    const fromRaw = fingerprintToolCall({
      toolCallId: 'r',
      title: 'Write',
      status: 'pending',
      rawInput: { path: '/repo/x.ts' }
    });
    const fromDiff = fingerprintToolCall({
      toolCallId: 'd',
      title: 'Write',
      status: 'pending',
      content: [{ type: 'diff', path: '/repo/x.ts', oldText: '', newText: 'x' }]
    });
    assert.equal(fromRaw.key, 'write|/repo/x.ts');
    assert.equal(fromRaw.key, fromDiff.key);
  });
});

describe('classifyHighRisk', () => {
  it('flags force-push, rm -rf, and secrets paths', () => {
    assert.equal(classifyHighRisk(bashTool('git push --force origin main')), 'force-push');
    assert.equal(classifyHighRisk(bashTool('git push -f')), 'force-push');
    assert.equal(classifyHighRisk(bashTool('rm -rf /tmp/x')), 'rm-rf');
    assert.equal(classifyHighRisk(bashTool('rm -fr .')), 'rm-rf');
    assert.equal(classifyHighRisk(writeTool('/repo/.env')), 'secrets-path');
    assert.equal(classifyHighRisk(writeTool('/home/u/.ssh/id_rsa')), 'secrets-path');
    assert.equal(classifyHighRisk(writeTool('/repo/src/a.ts')), null);
    assert.equal(classifyHighRisk(bashTool('git status')), null);
  });
});

describe('group + reduceBallot', () => {
  it('groups two backends on identical Write(path)', () => {
    const groups = groupPendingBallots([
      pending('r1', 's-claude', 'claude', writeTool('/tmp/a.ts', { toolCallId: 't1' })),
      pending('r2', 's-grok', 'grok', writeTool('/tmp/a.ts', { toolCallId: 't2' }))
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].members.length, 2);
    assert.equal(groups[0].fingerprint.key, 'write|/tmp/a.ts');
  });

  it('Approve-all clears both; Deny-any denies both', () => {
    const pair = [
      pending('r1', 's-claude', 'claude', writeTool('/tmp/a.ts', { toolCallId: 't1' })),
      pending('r2', 's-grok', 'grok', writeTool('/tmp/a.ts', { toolCallId: 't2' }))
    ];
    const key = fingerprintToolCall(pair[0].tool).key;
    const approved = reduceBallot(pair, 'approve-all', { fingerprintKey: key });
    assert.equal(approved.length, 2);
    assert.ok(approved.every((d) => d.apply && d.outcome?.outcome === 'selected' && d.outcome.optionId === 'allow'));

    const denied = reduceBallot(pair, 'deny-any', { fingerprintKey: key });
    assert.equal(denied.length, 2);
    assert.ok(denied.every((d) => d.apply && d.outcome?.outcome === 'selected' && d.outcome.optionId === 'deny'));
  });

  it('Approve-this-backend-only leaves the other backend pending', () => {
    const pair = [
      pending('r1', 's-claude', 'claude', writeTool('/tmp/a.ts', { toolCallId: 't1' })),
      pending('r2', 's-grok', 'grok', writeTool('/tmp/a.ts', { toolCallId: 't2' }))
    ];
    const key = fingerprintToolCall(pair[0].tool).key;
    const dec = reduceBallot(pair, 'approve-this-backend', { fingerprintKey: key, backend: 'claude' });
    assert.equal(dec.length, 1);
    assert.equal(dec[0].requestId, 'r1');
    assert.equal(dec[0].apply, true);
  });

  it('never auto-approves high-risk; deny-any still denies', () => {
    const pair = [
      pending('r1', 's-claude', 'claude', bashTool('rm -rf /tmp/x', { toolCallId: 't1' })),
      pending('r2', 's-grok', 'grok', bashTool('rm -rf /tmp/x', { toolCallId: 't2' }))
    ];
    const key = fingerprintToolCall(pair[0].tool).key;
    const approved = reduceBallot(pair, 'approve-all', { fingerprintKey: key });
    assert.ok(approved.every((d) => d.apply === false && d.skipped === 'high-risk'));
    const denied = reduceBallot(pair, 'deny-any', { fingerprintKey: key });
    assert.ok(denied.every((d) => d.apply === true));
  });

  it('does not group different paths', () => {
    const groups = groupPendingBallots([
      pending('r1', 's1', 'claude', writeTool('/tmp/a.ts')),
      pending('r2', 's2', 'grok', writeTool('/tmp/b.ts'))
    ]);
    assert.equal(groups.length, 2);
  });
});

describe('pickAllow / pickDeny / auto-deny', () => {
  it('prefers allow_always then allow_once; deny falls back to cancelled', () => {
    assert.deepEqual(pickAllowOutcome([{ optionId: 'aa', kind: 'allow_always' }]), {
      outcome: 'selected',
      optionId: 'aa'
    });
    assert.equal(pickAllowOutcome([{ optionId: 'x', kind: 'reject_once' }]), null);
    assert.deepEqual(pickDenyOutcome([]), { outcome: 'cancelled' });
  });

  it('auto-deny timer is off by default and trips only when enabled', () => {
    assert.equal(BALLOT_AUTO_DENY_DEFAULT, false);
    assert.equal(isAutoDenyDue(0, BALLOT_AUTO_DENY_MS, false), false);
    assert.equal(isAutoDenyDue(0, BALLOT_AUTO_DENY_MS - 1, true), false);
    assert.equal(isAutoDenyDue(0, BALLOT_AUTO_DENY_MS, true), true);
  });
});

describe('PermissionBallotHub fixture: 2 mock ACP sessions', () => {
  it('identical Write(path) → one ballot; Approve-all clears both', () => {
    const hub = new PermissionBallotHub();
    const outcomes: Record<string, PermissionOutcome> = {};
    const resolved: string[] = [];
    hub.register({
      requestId: 'r1',
      sessionId: 's-claude',
      backend: 'claude',
      tool: writeTool('/tmp/a.ts', { toolCallId: 't1' }),
      options: ALLOW,
      resolve: (o) => {
        outcomes.r1 = o;
        return true;
      },
      notifyResolved: (id) => resolved.push(id)
    });
    hub.register({
      requestId: 'r2',
      sessionId: 's-grok',
      backend: 'grok',
      tool: writeTool('/tmp/a.ts', { toolCallId: 't2' }),
      options: ALLOW,
      resolve: (o) => {
        outcomes.r2 = o;
        return true;
      },
      notifyResolved: (id) => resolved.push(id)
    });
    const groups = hub.groups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].members.length, 2);
    const result = hub.apply('approve-all', groups[0].fingerprint.key);
    assert.equal(result.applied.length, 2);
    assert.equal(hub.size, 0);
    assert.deepEqual(outcomes.r1, { outcome: 'selected', optionId: 'allow' });
    assert.deepEqual(outcomes.r2, { outcome: 'selected', optionId: 'allow' });
    assert.deepEqual(resolved.sort(), ['r1', 'r2']);
    assert.match(result.log, /permission-ballot action=approve-all/);
    assert.match(result.log, /applied=2/);
  });

  it('Deny-any clears both as denied', () => {
    const hub = new PermissionBallotHub();
    const outcomes: Record<string, PermissionOutcome> = {};
    hub.register({
      requestId: 'r1',
      sessionId: 's-claude',
      backend: 'claude',
      tool: writeTool('/tmp/a.ts', { toolCallId: 't1' }),
      options: ALLOW,
      resolve: (o) => {
        outcomes.r1 = o;
        return true;
      }
    });
    hub.register({
      requestId: 'r2',
      sessionId: 's-grok',
      backend: 'grok',
      tool: writeTool('/tmp/a.ts', { toolCallId: 't2' }),
      options: ALLOW,
      resolve: (o) => {
        outcomes.r2 = o;
        return true;
      }
    });
    const key = hub.groups()[0].fingerprint.key;
    const result = hub.apply('deny-any', key);
    assert.equal(result.applied.length, 2);
    assert.equal(hub.size, 0);
    assert.deepEqual(outcomes.r1, { outcome: 'selected', optionId: 'deny' });
    assert.deepEqual(outcomes.r2, { outcome: 'selected', optionId: 'deny' });
  });
});

describe('formatBallotLog + ballotInfoForHead', () => {
  it('formats a local-only log line', () => {
    assert.equal(
      formatBallotLog({
        action: 'deny-any',
        fingerprintKey: 'write|/tmp/a.ts',
        members: 2,
        applied: 2,
        skipped: 0,
        highRisk: null
      }),
      'permission-ballot action=deny-any key=write|/tmp/a.ts members=2 applied=2 skipped=0 highRisk=none'
    );
  });

  it('surfaces ballot chrome when local queue or host count > 1', () => {
    const queue = [
      { requestId: 'r1', tool: writeTool('/tmp/a.ts', { toolCallId: 't1' }) },
      { requestId: 'r2', tool: writeTool('/tmp/a.ts', { toolCallId: 't2' }) }
    ];
    const info = ballotInfoForHead(queue, null, 'claude');
    assert.ok(info);
    assert.equal(info.count, 2);
    assert.deepEqual(info.localIds, ['r1', 'r2']);
    assert.equal(ballotInfoForHead([queue[0]], null, 'claude'), null);
    const host = ballotInfoForHead([queue[0]], {
      key: 'write|/tmp/a.ts',
      count: 2,
      backends: ['claude', 'grok'],
      highRisk: null
    });
    assert.equal(host?.count, 2);
  });
});
