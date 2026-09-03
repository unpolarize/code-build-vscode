// First test suite for the webview chat reducer (webview-ui/src/store.ts).
// The reducer is pure and dependency-free (no vscode/DOM), so it runs
// directly under the node --test + tsx harness. Focus areas: streaming
// chunk-merge, tool_call_update patching, turn-boundary file aggregation,
// TodoWrite snapshot-replace, and the historyLoaded replay path — which
// must reconstruct the same ChatItem list the live stream produces.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';
import type { HostToWebview, SessionMeta } from '../../src/shared/protocol';
import {
  appendUser,
  initialState,
  isAwaitingFirstToken,
  reduce,
  replayTimestamp,
  type ChatState
} from '../../webview-ui/src/store';

const meta: SessionMeta = {
  id: 's1',
  title: 'test session',
  backend: 'claude',
  cwd: '/tmp',
  createdAt: 0,
  updatedAt: 0
} as unknown as SessionMeta;

function apply(state: ChatState, ...updates: SessionUpdate[]): ChatState {
  let s = state;
  for (const u of updates) s = reduce(s, { type: 'sessionUpdate', update: u } as HostToWebview);
  return s;
}

const text = (t: string) => ({ type: 'text', text: t }) as { type: 'text'; text: string };

const msgChunk = (t: string): SessionUpdate => ({ kind: 'agent_message_chunk', content: text(t) });
const thoughtChunk = (t: string): SessionUpdate => ({ kind: 'agent_thought_chunk', content: text(t) });

function toolCall(overrides: Partial<ToolCall> & { toolCallId: string }): SessionUpdate {
  return {
    kind: 'tool_call',
    toolCall: { title: 'Bash', status: 'pending', ...overrides } as ToolCall
  };
}

describe('streaming chunk merge', () => {
  it('merges consecutive assistant chunks into one bubble', () => {
    const s = apply(initialState, msgChunk('Hello, '), msgChunk('world'));
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].kind, 'assistant');
    assert.equal((s.items[0] as any).text, 'Hello, world');
  });

  it('starts a new assistant bubble after a non-assistant item', () => {
    const s = apply(
      initialState,
      msgChunk('one'),
      toolCall({ toolCallId: 't1' }),
      msgChunk('two')
    );
    assert.deepEqual(
      s.items.map((it) => it.kind),
      ['assistant', 'tool', 'assistant']
    );
  });

  it('merges thought chunks and drops empty ones', () => {
    const s = apply(initialState, thoughtChunk('hmm '), thoughtChunk(''), thoughtChunk('ok'));
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].kind, 'thought');
    assert.equal((s.items[0] as any).text, 'hmm ok');
  });
});

describe('tool_call_update', () => {
  it('patches the matching tool item by toolCallId', () => {
    const s0 = apply(
      initialState,
      toolCall({ toolCallId: 'a', title: 'Read' }),
      toolCall({ toolCallId: 'b', title: 'Bash' })
    );
    const s1 = apply(s0, {
      kind: 'tool_call_update',
      toolCall: { toolCallId: 'a', status: 'completed', content: [text('done')] }
    });
    const a = s1.items.find((it) => it.kind === 'tool' && it.tool.toolCallId === 'a') as any;
    const b = s1.items.find((it) => it.kind === 'tool' && it.tool.toolCallId === 'b') as any;
    assert.equal(a.tool.status, 'completed');
    assert.equal(a.tool.title, 'Read'); // merge keeps original fields
    assert.equal(b.tool.status, 'pending');
  });

  it('is a no-op for an unknown toolCallId', () => {
    const s0 = apply(initialState, toolCall({ toolCallId: 'a' }));
    const s1 = apply(s0, { kind: 'tool_call_update', toolCall: { toolCallId: 'zzz', status: 'failed' } });
    assert.deepEqual(
      s1.items.map((it) => (it as any).tool?.status),
      ['pending']
    );
  });
});

