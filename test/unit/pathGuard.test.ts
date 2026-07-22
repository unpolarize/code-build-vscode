import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPathGuard,
  confineToRoot,
  PathEscapeError,
  type PathGuard,
} from '../../src/host/pathGuard';

/** True when the platform can create symlinks (skip symlink tests otherwise). */
function canSymlink(dir: string): boolean {
  const target = path.join(dir, '.symlink-probe-target');
  const link = path.join(dir, '.symlink-probe-link');
  try {
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, link);
    fs.unlinkSync(link);
    fs.unlinkSync(target);
    return true;
  } catch {
    try {
      fs.unlinkSync(link);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore */
    }
    return false;
  }
}

function assertEscape(fn: () => unknown, requested?: string): void {
  try {
    fn();
    assert.fail('expected PathEscapeError');
  } catch (err) {
    assert.ok(err instanceof PathEscapeError, `got ${err}`);
    assert.equal(err.code, 'PATH_ESCAPE');
    if (requested !== undefined) {
      assert.equal(err.requested, requested);
    }
    // K3: error message must not include absolute escape targets outside root
    // (we only check that message equals the safe form with `requested`).
    assert.equal(err.message, `Path escapes workspace root: ${err.requested}`);
  }
}

// Probe once at load time — node:test evaluates `{ skip }` at registration,
// before any `before()` hook, so a runtime flag would always skip.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pathguard-probe-'));
const SYMLINKS_OK = canSymlink(probeDir);
fs.rmSync(probeDir, { recursive: true, force: true });

