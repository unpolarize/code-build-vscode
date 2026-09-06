import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvestigateLock,
  parseFindingsBlock,
  extractFindingPath,
  type InvestigateEvent
} from '../../src/shared/investigateMode';

// --- findings parser ---------------------------------------------------------

const FIXTURE_TRANSCRIPT = `
I dug through the auth flow and here is what I found.

## Findings

- \`src/auth/session.ts:42\` — high: refresh token is written to localStorage,
  readable by any injected script.
- \`src/auth/login.ts\` — medium: error branch returns the raw upstream body to
  the client.
- low severity: config/cors.json allows origin "*" in the staging profile.

## Next steps

- propose the smallest patch for each finding
`;

test('parseFindingsBlock: fixture transcript yields all three findings', () => {
  const findings = parseFindingsBlock(FIXTURE_TRANSCRIPT);
  assert.equal(findings.length, 3);
  assert.equal(findings[0].path, 'src/auth/session.ts:42');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].observation, /localStorage/);
  assert.equal(findings[1].path, 'src/auth/login.ts');
  assert.equal(findings[1].severity, 'medium');
  assert.equal(findings[2].path, 'config/cors.json');
  assert.equal(findings[2].severity, 'low');
});

test('parseFindingsBlock: section closes at the next heading', () => {
  const text = `## Findings\n- \`a/b.ts\` high: token leaks into the debug log\n## Other\n- \`c/d.ts\` high: this is outside the findings section`;
  const findings = parseFindingsBlock(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'a/b.ts');
});

test('parseFindingsBlock: "Findings:" label form works', () => {
  const text = `Findings:\n1. src/x.py — critical: SQL string is built by concatenating user input`;
  const findings = parseFindingsBlock(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].path, 'src/x.py');
});

test('parseFindingsBlock: entries missing path or severity or observation are dropped', () => {
  const text = [
    '## Findings',
    '- high: something is broken somewhere', // no path
    '- `src/a.ts` — the code looks suspicious here', // no severity
    '- high `src/b.ts`', // no observation residue
    '- just a note without structure'
  ].join('\n');
  assert.equal(parseFindingsBlock(text).length, 0);
});

test('parseFindingsBlock: no findings section → empty', () => {
  assert.equal(parseFindingsBlock('I looked at src/a.ts, high risk overall.').length, 0);
  assert.equal(parseFindingsBlock('').length, 0);
});

test('parseFindingsBlock: dedupes by path+severity', () => {
  const text = `## Findings\n- \`a.ts\` high: the handler swallows the error object entirely\n- \`a.ts\` high: the handler swallows the error object entirely`;
  assert.equal(parseFindingsBlock(text).length, 1);
});

test('extractFindingPath: prefers backticks, rejects URLs and prose', () => {
  assert.equal(extractFindingPath('see `src/a.ts:10` for details'), 'src/a.ts:10');
  assert.equal(extractFindingPath('bare src/deep/file.tsx token'), 'src/deep/file.tsx');
  assert.equal(extractFindingPath('package.json has the dep'), 'package.json');
  assert.equal(extractFindingPath('see https://example.com/a/b for details'), null);
  assert.equal(extractFindingPath('nothing pathish here at all'), null);
});

// --- lock lifecycle ----------------------------------------------------------

function makeLock(): { lock: InvestigateLock; events: InvestigateEvent[] } {
  const events: InvestigateEvent[] = [];
  const lock = new InvestigateLock((e) => events.push(e));
  return { lock, events };
}

test('lock: inactive allows writes and reports open gate', () => {
  const { lock } = makeLock();
  assert.equal(lock.isActive(), false);
  assert.equal(lock.isUnlocked(), true);
  assert.equal(lock.allowWrite('/tmp/x.ts'), true);
});

test('lock: armed denies writes until findings + unlock', () => {
  const { lock, events } = makeLock();
  lock.arm('test');
  assert.equal(lock.isActive(), true);
  assert.equal(lock.isUnlocked(), false);
  assert.equal(lock.allowWrite('/tmp/x.ts'), false);

  // Unlock without findings is refused.
  assert.equal(lock.unlockWrites(), false);
  assert.equal(lock.isUnlocked(), false);

  // Findings land → unlock succeeds → writes flow.
  const added = lock.noteAssistantText(FIXTURE_TRANSCRIPT);
  assert.equal(added, 3);
  assert.equal(lock.findingsCount(), 3);
  assert.equal(lock.unlockWrites(), true);
  assert.equal(lock.isUnlocked(), true);
  assert.equal(lock.allowWrite('/tmp/x.ts'), true);

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['armed', 'deny', 'unlock_refused', 'findings', 'unlock']);
});

test('lock: findings accumulate across turns, deduped', () => {
  const { lock } = makeLock();
  lock.arm();
  lock.noteAssistantText('## Findings\n- `a.ts` high: null deref when the list is empty');
  lock.noteAssistantText('## Findings\n- `a.ts` high: null deref when the list is empty\n- `b.ts` low: stale comment misleads about the retry count');
  assert.equal(lock.findingsCount(), 2);
});

test('lock: noteAssistantText is a no-op when inactive or unlocked', () => {
  const { lock } = makeLock();
  assert.equal(lock.noteAssistantText(FIXTURE_TRANSCRIPT), 0);
  lock.arm();
  lock.noteAssistantText(FIXTURE_TRANSCRIPT);
  lock.unlockWrites();
  assert.equal(lock.noteAssistantText('## Findings\n- `z.ts` high: another issue found after unlock'), 0);
});

test('lock: disarm clears findings and unlock state', () => {
  const { lock } = makeLock();
  lock.arm();
  lock.noteAssistantText(FIXTURE_TRANSCRIPT);
  lock.unlockWrites();
  lock.disarm();
  assert.equal(lock.isActive(), false);
  assert.equal(lock.findingsCount(), 0);
  // Re-arm starts locked again.
  lock.arm();
  assert.equal(lock.isUnlocked(), false);
  assert.equal(lock.unlockWrites(), false);
});

test('lock: arm is idempotent and does not relock an unlocked session', () => {
  const { lock, events } = makeLock();
  lock.arm();
  lock.noteAssistantText(FIXTURE_TRANSCRIPT);
  lock.unlockWrites();
  lock.arm();
  assert.equal(lock.isUnlocked(), true);
  assert.equal(events.filter((e) => e.type === 'armed').length, 1);
});

test('lock: statusChip reflects state', () => {
  const { lock } = makeLock();
  assert.equal(lock.statusChip(), 'Investigate off');
  lock.arm();
  assert.match(lock.statusChip(), /writes locked \(0 findings\)/);
  lock.noteAssistantText('## Findings\n- `a.ts` high: buffer reused across sessions without reset');
  assert.match(lock.statusChip(), /writes locked \(1 finding\)/);
  lock.unlockWrites();
  assert.match(lock.statusChip(), /unlocked \(1\)/);
});

test('lock: event listener throwing never breaks the gate', () => {
  const lock = new InvestigateLock(() => {
    throw new Error('listener boom');
  });
  lock.arm();
  assert.equal(lock.allowWrite('/tmp/x.ts'), false);
  lock.noteAssistantText(FIXTURE_TRANSCRIPT);
  assert.equal(lock.unlockWrites(), true);
});