describe('turn-boundary file aggregation (result)', () => {
  const diffBlock = (path: string, oldText: string, newText: string) =>
    ({ type: 'diff', path, oldText, newText }) as any;

  it('appends a files summary from diff content blocks on result', () => {
    const s0 = apply(
      initialState,
      { kind: 'user_message_chunk', content: text('go') } as any,
      toolCall({
        toolCallId: 't1',
        title: 'Edit',
        content: [diffBlock('/a.ts', 'x\n', 'x\ny\n')]
      }),
      { kind: 'result', stopReason: 'end_turn' }
    );
    const files = s0.items.find((it) => it.kind === 'files') as any;
    assert.ok(files, 'files summary item exists');
    assert.equal(files.files.length, 1);
    assert.equal(files.files[0].path, '/a.ts');
    assert.equal(files.files[0].added, 1);
    assert.equal(files.files[0].removed, 0);
    assert.equal(s0.busy, false);
  });

  it('aggregates only back to the previous turn boundary', () => {
    const turn1 = apply(
      initialState,
      toolCall({ toolCallId: 't1', title: 'Edit', content: [diffBlock('/a.ts', '', 'a\n')] }),
      { kind: 'result', stopReason: 'end_turn' }
    );
    const withUser = reduce(turn1, {
      type: 'sessionUpdate',
      update: { kind: 'error', message: 'noop' }
    } as HostToWebview); // any non-tool separator; real turns start with a user item
    const turn2 = apply(
      withUser,
      toolCall({ toolCallId: 't2', title: 'Edit', content: [diffBlock('/b.ts', '', 'b\n')] }),
      { kind: 'result', stopReason: 'end_turn' }
    );
    const summaries = turn2.items.filter((it) => it.kind === 'files') as any[];
    assert.equal(summaries.length, 2);
    // second summary only covers /b.ts — the first files item is a boundary
    assert.deepEqual(summaries[1].files.map((f: any) => f.path), ['/b.ts']);
  });

  it('emits no files item when the turn touched nothing', () => {
    const s = apply(initialState, msgChunk('just talk'), { kind: 'result', stopReason: 'end_turn' });
    assert.equal(s.items.some((it) => it.kind === 'files'), false);
  });
});

describe('taskList snapshot-replace', () => {
  it('replaces the previous tasks card in place, preserving id', () => {
    const s0 = reduce(initialState, {
      type: 'taskList',
      toolCallId: 'td1',
      tasks: [{ content: 'one', status: 'pending' }]
    } as HostToWebview);
    const s1 = reduce(s0, {
      type: 'taskList',
      toolCallId: 'td2',
      tasks: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' }
      ]
    } as HostToWebview);
    const cards = s1.items.filter((it) => it.kind === 'tasks') as any[];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].tasks.length, 2);
    assert.equal(cards[0].tasks[0].status, 'completed');
    assert.equal(cards[0].id, (s0.items[0] as any).id);
  });
});

