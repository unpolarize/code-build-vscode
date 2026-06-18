/**
 * Pure helpers for the composer's `@`-mention UX and drag-and-drop handling.
 * No DOM / vscode dependencies so they can be unit-tested directly.
 */

export interface ActiveMention {
  /** Index of the `@` in the text. */
  start: number;
  /** Token typed after the `@`, up to the caret (may be empty for a bare `@`). */
  query: string;
}

/**
 * Find the `@`-mention token the caret is currently inside, if any.
 *
 * Scans left from `caret` to the nearest `@` with no intervening whitespace.
 * The `@` must start the string or follow whitespace, so `you@host` is not a
 * mention. Returns the token span and query, or null when the caret is not in
 * a mention. A bare `@` returns an empty query (callers can show defaults).
 */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') break;
    if (/\s/.test(ch)) return null; // whitespace before any '@' → not in a mention
    i--;
  }
  if (i < 0 || text[i] !== '@') return null;
  // The '@' must begin the string or be preceded by whitespace.
  if (i > 0 && !/\s/.test(text[i - 1])) return null;
  return { start: i, query: text.slice(i + 1, caret) };
}

/**
 * Parse a `text/uri-list` payload (RFC 2483): one URI per line, `#` comments
 * and blank lines ignored. Used to read dropped Explorer resources.
 */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}
