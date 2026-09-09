import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEAMMATE_COMPACT_CONFIG,
  TeammateCompactProxyTracker,
  buildTeammateParkHandoffCartridge,
  buildTeammateSummarizePrimer,
  classifyTeammateToolTitle,
  contextFillPct,
  evaluateTeammateChild,
  evaluateTeammateCompactChip,
  guessContextWindowTokens,
  parseTeammateContextPct,
  resolveTeammateChildId,
  teammateChildLabel,
  type TeammateChildSnapshot
} from '../../src/shared/teammateCompactProxy';

/** Fixture: teammate near the default 75% threshold on a 200k Claude window. */
function nearLimitChild(
  over: Partial<TeammateChildSnapshot> = {}
): TeammateChildSnapshot {
  return {
    id: 'tm:researcher',
    label: 'researcher',
    role: 'teammate',
    usedTokens: 160_000, // 80%
    windowTokens: 200_000,
    lastToolResults: [
      { title: 'Read', text: 'src/a.ts — 120 lines' },
      { title: 'Grep', text: 'found 3 matches for compact' }
    ],
    backend: 'claude',
    ...over
  };
}

describe('contextFillPct', () => {
  it('computes percent and rejects bad windows', () => {
    assert.equal(contextFillPct(75_000, 100_000), 75);
    assert.equal(contextFillPct(0, 100_000), 0);
    assert.equal(contextFillPct(50, 0), null);
    assert.equal(contextFillPct(-1, 100), null);
  });
});

describe('evaluateTeammateChild — threshold detect', () => {
  it('fixture near limit → approaching + summarize (no vendor compact)', () => {
    const ev = evaluateTeammateChild(nearLimitChild());
    assert.equal(ev.status, 'approaching');
    assert.equal(ev.action, 'summarize');
    assert.ok(ev.fillPct != null && ev.fillPct >= 75);
    assert.match(ev.reason, /summarize primer/i);
  });

  it('vendor compact preferred when advertised at threshold', () => {
    const ev = evaluateTeammateChild(
      nearLimitChild({ vendorCompactAvailable: true })
    );
    assert.equal(ev.status, 'approaching');
    assert.equal(ev.action, 'vendor_compact');
  });

  it('critical fill → park_handoff', () => {
    const ev = evaluateTeammateChild(
      nearLimitChild({ usedTokens: 185_000 }) // 92.5%
    );
    assert.equal(ev.status, 'critical');
    assert.equal(ev.action, 'park_handoff');
  });

  it('below threshold → ok/none', () => {
    const ev = evaluateTeammateChild(
      nearLimitChild({ usedTokens: 50_000 }) // 25%
    );
    assert.equal(ev.status, 'ok');
    assert.equal(ev.action, 'none');
  });

  it('mode off suppresses action even when overfilled', () => {
    const ev = evaluateTeammateChild(nearLimitChild({ usedTokens: 199_000 }), {
      ...DEFAULT_TEAMMATE_COMPACT_CONFIG,
      mode: 'off'
    });
    assert.equal(ev.status, 'ok');
    assert.equal(ev.action, 'none');
  });

  it('unknown window → none (no invented fill)', () => {
    const ev = evaluateTeammateChild(
      nearLimitChild({ windowTokens: 0, usedTokens: 180_000 })
    );
    assert.equal(ev.fillPct, null);
    assert.equal(ev.action, 'none');
  });
});

describe('classify + resolve child ids from Agent-tool titles', () => {
  it('classifies Agent / Task / Teammate titles', () => {
    assert.equal(classifyTeammateToolTitle('Agent "researcher"'), 'agent_tool');
    assert.equal(classifyTeammateToolTitle('Task: explore auth'), 'subagent');
    assert.equal(classifyTeammateToolTitle('Teammate builder'), 'teammate');
    assert.equal(classifyTeammateToolTitle('Read'), null);
    assert.equal(classifyTeammateToolTitle('Bash'), null);
  });

  it('resolves stable ids from quoted names, else toolCallId', () => {
    assert.equal(
      resolveTeammateChildId({
        toolCallId: 'tc-1',
        title: 'Agent "researcher"'
      }),
      'tm:researcher'
    );
    assert.equal(
      resolveTeammateChildId({
        toolCallId: 'tc-9',
        title: 'Bash',
        rawInput: { command: 'ls' }
      }),
      'tc:tc-9'
    );
    assert.equal(
      resolveTeammateChildId({
        toolCallId: 'tc-2',
        title: 'Agent',
        rawInput: { name: 'ExploreAuth' }
      }),
      'tm:exploreauth'
    );
  });

  it('labels prefer named agent over raw id', () => {
    assert.equal(
      teammateChildLabel({
        id: 'tm:researcher',
        title: 'Agent "researcher": dig into auth',
        role: 'agent_tool'
      }),
      'researcher'
    );
  });
});

