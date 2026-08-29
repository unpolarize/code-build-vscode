import * as path from 'node:path';

export const LAST_SESSION_KEY = 'codeBuild.lastSessionId';

/**
 * Issue #6: a session recorded in workspace A must not remount in workspace B.
 * Empty cwd is treated as "unknown origin" and is refused when a folder is open.
 * No-folder windows (empty workspaceFolders) allow restore.
 */
export function sessionMatchesWorkspace(sessionCwd: string | undefined, workspaceFolders: string[]): boolean {
  if (workspaceFolders.length === 0) return true;
  if (!sessionCwd || !sessionCwd.trim()) return false;
  const cwd = path.resolve(sessionCwd);
  return workspaceFolders.some((folder) => {
    const w = path.resolve(folder);
    return cwd === w || cwd.startsWith(w + path.sep);
  });
}
