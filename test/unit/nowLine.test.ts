// Progressive tool-activity now-line (src/shared/nowLine.ts): the pure
// formatter (verb taxonomy + middle-ellipsis) and the transition-only
// NowLineTracker the host feeds from the SessionUpdate stream. The
// acceptance bar under test: posts happen ONLY on tool open/close
// transitions (zero traffic during a quiet in_progress window), cancel
// paths clear explicitly, and the auto|on|off gate is re-read live.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';
import {
  describeToolCall,
  formatNowLine,
  middleEllipsis,
  NowLineTracker,
  type NowLineInfo
} from '../../src/shared/nowLine';

function tc(over: Partial<ToolCall>): ToolCall {
  return { toolCallId: 't1', title: 'tool', status: 'in_progress', ...over };
}
const open = (over: Partial<ToolCall>): SessionUpdate => ({ kind: 'tool_call', toolCall: tc(over) });
const close = (id: string, status: 'completed' | 'failed' = 'completed'): SessionUpdate => ({
  kind: 'tool_call_update',
  toolCall: { toolCallId: id, status }
});

function harness(enabled: () => boolean = () => true) {
  const posts: Array<NowLineInfo | null> = [];
  const tracker = new NowLineTracker({ post: (n) => posts.push(n), isEnabled: enabled });
  return { posts, tracker };
}

describe('describeToolCall', () => {
  it('maps execute to run with the collapsed command', () => {
    const d = describeToolCall(tc({ kind: 'execute', rawInput: { command: 'npm  run\n test' } }));
    assert.deepEqual(d, { verb: 'run', target: 'npm run test' });
  });
  it('maps edit/read to the location basename', () => {
    assert.deepEqual(
      describeToolCall(tc({ kind: 'edit', locations: [{ path: '/a/b/store.ts' }] })),
      { verb: 'edit', target: 'store.ts' }
    );
    assert.deepEqual(
      describeToolCall(tc({ kind: 'read', title: 'Read', locations: [{ path: 'src/App.tsx' }] })),
      { verb: 'read', target: 'App.tsx' }
    );
  });
  it('maps search kind to the query', () => {
    const d = describeToolCall(tc({ kind: 'search', title: 'web_search', rawInput: { query: 'acp spec' } }));
    assert.deepEqual(d, { verb: 'search', target: 'acp spec' });
  });
  it('maps a server.tool title (codex mcp_tool_call kind other) to mcp', () => {
    const d = describeToolCall(tc({ kind: 'other', title: 'playwright.browser_click' }));
    assert.deepEqual(d, { verb: 'mcp', target: 'playwright.browser_click' });
  });
  it('maps todo_write to plan', () => {
    assert.equal(describeToolCall(tc({ kind: 'other', title: 'todo_write' })).verb, 'plan');
  });
  it('falls back to run + title', () => {
    assert.deepEqual(describeToolCall(tc({ title: 'MysteryTool' })), {
      verb: 'run',
      target: 'MysteryTool'
    });
  });
});

describe('middleEllipsis / formatNowLine', () => {
  it('keeps head and tail, never exceeds max', () => {
    const s = 'run ' + 'a'.repeat(100) + '/tail-file.ts';
    const out = middleEllipsis(s, 72);
    assert.equal(out.length, 72);
    assert.ok(out.startsWith('run a'));
    assert.ok(out.endsWith('tail-file.ts'));
    assert.ok(out.includes('…'));
  });
  it('leaves short lines alone', () => {
    assert.equal(formatNowLine({ verb: 'read', target: 'store.ts' }), 'read store.ts');
  });
});

describe('NowLineTracker', () => {
  it('posts once on open and nothing during a quiet in_progress window', () => {
    const { posts, tracker } = harness();
    tracker.onUpdate(open({ kind: 'execute', rawInput: { command: 'sleep 3' } }), 1000);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { verb: 'run', target: 'sleep 3', startedAtMs: 1000 });
    // 3s pass with unrelated stream traffic — zero additional posts.
    tracker.onUpdate({ kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as SessionUpdate, 2000);
    tracker.onUpdate({ kind: 'usage', usage: {} } as unknown as SessionUpdate, 4000);
    assert.equal(posts.length, 1);
  });

  it('clears on close, and completed-only pairs never narrate', () => {
    const { posts, tracker } = harness();
    tracker.onUpdate(open({}), 1000);
    tracker.onUpdate(close('t1'), 2000);
    assert.equal(posts.length, 2);
    assert.equal(posts[1], null);
    // Codex web_search completed-only arrival: tool_call already completed
    // followed by its completed update — no open, no post.
    tracker.onUpdate(open({ toolCallId: 'ws', kind: 'search', status: 'completed' }), 3000);
    tracker.onUpdate(close('ws'), 3000);
    assert.equal(posts.length, 2);
  });

  it('shows the most recently opened tool and falls back on close', () => {
    const { posts, tracker } = harness();
    tracker.onUpdate(open({ toolCallId: 'a', kind: 'read', locations: [{ path: 'a.ts' }] }), 1000);
    tracker.onUpdate(open({ toolCallId: 'b', kind: 'execute', rawInput: { command: 'ls' } }), 2000);
    tracker.onUpdate(close('b'), 3000);
    assert.deepEqual(
      posts.map((p) => p && p.target),
      ['a.ts', 'ls', 'a.ts']
    );
    tracker.onUpdate(close('a'), 4000);
    assert.equal(posts[3], null);
  });

  it('result/error clear; duplicate opens and unknown closes are no-ops', () => {
    const { posts, tracker } = harness();
    tracker.onUpdate(open({}), 1000);
    tracker.onUpdate(open({}), 1500); // same id re-announced
    tracker.onUpdate(close('nope'), 1600); // unknown id
    assert.equal(posts.length, 1);
    tracker.onUpdate({ kind: 'result', stopReason: 'end_turn' } as SessionUpdate, 2000);
    assert.equal(posts.length, 2);
    assert.equal(posts[1], null);
    // A clear with nothing shown posts nothing further.
    tracker.onUpdate({ kind: 'error', message: 'x' } as SessionUpdate, 3000);
    assert.equal(posts.length, 2);
  });

  it('cancel path: explicit clear() posts null (busy:false alone is not enough)', () => {
    const { posts, tracker } = harness();
    tracker.onUpdate(open({}), 1000);
    tracker.clear();
    assert.deepEqual(posts.map((p) => p && p.verb), ['run', null]);
    // clear() before anything was ever shown stays silent.
    const h2 = harness();
    h2.tracker.clear();
    assert.equal(h2.posts.length, 0);
  });

  it('disabled gate posts nothing; live disable takes the line down once', () => {
    let enabled = false;
    const { posts, tracker } = harness(() => enabled);
    tracker.onUpdate(open({}), 1000);
    assert.equal(posts.length, 0);
    // Live-enable (setting flipped): next transition posts.
    enabled = true;
    tracker.onUpdate(open({ toolCallId: 't2' }), 2000);
    assert.equal(posts.length, 1);
    // Live-disable mid-turn: the next transition posts exactly one null.
    enabled = false;
    tracker.onUpdate(open({ toolCallId: 't3' }), 3000);
    assert.deepEqual(posts[1], null);
    tracker.onUpdate(close('t3'), 4000);
    assert.equal(posts.length, 2);
  });
});