describe('parseTeammateContextPct', () => {
  it('reads context_pct attribute + agent from teammate-status tag', () => {
    const raw =
      '<teammate-status agent="researcher" context_pct="82">window filling</teammate-status>';
    const p = parseTeammateContextPct(raw);
    assert.ok(p);
    assert.equal(p!.fillPct, 82);
    assert.equal(p!.agentId, 'researcher');
  });

  it('reads phrase form context 91%', () => {
    const p = parseTeammateContextPct(
      'Teammate builder context 91% — responses slowing'
    );
    assert.ok(p);
    assert.equal(p!.fillPct, 91);
  });

  it('ignores unrelated text', () => {
    assert.equal(parseTeammateContextPct('no fill metrics here'), null);
  });
});

describe('summarize primer + park handoff cartridge', () => {
  it('buildTeammateSummarizePrimer keeps recoverable summary artifact', () => {
    const primer = buildTeammateSummarizePrimer({
      child: nearLimitChild(),
      summary: 'Researched auth middleware; found 2 gaps.',
      focus: 'auth gaps',
      leadSessionId: 'cb-lead-1'
    });
    assert.match(primer, /teammate-compact-context/);
    assert.match(primer, /#49786/);
    assert.match(primer, /Researched auth middleware/);
    assert.match(primer, /auth gaps/);
    assert.match(primer, /cb-lead-1/);
    assert.match(primer, /80%/);
  });

  it('park handoff cartridge includes last N tool results', () => {
    const child = nearLimitChild({
      usedTokens: 190_000,
      lastToolResults: [
        { title: 'old', text: 'should drop' },
        { title: 'Read', text: 'file a' },
        { title: 'Edit', text: 'file b patch' }
      ]
    });
    const cart = buildTeammateParkHandoffCartridge({
      child,
      lastN: 2,
      leadSessionId: 'cb-lead-1',
      now: 1_700_000_000_000
    });
    assert.equal(cart.resultCount, 2);
    assert.match(cart.markdown, /Teammate park handoff/);
    assert.match(cart.markdown, /Read/);
    assert.match(cart.markdown, /Edit/);
    assert.doesNotMatch(cart.markdown, /should drop/);
    assert.match(cart.markdown, /#49786/);
    assert.ok(cart.preview.length <= 200);
  });
});

describe('chip + tracker', () => {
  it('chip surfaces near / compact / fail counts', () => {
    const chip = evaluateTeammateCompactChip({
      evaluations: [
        evaluateTeammateChild(nearLimitChild()),
        evaluateTeammateChild(
          nearLimitChild({ id: 'tm:builder', label: 'builder', usedTokens: 40_000 })
        )
      ],
      compactedCount: 1,
      failedCount: 0,
      parkedCount: 0
    });
    assert.ok(chip);
    assert.equal(chip!.approachingCount, 1);
    assert.equal(chip!.compactedCount, 1);
    assert.match(chip!.label, /near 1/);
    assert.match(chip!.label, /compact 1/);
    assert.equal(chip!.warn, true);
  });

  it('tracker: status report → fill, newlyWarned once, outcomes', () => {
    const t = new TeammateCompactProxyTracker();
    t.upsertChild(
      nearLimitChild({
        id: 'tm:researcher',
        usedTokens: 10_000,
        windowTokens: 200_000
      })
    );
    // Still ok
    assert.equal(t.newlyWarned().length, 0);

    t.noteFillPct('tm:researcher', 80);
    const warned = t.newlyWarned();
    assert.equal(warned.length, 1);
    assert.equal(warned[0]!.action, 'summarize');
    // Fire-once
    assert.equal(t.newlyWarned().length, 0);

    t.recordOutcome('compacted');
    t.recordOutcome('failed');
    const chip = t.chip();
    assert.ok(chip);
    assert.match(chip!.label, /compact 1/);
    assert.match(chip!.label, /fail 1/);
  });

  it('tracker noteToolResult creates stub + caps growth', () => {
    const t = new TeammateCompactProxyTracker();
    for (let i = 0; i < 30; i++) {
      t.noteToolResult(
        'tc:x',
        { title: `r${i}`, text: `body ${i}` },
        { label: 'agent-x', role: 'agent_tool', windowTokens: 200_000 }
      );
    }
    const child = t.getChild('tc:x');
    assert.ok(child);
    assert.equal(child!.lastToolResults!.length, 24);
    assert.equal(child!.label, 'agent-x');
  });

  it('mode off → null chip', () => {
    const t = new TeammateCompactProxyTracker();
    t.upsertChild(nearLimitChild());
    assert.equal(t.chip({ ...DEFAULT_TEAMMATE_COMPACT_CONFIG, mode: 'off' }), null);
  });
});

describe('guessContextWindowTokens', () => {
  it('matches Claude / Grok families', () => {
    assert.equal(guessContextWindowTokens('claude-opus-4'), 200_000);
    assert.equal(guessContextWindowTokens('grok-build'), 128_000);
  });
});