describe('historyLoaded replay', () => {
  const rec = (update: SessionUpdate) => ({ type: 'update', update });
  const userRec = (t: string) => ({ type: 'user', text: t });

  it('restores thought chunks, tool results/diffs and files summary — parity with live path', () => {
    const updates: SessionUpdate[] = [
      thoughtChunk('thinking…'),
      msgChunk('Editing now.'),
      toolCall({ toolCallId: 't1', title: 'Edit', rawInput: { file_path: '/a.ts' } }),
      {
        kind: 'tool_call_update',
        toolCall: {
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'diff', path: '/a.ts', oldText: 'x\n', newText: 'x\ny\n' } as any]
        }
      },
      { kind: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { kind: 'result', stopReason: 'end_turn' }
    ];

    // Live path: user prompt echo + streamed updates.
    let live = reduce(initialState, { type: 'hydrate', state: { session: meta, backends: [], allowBypass: false } } as any);
    live = { ...live, items: [...live.items, { kind: 'user', id: 'u0', createdAt: 0, text: 'edit a.ts' } as any] };
    live = apply(live, ...updates);

    // Replay path: same events from disk records.
    const replayed = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [userRec('edit a.ts'), ...updates.map(rec)]
    } as HostToWebview);

    const shape = (s: ChatState) =>
      s.items.map((it) => {
        if (it.kind === 'tool') return { kind: it.kind, status: it.tool.status, content: it.tool.content };
        if (it.kind === 'files') return { kind: it.kind, files: it.files };
        return { kind: it.kind, text: (it as any).text };
      });
    assert.deepEqual(shape(replayed), shape(live));
    assert.deepEqual(replayed.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(replayed.busy, false);
    // completed tool card with its diff restored
    const tool = replayed.items.find((it) => it.kind === 'tool') as any;
    assert.equal(tool.tool.status, 'completed');
    assert.equal(tool.tool.content[0].type, 'diff');
    // files-changed summary reconstructed at the turn boundary
    const files = replayed.items.find((it) => it.kind === 'files') as any;
    assert.deepEqual(files.files.map((f: any) => f.path), ['/a.ts']);
  });

  it('reconstructs TodoWrite task cards from persisted tool_call records', () => {
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [
        rec(toolCall({
          toolCallId: 'td1',
          title: 'TodoWrite',
          rawInput: { todos: [{ content: 'one', status: 'pending', activeForm: 'doing one' }] }
        })),
        rec(toolCall({
          toolCallId: 'td2',
          title: 'TodoWrite',
          rawInput: { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] }
        }))
      ]
    } as HostToWebview);
    const cards = s.items.filter((it) => it.kind === 'tasks') as any[];
    assert.equal(cards.length, 1, 'snapshot-replace applies on replay too');
    assert.deepEqual(cards[0].tasks.map((t: any) => t.status), ['completed', 'in_progress']);
    // no raw ToolCard rendered alongside the structured card
    assert.equal(s.items.some((it) => it.kind === 'tool'), false);
  });

  it('reconstructs AskUserQuestion cards as inert (answered) views', () => {
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [
        rec(toolCall({
          toolCallId: 'q1',
          title: 'AskUserQuestion',
          rawInput: {
            questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }]
          }
        }))
      ]
    } as HostToWebview);
    const card = s.items.find((it) => it.kind === 'askUser') as any;
    assert.ok(card, 'askUser card restored');
    assert.equal(card.questions[0].question, 'Pick one');
    assert.notEqual(card.answers, null, 'card must not restore as a live picker');
    assert.equal(s.items.some((it) => it.kind === 'tool'), false);
  });

  it('never resurrects permission requests and resets transient state', () => {
    const dirty: ChatState = {
      ...initialState,
      busy: true,
      usage: { inputTokens: 999 },
      items: [{ kind: 'error', id: 'e', createdAt: 0, text: 'stale' } as any],
      permissionQueue: [
        { requestId: 'r', tool: { toolCallId: 'x', title: 'Bash', status: 'pending' }, options: [] }
      ]
    };
    const s = reduce(dirty, {
      type: 'historyLoaded',
      meta,
      records: [
        rec({
          kind: 'permission_request',
          requestId: 'p1',
          toolCall: { toolCallId: 'x', title: 'Bash', status: 'pending' },
          options: [{ optionId: 'o', name: 'Allow', kind: 'allow_once' }]
        } as SessionUpdate),
        userRec('hello')
      ]
    } as HostToWebview);
    assert.deepEqual(s.permissionQueue, []);
    assert.equal(s.busy, false);
    assert.equal(s.usage, null);
    assert.deepEqual(s.items.map((it) => it.kind), ['user']);
  });

  it('replays stored ts onto items so a remount is not "just now"', () => {
    const sessionStart = 1_700_000_000_000;
    const userAt = sessionStart + 60_000;
    const asstAt = sessionStart + 90_000;
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta: { ...meta, createdAt: sessionStart },
      records: [
        { type: 'user', text: 'hello from yesterday', ts: userAt },
        { type: 'update', ts: asstAt, update: msgChunk('hi back') }
      ]
    } as HostToWebview);
    assert.equal(s.items[0].kind, 'user');
    assert.equal(s.items[0].createdAt, userAt);
    assert.equal(s.items[1].kind, 'assistant');
    assert.equal(s.items[1].createdAt, asstAt);
    const now = Date.now();
    assert.ok(now - s.items[0].createdAt > 60_000, 'restored stamp must not be Date.now()');
  });

  it('legacy records without ts fall back to session createdAt, not Date.now()', () => {
    const sessionStart = 1_700_000_000_000;
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta: { ...meta, createdAt: sessionStart },
      records: [userRec('old prompt'), rec(msgChunk('old reply'))]
    } as HostToWebview);
    assert.equal(s.items[0].createdAt, sessionStart);
    assert.equal(s.items[1].createdAt, sessionStart);
    assert.equal(replayTimestamp({ type: 'user', text: 'x' }, { ...meta, createdAt: sessionStart }), sessionStart);
  });

  it('restores usage_breakdown for imported transcripts', () => {
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [
        rec({ kind: 'usage_breakdown', entries: [{ model: 'claude-sonnet-5', inputTokens: 7 } as any] }),
        rec({ kind: 'usage', usage: { inputTokens: 7 } })
      ]
    } as HostToWebview);
    assert.equal(s.usageBreakdown.length, 1);
    assert.deepEqual(s.usage, { inputTokens: 7 });
  });

  it('keeps an optimistic user bubble that is not yet in the replayed records', () => {
    let s = appendUser(initialState, 'why only today?');
    assert.equal(s.items.filter((it) => it.kind === 'user').length, 1);
    s = reduce(s, {
      type: 'historyLoaded',
      meta,
      records: [userRec('older prompt'), rec(msgChunk('older reply'))]
    } as HostToWebview);
    const users = s.items.filter((it) => it.kind === 'user');
    assert.equal(users.length, 2);
    assert.equal(users[0].text, 'older prompt');
    assert.equal(users[1].text, 'why only today?');
    assert.equal(s.busy, true);
  });

  it('replays persisted user images onto the restored bubble', () => {
    const img = { mimeType: 'image/png', data: 'aaa', name: 'shot.png' };
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [{ type: 'user', text: 'look at this', ts: 1, images: [img] }]
    } as HostToWebview);
    assert.equal(s.items[0].kind, 'user');
    assert.deepEqual((s.items[0] as { images?: unknown }).images, [img]);
  });

  it('copies images from an optimistic bubble onto a text-only replay of the same prompt', () => {
    const img = { mimeType: 'image/png', data: 'bbb' };
    let s = appendUser(initialState, 'look at this', [img]);
    s = reduce(s, {
      type: 'historyLoaded',
      meta,
      records: [userRec('look at this')]
    } as HostToWebview);
    const users = s.items.filter((it) => it.kind === 'user');
    assert.equal(users.length, 1);
    assert.deepEqual((users[0] as { images?: unknown }).images, [img]);
  });

  it('historyProgress loading at 0 bytes clears items; historyBatch appends', () => {
    let s = reduce(initialState, {
      type: 'historyProgress',
      phase: 'loading',
      bytesRead: 0,
      bytesTotal: 1000,
      records: 0
    } as HostToWebview);
    assert.equal(s.historyLoad?.phase, 'loading');
    assert.equal(s.items.length, 0);
    s = reduce(s, {
      type: 'historyBatch',
      meta,
      records: [userRec('one')],
      bytesRead: 100,
      bytesTotal: 1000,
      recordsSoFar: 1
    } as HostToWebview);
    s = reduce(s, {
      type: 'historyBatch',
      meta,
      records: [userRec('two')],
      bytesRead: 200,
      bytesTotal: 1000,
      recordsSoFar: 2
    } as HostToWebview);
    const users = s.items.filter((it) => it.kind === 'user');
    assert.equal(users.length, 2);
    assert.equal(users[0].text, 'one');
    assert.equal(users[1].text, 'two');
    assert.equal(s.historyLoad?.records, 2);
    s = reduce(s, {
      type: 'historyProgress',
      phase: 'done',
      bytesRead: 1000,
      bytesTotal: 1000,
      records: 2
    } as HostToWebview);
    assert.equal(s.historyLoad?.phase, 'done');
    assert.equal(s.items.length, 2);
  });

  it('historyLoaded hasOlder; historyOlder prepends without dropping the tail', () => {
    let s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [userRec('tail')],
      hasOlder: true
    } as HostToWebview);
    assert.equal(s.hasOlder, true);
    assert.equal((s.items[0] as { text?: string }).text, 'tail');
    s = reduce(s, {
      type: 'historyOlder',
      meta,
      records: [userRec('older')],
      hasOlder: false
    } as HostToWebview);
    const users = s.items.filter((it) => it.kind === 'user');
    assert.equal(users.map((u) => u.text).join(','), 'older,tail');
    assert.equal(s.hasOlder, false);
    assert.equal(s.olderSeq, 1);
  });
});

