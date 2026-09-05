import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScopeFence,
  shouldEnableScopeFence,
  parseImplementEffortFromText,
  isProtectedWritePath,
  detectWriteToolPath,
  parseBashWritePath,
  detectArchitectureDigression,
  DEFAULT_SCOPE_FENCE_CONFIG,
  type ScopeFenceEvent
} from '../../src/shared/scopeFence';

// --- enable classifier --------------------------------------------------------

test('shouldEnableScopeFence: small|tiny only', () => {
  assert.equal(shouldEnableScopeFence('small'), true);
  assert.equal(shouldEnableScopeFence('tiny'), true);
  assert.equal(shouldEnableScopeFence('SMALL'), true);
  assert.equal(shouldEnableScopeFence('medium'), false);
  assert.equal(shouldEnableScopeFence('large'), false);
  assert.equal(shouldEnableScopeFence(null), false);
  assert.equal(shouldEnableScopeFence(undefined), false);
  assert.equal(shouldEnableScopeFence(''), false);
});

test('parseImplementEffortFromText reads frontmatter-ish lines', () => {
  assert.equal(parseImplementEffortFromText('implement_effort: small\n'), 'small');
  assert.equal(
    parseImplementEffortFromText('---\nimplement_effort: "tiny"\n---\n'),
    'tiny'
  );
  assert.equal(parseImplementEffortFromText('no effort here'), null);
});

// --- protected paths ----------------------------------------------------------

test('isProtectedWritePath covers CLAUDE.md / AGENTS.md / .grok/**', () => {
  assert.equal(isProtectedWritePath('CLAUDE.md'), true);
  assert.equal(isProtectedWritePath('docs/CLAUDE.md'), true);
  assert.equal(isProtectedWritePath('/w/AGENTS.md'), true);
  assert.equal(isProtectedWritePath('.grok/skills/x.md'), true);
  assert.equal(isProtectedWritePath('src/.grok/foo'), true);
  assert.equal(isProtectedWritePath('src/cli/drift.ts'), false);
  assert.equal(isProtectedWritePath('README.md'), false);
});

// --- write detectors ----------------------------------------------------------

test('detectWriteToolPath covers Write/Edit and Bash redirect', () => {
  assert.equal(detectWriteToolPath('Write', { path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(detectWriteToolPath('Edit', { file_path: 'x.md' }), 'x.md');
  assert.equal(detectWriteToolPath('ApplyPatch', { path: 'p.ts' }), 'p.ts');
  assert.equal(detectWriteToolPath('Bash', { command: 'echo hi > out.txt' }), 'out.txt');
  assert.equal(detectWriteToolPath('Read', { path: 'x.ts' }), null);
  assert.equal(detectWriteToolPath('Bash', { command: 'npm test' }), null);
});

test('parseBashWritePath extracts redirects; rejects compounds', () => {
  assert.equal(parseBashWritePath('cat a > b.txt'), 'b.txt');
  assert.equal(parseBashWritePath('tee notes.md'), 'notes.md');
  assert.equal(parseBashWritePath('echo x | tee y'), null);
  assert.equal(parseBashWritePath('echo x > a; rm a'), null);
});

// --- digression heuristic -----------------------------------------------------

test('detectArchitectureDigression matches redesign/refactor phrases', () => {
  assert.equal(
    detectArchitectureDigression('We should refactor the architecture first.'),
    true
  );
  assert.equal(
    detectArchitectureDigression('Let me redesign the module boundaries.'),
    true
  );
  assert.equal(
    detectArchitectureDigression('I will add a unit test for the parser.'),
    false
  );
});

// --- fence: budget + protected + digression -----------------------------------

test('fixture session: small-effort fence allows up to maxWritePaths then denies', () => {
  const events: ScopeFenceEvent[] = [];
  const fence = new ScopeFence({ maxWritePaths: 3 }, (e) => events.push(e));
  fence.enable('fixture implement_effort=small');
  assert.ok(fence.isActive());
  assert.equal(fence.remainingPaths(), 3);

  assert.equal(fence.allowWrite('src/a.ts'), true);
  assert.equal(fence.allowWrite('src/b.ts'), true);
  assert.equal(fence.allowWrite('src/c.ts'), true);
  // Re-write of an already-counted path stays allowed.
  assert.equal(fence.allowWrite('src/a.ts'), true);
  assert.equal(fence.remainingPaths(), 0);

  const blocked = fence.evaluateWrite('src/d.ts');
  assert.equal(blocked.decision, 'deny_budget');
  assert.ok(events.some((e) => e.type === 'deny' && e.path === 'src/d.ts'));
  assert.match(fence.statusChip(), /0 paths left/);
});

test('protected path denied until override', () => {
  const fence = new ScopeFence(DEFAULT_SCOPE_FENCE_CONFIG);
  fence.enable();
  assert.equal(fence.allowWrite('docs/CLAUDE.md'), false);
  assert.equal(fence.evaluateWrite('AGENTS.md').decision, 'deny_protected');

  fence.grantOverride('docs/CLAUDE.md');
  assert.equal(fence.allowWrite('docs/CLAUDE.md'), true);
  // Other protected paths still denied.
  assert.equal(fence.allowWrite('.grok/skills/x.md'), false);

  fence.grantOverride('*');
  assert.equal(fence.allowWrite('.grok/skills/x.md'), true);
});

test('architecture digression pauses writes until expandEffort', () => {
  const events: ScopeFenceEvent[] = [];
  const fence = new ScopeFence(DEFAULT_SCOPE_FENCE_CONFIG, (e) => events.push(e));
  fence.enable();
  assert.equal(fence.allowWrite('src/ok.ts'), true);

  assert.equal(
    fence.noteAssistantText('Next I will redesign the module boundaries.'),
    true
  );
  assert.ok(fence.isDigressionPaused());
  assert.ok(events.some((e) => e.type === 'digression'));

  assert.equal(fence.evaluateWrite('src/more.ts').decision, 'deny_digression');

  fence.expandEffort();
  assert.equal(fence.isDigressionPaused(), false);
  assert.equal(fence.allowWrite('src/more.ts'), true);
});

test('inactive fence never denies', () => {
  const fence = new ScopeFence({ maxWritePaths: 1 });
  assert.equal(fence.isActive(), false);
  assert.equal(fence.allowWrite('CLAUDE.md'), true);
  assert.equal(fence.allowWrite('a.ts'), true);
  assert.equal(fence.allowWrite('b.ts'), true);
});

test('maxWritePaths <= 0 disables budget but keeps protected deny', () => {
  const fence = new ScopeFence({ maxWritePaths: 0 });
  fence.enable();
  for (let i = 0; i < 20; i++) {
    assert.equal(fence.allowWrite(`src/f${i}.ts`), true);
  }
  assert.equal(fence.allowWrite('CLAUDE.md'), false);
});