describe('pathGuard', () => {
  let tmp: string;
  let root: string;
  let guard: PathGuard;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pathguard-'));
    root = path.join(tmp, 'ws');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
    fs.mkdirSync(path.join(root, 'subdir'));
    fs.writeFileSync(path.join(root, 'subdir', 'x'), 'x');
    // Sibling outside root (prefix attack target).
    fs.mkdirSync(path.join(tmp, 'ws-evil'));
    fs.writeFileSync(path.join(tmp, 'ws-evil', 'secret'), 'nope');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'out');

    if (SYMLINKS_OK) {
      // D2: in-root symlink pointing outside
      fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'escape-link'));
      // D3: dir symlink pointing outside
      fs.symlinkSync(tmp, path.join(root, 'escape-dir'));
      // D4: subdir that is a symlink out (write target ancestor)
      fs.symlinkSync(tmp, path.join(root, 'escapesub'));
      // A2: in-root symlink to in-root file
      fs.symlinkSync(path.join(root, 'ok.txt'), path.join(root, 'in-link'));
      // Nested path through in-root link
      fs.symlinkSync(path.join(root, 'subdir'), path.join(root, 'subdir-link'));
    }

    guard = createPathGuard(root);
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── createPathGuard init ──────────────────────────────────────────────

  test('D0: createPathGuard on missing root throws', () => {
    assert.throws(() => createPathGuard(path.join(tmp, 'no-such-dir')), /not a usable directory|ENOENT/i);
  });

  test('D0: createPathGuard on file (non-dir) root throws', () => {
    const file = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    assert.throws(() => createPathGuard(file), /not a directory|not a usable directory/i);
  });

  // ── denials ───────────────────────────────────────────────────────────

  test('D1: ../ and absolute outside denied', () => {
    assertEscape(() => guard.confine('../outside.txt'), '../outside.txt');
    assertEscape(() => guard.confine(path.join(tmp, 'outside.txt')), path.join(tmp, 'outside.txt'));
  });

  test('D2: escape-link -> outside.txt denied', { skip: !SYMLINKS_OK }, () => {
    assertEscape(() => guard.confine('escape-link'), 'escape-link');
  });

  test('D3: nested path through out-pointing dir link denied', { skip: !SYMLINKS_OK }, () => {
    assertEscape(() => guard.confine('escape-dir/outside.txt'), 'escape-dir/outside.txt');
  });

  test('D4: write target whose ancestor symlinks out denied', { skip: !SYMLINKS_OK }, () => {
    assertEscape(() => guard.confine('escapesub/newfile'), 'escapesub/newfile');
  });

  test('D5: null byte denied', () => {
    assertEscape(() => guard.confine('ok\0.txt'), 'ok\0.txt');
  });

  test('D6: prefix sibling /tmp/ws vs /tmp/ws-evil denied', () => {
    // Lexical startsWith would allow if root were "/tmp/ws" and candidate
    // resolved to "/tmp/ws-evil/secret" without a trailing-sep check — relative
    // check must reject the sibling.
    const evil = path.join(tmp, 'ws-evil', 'secret');
    assertEscape(() => guard.confine(evil), evil);
  });

  test('D7: intermediate-is-file (file.txt/child) denied', () => {
    assertEscape(() => guard.confine('ok.txt/child'), 'ok.txt/child');
  });

  test('D8: broken symlink fail-closed', { skip: !SYMLINKS_OK }, () => {
    const broken = path.join(root, 'broken-link');
    fs.symlinkSync(path.join(root, 'does-not-exist-target'), broken);
    // Path through broken link: realpath of the link itself ENOENT; parent
    // is root so rejoined path is under root — actually broken symlink TO
    // missing in-root target: final path is under root and should be ALLOWED
    // as a non-existent path (A3-style). Spec says "broken symlink → fail
    // closed". That means a symlink whose target cannot be resolved in a
    // way that proves confinement — e.g. broken link pointing outside.
    const brokenOut = path.join(root, 'broken-out');
    fs.symlinkSync(path.join(tmp, 'missing-outside'), brokenOut);
    assertEscape(() => guard.confine('broken-out'), 'broken-out');
  });

  test('D9: bare .. denied; empty / . → root allowed', () => {
    assertEscape(() => guard.confine('..'), '..');
    const r1 = guard.confine('');
    const r2 = guard.confine('.');
    assert.equal(r1, guard.rootReal);
    assert.equal(r2, guard.rootReal);
  });

  // ── allows ────────────────────────────────────────────────────────────

  test('A1: ok.txt, subdir/x, root itself', () => {
    const a = guard.confine('ok.txt');
    assert.equal(a, path.join(guard.rootReal, 'ok.txt'));
    assert.equal(fs.readFileSync(a, 'utf8'), 'ok');

    const b = guard.confine('subdir/x');
    assert.equal(b, path.join(guard.rootReal, 'subdir', 'x'));

    assert.equal(guard.confine(guard.rootReal), guard.rootReal);
  });

  test('A2: in-root symlink and paths through it', { skip: !SYMLINKS_OK }, () => {
    const a = guard.confine('in-link');
    assert.equal(fs.readFileSync(a, 'utf8'), 'ok');
    // Returned path should be the real file under root.
    assert.ok(a.startsWith(guard.rootReal + path.sep) || a === guard.rootReal);

    const b = guard.confine(path.join('subdir-link', 'x'));
    assert.equal(fs.readFileSync(b, 'utf8'), 'x');
  });

  test('A3: non-existent subdir/new.txt allowed', () => {
    const p = guard.confine('subdir/new.txt');
    assert.equal(p, path.join(guard.rootReal, 'subdir', 'new.txt'));
    assert.ok(fs.existsSync(path.dirname(p)));
  });

  test('A4: nested missing a/b/c/new with only a existing', () => {
    fs.mkdirSync(path.join(root, 'a'));
    const p = guard.confine('a/b/c/new');
    assert.equal(p, path.join(guard.rootReal, 'a', 'b', 'c', 'new'));
    // Parent of full path may not exist; nearest existing ancestor does.
    assert.ok(fs.existsSync(path.join(guard.rootReal, 'a')));
  });

  test('A5: subdir/../ok.txt allowed', () => {
    const p = guard.confine('subdir/../ok.txt');
    assert.equal(p, path.join(guard.rootReal, 'ok.txt'));
  });

  test('A6: absolute path under root allowed', () => {
    const abs = path.join(root, 'ok.txt');
    const p = guard.confine(abs);
    assert.equal(fs.readFileSync(p, 'utf8'), 'ok');
  });

  test('A7: .//subdir/./x and trailing-sep forms', () => {
    const p = guard.confine('.//subdir/./x');
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
    // Trailing sep on existing dir → root-relative dir realpath
    const d = guard.confine('subdir/');
    assert.equal(d, path.join(guard.rootReal, 'subdir'));
  });

  // ── platform / contract ────────────────────────────────────────────────

  test(
    'C1: darwin wrong-case candidate confines to same real file',
    { skip: process.platform !== 'darwin' },
    () => {
      // APFS is typically case-insensitive / case-preserving.
      const wrong = guard.confine('OK.TXT');
      // May resolve to ok.txt on disk.
      assert.equal(fs.realpathSync.native(wrong), fs.realpathSync.native(path.join(root, 'ok.txt')));
    }
  );

  test('C2: guard built from symlinked root ≡ realpathed root', { skip: !SYMLINKS_OK }, () => {
    const linkRoot = path.join(tmp, 'ws-link');
    try {
      fs.symlinkSync(root, linkRoot);
    } catch {
      // already exists from prior run in same process — recreate
      fs.rmSync(linkRoot, { force: true });
      fs.symlinkSync(root, linkRoot);
    }
    const g2 = createPathGuard(linkRoot);
    assert.equal(g2.rootReal, guard.rootReal);
    assert.equal(g2.confine('ok.txt'), guard.confine('ok.txt'));
  });

  test('K1/K3: denials are PathEscapeError with PATH_ESCAPE; no absolute escape target in message', () => {
    try {
      guard.confine('../outside.txt');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof PathEscapeError);
      assert.equal(err.code, 'PATH_ESCAPE');
      assert.equal(err.requested, '../outside.txt');
      // Must not leak the absolute outside path.
      assert.ok(!err.message.includes(path.join(tmp, 'outside.txt')));
      assert.ok(!err.message.includes(tmp) || err.message.includes('../'));
    }
  });

  test('K4: returned path openable when target exists; else parent under rootReal', () => {
    const existing = guard.confine('ok.txt');
    assert.equal(fs.readFileSync(existing, 'utf8'), 'ok');

    const missing = guard.confine('subdir/brand-new.txt');
    assert.ok(!fs.existsSync(missing));
    const parent = path.dirname(missing);
    assert.ok(fs.existsSync(parent));
    const rel = path.relative(guard.rootReal, parent);
    assert.ok(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)));
  });

  test('deprecated confineToRoot still works (thin wrapper)', () => {
    const p = confineToRoot(root, 'ok.txt');
    assert.equal(fs.readFileSync(p, 'utf8'), 'ok');
    assert.throws(() => confineToRoot(root, '../outside.txt'), PathEscapeError);
  });

  test('process check: OLD lexical check would have passed D2 (symlink escape)', { skip: !SYMLINKS_OK }, () => {
    // Document the bug this PR fixes: pure path.resolve + startsWith lets
    // an in-workspace symlink to outside pass.
    const resolvedRoot = path.resolve(root);
    const requested = 'escape-link';
    const resolved = path.resolve(resolvedRoot, requested);
    const oldAllows =
      resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    assert.equal(oldAllows, true, 'old lexical guard would allow escape-link');
    // New guard denies:
    assertEscape(() => guard.confine(requested), requested);
  });
});
