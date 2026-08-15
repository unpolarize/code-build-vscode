// Reads the Grok Build (grok CLI) OIDC credential — the same trick Quill
// (xfreeze2/quill Auth.swift) uses: `grok` writes a subscription-backed token
// to ~/.grok/auth.json and refreshes it on its own schedule. That token is
// what its /voice mode presents to the xAI streaming STT endpoint. Read it
// fresh on every recording — never cache it, never copy it anywhere.
//
// Pure Node (no vscode import) so it stays unit-testable.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface GrokCreds {
  token: string;
  expiresAt?: Date;
  email?: string;
  /** 'apiKey' when the token came from a user-provided key, 'grok' otherwise. */
  source: 'grok' | 'apiKey';
}

export function grokAuthPath(): string {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

export function isExpired(creds: GrokCreds, now: Date = new Date()): boolean {
  return !!creds.expiresAt && creds.expiresAt < now;
}

/**
 * auth.json is keyed by issuer::principal. Take the most recently created
 * entry that actually carries a key.
 */
export function readGrokAuth(filePath: string = grokAuthPath()): GrokCreds | undefined {
  let root: unknown;
  try {
    root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!root || typeof root !== 'object') return undefined;

  let newest: Record<string, unknown> | undefined;
  let newestTime = -Infinity;
  for (const value of Object.values(root as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.key !== 'string' || !entry.key) continue;
    const created = parseDate(entry.create_time)?.getTime() ?? -Infinity;
    if (created >= newestTime || !newest) {
      newestTime = created;
      newest = entry;
    }
  }
  if (!newest) return undefined;
  return {
    token: newest.key as string,
    expiresAt: parseDate(newest.expires_at),
    email: typeof newest.email === 'string' ? newest.email : undefined,
    source: 'grok'
  };
}

/**
 * The credential the xai STT engine should use right now. A key the user
 * entered themselves wins over the subscription login (they went out of their
 * way to provide it); falls back to the grok CLI session otherwise.
 */
export function resolveXaiCreds(opts: {
  settingKey?: string;
  env?: NodeJS.ProcessEnv;
  authPath?: string;
}): GrokCreds | undefined {
  const key = opts.settingKey?.trim() || opts.env?.XAI_API_KEY?.trim();
  if (key) return { token: key, source: 'apiKey' };
  return readGrokAuth(opts.authPath);
}

/** Cheap availability probe for engine auto-resolution. */
export function xaiCredsLikely(opts: {
  settingKey?: string;
  env?: NodeJS.ProcessEnv;
  authPath?: string;
}): boolean {
  if (opts.settingKey?.trim() || opts.env?.XAI_API_KEY?.trim()) return true;
  try {
    return fs.existsSync(opts.authPath ?? grokAuthPath());
  } catch {
    return false;
  }
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}