describe('isAwaitingFirstToken', () => {
  const user = (text: string): ChatState['items'][number] =>
    ({ kind: 'user', id: 'u', createdAt: 0, text }) as ChatState['items'][number];
  const notice = (text: string): ChatState['items'][number] =>
    ({ kind: 'notice', id: 'n', createdAt: 0, text }) as ChatState['items'][number];
  const thought = (text: string): ChatState['items'][number] =>
    ({ kind: 'thought', id: 't', createdAt: 0, text }) as ChatState['items'][number];
  const context = (): ChatState['items'][number] =>
    ({ kind: 'context', id: 'c', createdAt: 0, origin: 'prompt', summary: 'primer', sections: [] }) as ChatState['items'][number];

  it('stays true when a Resuming/ready notice lands after the You-bubble', () => {
    assert.equal(isAwaitingFirstToken([user('hi'), notice('Resuming `abcd1234` (grok)…')], true), true);
  });

  it('stays true across primer/context chrome until thinking starts', () => {
    assert.equal(isAwaitingFirstToken([user('hi'), context(), notice('grok ready')], true), true);
  });

  it('turns false once a thought/assistant chunk arrives', () => {
    assert.equal(isAwaitingFirstToken([user('hi'), notice('Resuming'), thought('working')], true), false);
  });

  it('is false when not busy', () => {
    assert.equal(isAwaitingFirstToken([user('hi')], false), false);
  });
});

