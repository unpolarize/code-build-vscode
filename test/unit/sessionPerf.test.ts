import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionPerfCollector } from '../../src/host/perf/sessionPerf';

test('SessionPerfCollector tracks TTFE/TTFT and activity segments', () => {
  const p = new SessionPerfCollector();
  p.setMode('hud');
  p.setSessionMeta({ sessionId: 's1', backend: 'claude', model: 'sonnet', modePerm: 'bypass' });

  const t0 = 1_000_000;
  p.onPromptSent(t0);
  p.onUpdate(
    { kind: 'system_init', backendSessionId: 'abc' },
    { t: t0 + 100 }
  );
  // system_init is not "meaningful" for firstEvent in isMeaningful — first token is
  p.onUpdate(
    { kind: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    { t: t0 + 200, diskMs: 1.5 }
  );
  p.onUpdate(
    { kind: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    { t: t0 + 500, diskMs: 0.5 }
  );
  p.onUpdate(
    {
      kind: 'tool_call',
      toolCall: {
        toolCallId: 't1',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress'
      }
    },
    { t: t0 + 800 }
  );
  p.onUpdate(
    {
      kind: 'tool_call_update',
      toolCall: { toolCallId: 't1', status: 'completed' }
    },
    { t: t0 + 1500 }
  );
  p.recordIpcFlush(5);
  p.onUpdate({ kind: 'result', stopReason: 'end_turn' }, { t: t0 + 2000 });

  const snap = p.snapshot();
  const turn = snap.previousTurns[0];
  assert.ok(turn);
  assert.equal(turn.firstThoughtAt, t0 + 200);
  assert.equal(turn.firstTokenAt, t0 + 500);
  assert.equal(turn.firstToolAt, t0 + 800);
  assert.equal(turn.resultAt, t0 + 2000);
  assert.ok(turn.diskMsTotal >= 2);
  assert.equal(turn.ipcBatchMax, 5);
  assert.ok(turn.segments.some((s) => s.kind === 'think'));
  assert.ok(turn.segments.some((s) => s.kind === 'text'));
  assert.ok(turn.segments.some((s) => s.kind === 'tool'));

  const report = p.formatFlightReport();
  assert.match(report, /TTFT/);
  assert.match(report, /backend: claude/);
});

test('HUD reports phase streaming / tool / done', () => {
  const p = new SessionPerfCollector();
  p.setMode('full');
  const t0 = Date.now();
  p.onPromptSent(t0);
  p.onUpdate(
    { kind: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    { t: t0 + 50 }
  );
  assert.equal(p.getHud().phase, 'streaming');
  p.onUpdate(
    {
      kind: 'tool_call',
      toolCall: { toolCallId: 'a', title: 'Read', kind: 'read', status: 'in_progress' }
    },
    { t: t0 + 100 }
  );
  assert.match(p.getHud().phase, /^tool/);
  p.onUpdate({ kind: 'result', stopReason: 'end_turn' }, { t: t0 + 200 });
  assert.equal(p.getHud().phase, 'done');
});

test('flight report decision tree prefers model when host tax low', () => {
  const p = new SessionPerfCollector();
  p.setMode('hud');
  const t0 = 5_000_000;
  p.onPromptSent(t0);
  p.onUpdate(
    { kind: 'agent_message_chunk', content: { type: 'text', text: 'slow' } },
    { t: t0 + 5000, diskMs: 0.1 }
  );
  p.onUpdate({ kind: 'result', stopReason: 'end_turn' }, { t: t0 + 6000 });
  const report = p.formatFlightReport();
  assert.match(report, /model \/ network \/ CLI/);
});
