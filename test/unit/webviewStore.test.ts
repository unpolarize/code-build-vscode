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
import { initialState, reduce, type ChatState } from '../../webview-ui/src/store';

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
      permission: { requestId: 'r', tool: { toolCallId: 'x', title: 'Bash', status: 'pending' }, options: [] }
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
    assert.equal(s.permission, null);
    assert.equal(s.busy, false);
    assert.equal(s.usage, null);
    assert.deepEqual(s.items.map((it) => it.kind), ['user']);
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
});