describe('permission FIFO queue', () => {
  const permReq = (requestId: string, tool?: Partial<ToolCall>): SessionUpdate => ({
    kind: 'permission_request',
    requestId,
    toolCall: { toolCallId: `tc-${requestId}`, title: 'Bash', status: 'pending', ...tool } as ToolCall,
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  });

  it('queues concurrent requests instead of overwriting (orphaned-resolver regression)', () => {
    const s = apply(initialState, permReq('r1'), permReq('r2'));
    assert.equal(s.permissionQueue.length, 2);
    // FIFO order: the FIRST request stays at the head — the second must
    // not replace an unresolved first (the old single-slot bug).
    assert.equal(s.permissionQueue[0].requestId, 'r1');
    assert.equal(s.permissionQueue[1].requestId, 'r2');
  });

  it('ignores duplicate requestIds', () => {
    const s = apply(initialState, permReq('r1'), permReq('r1'));
    assert.equal(s.permissionQueue.length, 1);
  });

  it('retains rawInput/content/locations on the queued request', () => {
    const s = apply(
      initialState,
      permReq('r1', {
        rawInput: { command: 'rm -rf /tmp/x' },
        content: [{ type: 'diff', path: 'a.ts', oldText: 'a', newText: 'b' }],
        locations: [{ path: 'a.ts', line: 3 }]
      })
    );
    const tool = s.permissionQueue[0].tool;
    assert.deepEqual(tool.rawInput, { command: 'rm -rf /tmp/x' });
    assert.equal(tool.content?.[0].type, 'diff');
    assert.equal(tool.locations?.[0].path, 'a.ts');
  });

  it('renders fallback-only payloads without crashing (bare toolCallId+title)', () => {
    const s = apply(initialState, {
      kind: 'permission_request',
      requestId: 'r1',
      toolCall: { toolCallId: 'x', title: 'Bash', status: 'pending' },
      options: []
    } as SessionUpdate);
    assert.equal(s.permissionQueue.length, 1);
    assert.equal(s.permissionQueue[0].tool.rawInput, undefined);
  });
});

describe('compact marker (divider plumbing)', () => {
  const marker = {
    at: 1_700_000_100_000,
    preTokens: 150_000,
    summaryPreview: 'Goal: ship the thing…',
    instructions: 'focus on the migration'
  };

  it('compactMarker appends a compact item to the timeline', () => {
    const s = reduce(initialState, { type: 'compactMarker', marker } as HostToWebview);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].kind, 'compact');
    assert.deepEqual((s.items[0] as any).marker, marker);
  });

  it('historyLoaded replays both segments around the persisted compact record', () => {
    const s = reduce(initialState, {
      type: 'historyLoaded',
      meta,
      records: [
        { type: 'user', text: 'before compact' },
        { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } } },
        { type: 'compact', marker },
        { type: 'user', text: 'after compact' },
        { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text: 'new reply' } } }
      ]
    } as HostToWebview);
    assert.deepEqual(
      s.items.map((it) => it.kind),
      ['user', 'assistant', 'compact', 'user', 'assistant']
    );
    assert.deepEqual((s.items[2] as any).marker, marker);
  });

  it('compact divider is a turn boundary — pre-compact edits never join the post-compact files card', () => {
    let s = apply(
      initialState,
      toolCall({ toolCallId: 't1', title: 'Edit', rawInput: { file_path: '/pre.ts' } })
    );
    s = reduce(s, { type: 'compactMarker', marker } as HostToWebview);
    s = apply(s, { kind: 'result', stopReason: 'end_turn' });
    assert.equal(
      s.items.some((it) => it.kind === 'files'),
      false,
      'result after the divider must not aggregate pre-compact tool edits'
    );
  });
});

