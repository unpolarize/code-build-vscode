import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMatchesWorkspace } from '../../src/host/lastSession';

describe('sessionMatchesWorkspace (issue #6)', () => {
  it('refuses a session from workspace A when the window is on B', () => {
    assert.equal(
      sessionMatchesWorkspace('/Users/me/proj-a', ['/Users/me/proj-b']),
      false
    );
  });

  it('allows a session whose cwd is the open folder or a subdir', () => {
    assert.equal(sessionMatchesWorkspace('/Users/me/proj-a', ['/Users/me/proj-a']), true);
    assert.equal(sessionMatchesWorkspace('/Users/me/proj-a/src', ['/Users/me/proj-a']), true);
  });

  it('refuses an empty cwd when a folder is open', () => {
    assert.equal(sessionMatchesWorkspace('', ['/Users/me/proj-a']), false);
    assert.equal(sessionMatchesWorkspace(undefined, ['/Users/me/proj-a']), false);
  });

  it('allows restore when no folder is open', () => {
    assert.equal(sessionMatchesWorkspace('/Users/me/proj-a', []), true);
  });
});
