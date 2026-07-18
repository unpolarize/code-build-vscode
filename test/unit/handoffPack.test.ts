import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffPack } from '../../src/host/persistence/handoffPack';

type Rec = { type: string; text?: string; update?: any };

const META = { fromBackend: 'Claude Code', model: 'opus', sessionId: 'abc123', cwd: '/ws' };

function user(text: string): Rec {
  return { type: 'user', text };
}
function assistant(text: string): Rec {
  return { type: 'update', update: { kind: 'agent_message_chunk', content: { type: 'text', text } } };
}
function toolCall(tc: any): Rec {
  return { type: 'update', update: { kind: 'tool_call', toolCall: tc } };
}
function toolUpdate(tc: any): Rec {
  return { type: 'update', update: { kind: 'tool_call_update', toolCall: tc } };
}

/** A representative transcript: goal, edits, a test run, a plan, risks. */
function fixture(): Rec[] {
  return [
    user('Add retry logic to the sync worker'),
    assistant('Sure. We went with exponential backoff instead of fixed delays.\n\nKnown issue: the queue does not handle duplicate ids yet.'),
    toolCall({
      toolCallId: 't1',
      title: 'Edit worker.ts',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/ws/src/worker.ts' }]
    }),
    toolUpdate({ toolCallId: 't1', status: 'completed' }),
    toolCall({
      toolCallId: 't2',
      title: 'npm run test:unit',
      kind: 'execute',
      status: 'pending'
    }),
    toolUpdate({ toolCallId: 't2', status: 'completed' }),
    {
      type: 'update',
      update: {
        kind: 'plan',
        entries: [
          { content: 'Implement backoff', status: 'completed' },
          { content: 'Add dedupe by id', status: 'pending' }
        ]
      }
    },
    user('Now also cap retries at 5'),
    assistant('Done — capped at 5.\n\nNext I would add the dedupe pass.')
  ];
}

test('empty transcript yields empty pack', () => {
  assert.equal(buildHandoffPack([], META), '');
  // Assistant-only records (no user turn) also produce nothing to hand off.
  assert.equal(buildHandoffPack([assistant('hello')], META), '');
});

test('pack contains all structured sections', () => {
  const pack = buildHandoffPack(fixture(), { ...META, generatedAt: '2026-07-18T08:00:00Z' });
  assert.match(pack, /# Handoff Pack/);
  assert.match(pack, /\*\*From:\*\* Claude Code \(opus\)/);
  assert.match(pack, /\*\*Session:\*\* `abc123`/);
  assert.match(pack, /\*\*Generated:\*\* 2026-07-18T08:00:00Z/);
  assert.match(pack, /\*\*User turns:\*\* 2/);
  assert.match(pack, /## Goal\nAdd retry logic to the sync worker/);
  assert.match(pack, /## Latest request\nNow also cap retries at 5/);
});

test('decisions and risks are mined from assistant text', () => {
  const pack = buildHandoffPack(fixture(), META);
  assert.match(pack, /## Decisions\n- Sure\. We went with exponential backoff instead of fixed delays\./);
  assert.match(pack, /## Open risks\n- Known issue: the queue does not handle duplicate ids yet\./);
});

test('files touched are workspace-relative and deduped', () => {
  const recs = fixture();
  recs.push(
    toolCall({
      toolCallId: 't3',
      title: 'Edit worker.ts again',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: '/ws/src/worker.ts' }, { path: '/elsewhere/other.ts' }]
    })
  );
  const pack = buildHandoffPack(recs, META);
  const filesSection = pack.split('## Files touched\n')[1].split('\n\n')[0];
  assert.equal(filesSection.match(/src\/worker\.ts/g)?.length, 1);
  assert.match(filesSection, /- `\/elsewhere\/other\.ts`/);
});

test('last check reflects tool_call_update merged status', () => {
  const pack = buildHandoffPack(fixture(), META);
  assert.match(pack, /## Last check\n✅ `npm run test:unit` \(completed\)/);

  // A later failed check supersedes the green one.
  const recs = fixture();
  recs.push(
    toolCall({ toolCallId: 't4', title: 'npm run typecheck', kind: 'execute', status: 'pending' }),
    toolUpdate({ toolCallId: 't4', status: 'failed' })
  );
  const failed = buildHandoffPack(recs, META);
  assert.match(failed, /## Last check\n❌ `npm run typecheck` \(failed\)/);
});

test('pending plan entries become the next step; done entries listed as plan status', () => {
  const pack = buildHandoffPack(fixture(), META);
  assert.match(pack, /## Plan status\n- \[x\] Implement backoff\n- \[ \] Add dedupe by id/);
  assert.match(pack, /## Next step\n- \[ \] Add dedupe by id/);
});

test('without a plan, next step falls back to the tail of the last assistant reply', () => {
  const recs = [
    user('Fix the flaky login test'),
    assistant('Investigated the flake.\n\nIt is a timing issue.\n\nNext step: await the redirect before asserting.')
  ];
  const pack = buildHandoffPack(recs, META);
  assert.match(pack, /## Next step\n[\s\S]*await the redirect before asserting\./);
  assert.match(pack, /## Last check\n_No test\/build\/lint run recorded/);
});

test('no verification-looking tool calls → explicit warning, non-check tools ignored', () => {
  const recs = [
    user('Rename a variable'),
    toolCall({
      toolCallId: 't1',
      title: 'Edit main.ts',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: '/ws/main.ts' }]
    }),
    assistant('Renamed.')
  ];
  const pack = buildHandoffPack(recs, META);
  assert.match(pack, /_No test\/build\/lint run recorded — verify before trusting the working tree\._/);
  assert.match(pack, /- `main\.ts`/);
});