describe('nowLine strip', () => {
  const nowMsg = (now: { verb: string; target: string; startedAtMs: number } | null): HostToWebview =>
    ({ type: 'nowLine', now }) as HostToWebview;

  it('sets and clears from host posts', () => {
    let s = reduce(initialState, nowMsg({ verb: 'run', target: 'npm test', startedAtMs: 5 }));
    assert.deepEqual(s.nowLine, { verb: 'run', target: 'npm test', startedAtMs: 5 });
    s = reduce(s, nowMsg(null));
    assert.equal(s.nowLine, null);
  });

  it('busy:false clears a stuck line (cancel belt+braces)', () => {
    let s = reduce(initialState, nowMsg({ verb: 'run', target: 'sleep 99', startedAtMs: 5 }));
    s = reduce(s, { type: 'busy', busy: true } as HostToWebview);
    assert.ok(s.nowLine, 'busy:true must not clear');
    s = reduce(s, { type: 'busy', busy: false } as HostToWebview);
    assert.equal(s.nowLine, null);
  });
});

// --- usage fold across a /compact boundary -----------------------------------

describe('usage fold across compact', () => {
  it('costUsd never decreases: pre-compact → synthetic base row → folded post-respawn usage', () => {
    // The host folds costBaseUsd into every usage/result costUsd before
    // posting, and writes a synthetic cost-only usage row at compact time.
    // The reducer's merge must carry the folded figure forward and keep the
    // last real token counts when a cost-only row lands.
    let s = initialState;
    s = apply(s, { kind: 'usage', usage: { inputTokens: 90_000, costUsd: 1.2 } });
    assert.equal(s.usage?.costUsd, 1.2);
    // Synthetic summarize-usage: cost only — token fields must survive the merge.
    s = apply(s, { kind: 'usage', usage: { costUsd: 1.25 } });
    assert.equal(s.usage?.costUsd, 1.25);
    assert.equal(s.usage?.inputTokens, 90_000);
    // Post-respawn: process reports $0.15, host folds to base + 0.15.
    s = apply(s, { kind: 'usage', usage: { inputTokens: 4_000, costUsd: 1.4 } });
    assert.equal(s.usage?.costUsd, 1.4);
    assert.equal(s.usage?.inputTokens, 4_000);
    // Result rows fold the same way (claude reports cost only on results).
    s = apply(s, { kind: 'result', stopReason: 'end_turn', usage: { costUsd: 1.55 } });
    assert.equal(s.usage?.costUsd, 1.55);
  });
});

describe('daemonStatus', () => {
  it('stores daemon visibility for the header chip', () => {
    let s = reduce(initialState, { type: 'daemonStatus', up: true, version: '0.13.2' } as HostToWebview);
    assert.deepEqual(s.daemon, { up: true, version: '0.13.2', error: undefined });
    s = reduce(s, { type: 'daemonStatus', up: false, error: 'unreachable' } as HostToWebview);
    assert.equal(s.daemon?.up, false);
    assert.equal(s.daemon?.error, 'unreachable');
  });
});

describe('pinnedPermissionMode', () => {
  it('hydrates and live-updates the workspace permission pin', () => {
    assert.equal(initialState.pinnedPermissionMode, null);
    let s = reduce(initialState, {
      type: 'hydrate',
      state: {
        session: null,
        backends: [],
        allowBypass: false,
        sessions: [],
        defaultBackend: 'claude',
        memoryEntries: 0,
        memoryFiles: 0,
        memoryByProvider: {},
        showActiveQuestionBanner: true,
        pinnedPermissionMode: 'auto'
      }
    } as HostToWebview);
    assert.equal(s.pinnedPermissionMode, 'auto');
    s = reduce(s, { type: 'pinnedMode', mode: 'plan' } as HostToWebview);
    assert.equal(s.pinnedPermissionMode, 'plan');
    s = reduce(s, { type: 'pinnedMode', mode: null } as HostToWebview);
    assert.equal(s.pinnedPermissionMode, null);
  });
});
