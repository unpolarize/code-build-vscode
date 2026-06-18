import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestGlob, rankFileSuggestions, isImagePath } from '../../src/host/fileSuggest';

// --- buildSuggestGlob: folder-aware glob construction -----------------------

test('plain filename query globs by basename anywhere', () => {
  assert.equal(buildSuggestGlob('agent'), '**/*agent*');
});

test('folder-only query (trailing slash) globs every file under that folder', () => {
  assert.equal(buildSuggestGlob('classic/'), '**/classic/**/*');
});

test('folder + partial filename globs files under the folder matching the name', () => {
  assert.equal(buildSuggestGlob('classic/agent'), '**/classic/**/*agent*');
});

test('nested folder path is preserved in the glob', () => {
  assert.equal(buildSuggestGlob('a/b/c'), '**/a/b/**/*c*');
});

test('glob specials in the query are escaped', () => {
  assert.equal(buildSuggestGlob('foo(bar)'), '**/*foo\\(bar\\)*');
});

// --- rankFileSuggestions: filter + recency/relevance ranking ----------------

const cand = (paths: string[]) =>
  paths.map((p) => ({ path: p, label: p.split('/').pop() }));

test('folder query keeps only files under a matching folder', () => {
  const out = rankFileSuggestions(
    'classic/',
    cand(['src/classic/a.ts', 'src/classic/sub/b.ts', 'src/modern/c.ts']),
    new Set()
  );
  assert.deepEqual(
    out.map((r) => r.path),
    ['src/classic/a.ts', 'src/classic/sub/b.ts']
  );
});

test('folder + name query filters by both folder and basename', () => {
  const out = rankFileSuggestions(
    'classic/agent',
    cand(['src/classic/agent.ts', 'src/classic/other.ts', 'src/modern/agent.ts']),
    new Set()
  );
  assert.deepEqual(
    out.map((r) => r.path),
    ['src/classic/agent.ts']
  );
});

test('open (recently used) files rank first', () => {
  const out = rankFileSuggestions(
    'agent',
    cand(['src/a-agent.ts', 'src/b-agent.ts', 'src/c-agent.ts']),
    new Set(['src/c-agent.ts'])
  );
  assert.equal(out[0].path, 'src/c-agent.ts');
});

test('exact path-prefix outranks a mid-path substring match', () => {
  const out = rankFileSuggestions(
    'src/agent',
    cand(['deep/src/agent.ts', 'src/agent.ts']),
    new Set()
  );
  assert.equal(out[0].path, 'src/agent.ts');
});

test('plain query keeps files whose path contains it (current behavior preserved)', () => {
  const out = rankFileSuggestions(
    'agent',
    cand(['src/agent.ts', 'src/unrelated.ts']),
    new Set()
  );
  assert.deepEqual(
    out.map((r) => r.path),
    ['src/agent.ts']
  );
});

// --- isImagePath: drop-target image detection -------------------------------

test('recognizes common image extensions case-insensitively', () => {
  assert.equal(isImagePath('a/b/pic.PNG'), true);
  assert.equal(isImagePath('shot.jpeg'), true);
  assert.equal(isImagePath('icon.svg'), true);
});

test('non-image files are not images', () => {
  assert.equal(isImagePath('src/agent.ts'), false);
  assert.equal(isImagePath('README.md'), false);
});
