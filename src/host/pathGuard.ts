import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Thrown when an agent-requested path escapes the workspace root (or is
 * otherwise unsafe to open). `code` is always `'PATH_ESCAPE'`. The message
 * and `requested` field carry only the agent-supplied path — never the
 * resolved absolute escape target — so existence outside the root cannot
 * leak through error text.
 */
export class PathEscapeError extends Error {
  readonly code = 'PATH_ESCAPE' as const;
  readonly requested: string;

  constructor(requested: string) {
    super(`Path escapes workspace root: ${requested}`);
    this.name = 'PathEscapeError';
    this.requested = requested;
  }
}

export interface PathGuard {
  /** Native realpath of the workspace root (constructed once). */
  readonly rootReal: string;
  /**
   * Confine an agent-requested path to `rootReal`.
   * Returns the confined absolute path (real where the path exists).
   * Throws `PathEscapeError` on escape / null-byte / fail-closed realpath.
   */
  confine(candidate: string): string;
}

/**
 * Build a path guard for a session workspace root.
 *
 * The root is realpathed once at construction (handles macOS `/var` →
 * `/private/var` and a root that is itself a symlink). Missing or non-directory
 * roots throw immediately so a misconfigured session fails closed.
 *
 * Residual limits (documented, not fixed by a pure path guard):
 * - TOCTOU vs concurrent symlink replacer between confine and open
 * - hardlink-to-outside-inode
 * - bypass mode skips this guard entirely (product trust model)
 */
export function createPathGuard(root: string): PathGuard {
  const resolvedRoot = path.resolve(root);
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(resolvedRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Path guard root is not a usable directory: ${resolvedRoot}` +
        (code ? ` (${code})` : '')
    );
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(rootReal);
  } catch {
    throw new Error(`Path guard root is not a usable directory: ${resolvedRoot}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Path guard root is not a directory: ${resolvedRoot}`);
  }

  return {
    rootReal,
    confine(candidate: string): string {
      return confineWithRoot(rootReal, candidate);
    },
  };
}

/**
 * @deprecated Prefer `createPathGuard(root).confine(requested)` so the root
 * is realpathed once per session. This wrapper creates a fresh guard each call.
 */
export function confineToRoot(root: string, requested: string): string {
  return createPathGuard(root).confine(requested);
}

function confineWithRoot(rootReal: string, candidate: string): string {
  if (candidate.includes('\0')) {
    throw new PathEscapeError(candidate);
  }

  // path.resolve: absolute candidate replaces root; relative joins under root.
  const resolved = path.resolve(rootReal, candidate);
  const candidateReal = realpathAllowMissing(resolved, candidate);

  if (!isInsideRoot(rootReal, candidateReal)) {
    throw new PathEscapeError(candidate);
  }
  return candidateReal;
}

/**
 * Realpath a path that may not exist yet: walk up to the nearest existing
 * ancestor, realpath that, rejoin the missing tail. Fail closed on ENOTDIR
 * (intermediate is a file), broken symlinks, or any other realpath error.
 *
 * Broken symlink at the leaf (or any ancestor): realpath fails with ENOENT
 * while lstat shows a symlink → fail closed (D8). Missing ordinary paths
 * walk up and rejoin the tail under the real ancestor.
 */
function realpathAllowMissing(resolved: string, requested: string): string {
  // Fast path: fully existing path (file, dir, or symlink to either).
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') {
      throw new PathEscapeError(requested);
    }
    if (code !== 'ENOENT') {
      // ELOOP, EACCES, etc. — fail closed without leaking the outside path.
      throw new PathEscapeError(requested);
    }
  }

  // ENOENT on realpath: either truly missing, or a broken symlink.
  // Broken symlink → fail closed (do not rejoin basename under parent).
  try {
    const lst = fs.lstatSync(resolved);
    if (lst.isSymbolicLink()) {
      throw new PathEscapeError(requested);
    }
    // Exists but realpath failed for another reason — fail closed.
    throw new PathEscapeError(requested);
  } catch (err) {
    if (err instanceof PathEscapeError) throw err;
    // lstat ENOENT → path truly missing; walk up.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PathEscapeError(requested);
    }
  }

  // Walk up until an existing ancestor is found.
  let ancestor = resolved;
  const missing: string[] = [];
  for (;;) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      // Reached filesystem root without finding anything — fail closed.
      throw new PathEscapeError(requested);
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
    try {
      const realAncestor = fs.realpathSync.native(ancestor);
      // Rejoin missing tail with path.join (normalizes, no re-resolve of abs).
      return path.join(realAncestor, ...missing);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') {
        throw new PathEscapeError(requested);
      }
      if (code === 'ENOENT') {
        // Broken symlink ancestor → fail closed.
        try {
          if (fs.lstatSync(ancestor).isSymbolicLink()) {
            throw new PathEscapeError(requested);
          }
        } catch (e2) {
          if (e2 instanceof PathEscapeError) throw e2;
          // ancestor truly missing — keep walking
        }
        continue;
      }
      throw new PathEscapeError(requested);
    }
  }
}

/**
 * Containment check using path.relative — never string startsWith.
 * Allow iff relative is '' (the root itself) or does not start with '..'
 * and is not an absolute path (Windows drive-relative edge).
 */
function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}
