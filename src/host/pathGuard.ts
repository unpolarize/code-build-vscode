import * as path from 'node:path';

/**
 * Confine an agent-requested file path to a root directory (the session cwd).
 *
 * Resolves relative paths against the root and normalizes `..`, then rejects
 * anything that escapes the root. This prevents a compromised or
 * prompt-injected ACP agent from reading or writing arbitrary files (e.g.
 * `~/.ssh/id_rsa`, `~/.aws/credentials`) via the `fs/*` bridge, which never
 * passes through the interactive permission UI.
 *
 * Returns the resolved absolute path on success; throws otherwise.
 */
export function confineToRoot(root: string, requested: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes workspace root: ${requested}`);
  }
  return resolved;
}
