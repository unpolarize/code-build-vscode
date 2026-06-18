/**
 * Pure (vscode-free) helpers for `@`-mention file suggestions and drag-and-drop
 * resolution. Kept side-effect-free so they can be unit-tested without the
 * `vscode` runtime; `sessionManager.ts` wires them to `findFiles` / the editor.
 */

export interface FileSuggestion {
  path: string;
  label?: string;
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg'
]);

/** True when the path's extension is a known raster/vector image type. */
export function isImagePath(p: string): boolean {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(p.slice(dot).toLowerCase());
}

/** Light escaping for the glob specials (`*`, `?`, braces, brackets, parens). */
export function globEscape(s: string): string {
  return s.replace(/[?*{}[\]()!]/g, (ch) => `\\${ch}`);
}

/** Split a query on its last slash into a directory part and a filename part. */
function splitQuery(query: string): { dir: string; name: string } {
  const q = query.trim();
  const slash = q.lastIndexOf('/');
  if (slash < 0) return { dir: '', name: q };
  return { dir: q.slice(0, slash), name: q.slice(slash + 1) };
}

/**
 * Build the `findFiles` glob for a query.
 *  - `agent`         → basename match anywhere in the workspace
 *  - `classic/`      → every file under any folder named `classic`
 *  - `classic/agent` → files named like `agent` under a `classic` folder
 */
export function buildSuggestGlob(query: string): string {
  const { dir, name } = splitQuery(query);
  const nameGlob = name ? `*${globEscape(name)}*` : '*';
  if (!dir) return `**/${nameGlob}`;
  const dirGlob = dir
    .split('/')
    .map((seg) => globEscape(seg))
    .join('/');
  return `**/${dirGlob}/**/${nameGlob}`;
}

/**
 * Filter `candidates` to those matching `query`, then rank: recently-used
 * (open) files first, then exact path-prefix, then path-substring, then
 * basename matches. Stable — ties keep the input (findFiles) order.
 */
export function rankFileSuggestions(
  query: string,
  candidates: FileSuggestion[],
  openPaths: Set<string>
): FileSuggestion[] {
  const { dir, name } = splitQuery(query);
  const qLower = query.trim().toLowerCase();
  const dirLower = dir.toLowerCase();
  const nameLower = name.toLowerCase();

  const basename = (p: string) => {
    const slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(slash + 1) : p;
  };

  const matches = (p: string): boolean => {
    const pLower = p.toLowerCase();
    if (dir) {
      // Must live under a folder matching the dir part AND the basename must
      // contain the name part (empty name → every file in the folder).
      const inFolder =
        pLower.includes(`/${dirLower}/`) || pLower.startsWith(`${dirLower}/`);
      return inFolder && basename(pLower).includes(nameLower);
    }
    return pLower.includes(qLower);
  };

  const score = (p: string): number => {
    const pLower = p.toLowerCase();
    const baseLower = basename(pLower);
    let s = 0;
    if (openPaths.has(p)) s += 100;
    if (pLower.startsWith(qLower)) s += 40;
    else if (pLower.includes(qLower)) s += 20;
    if (nameLower && baseLower.startsWith(nameLower)) s += 10;
    else if (nameLower && baseLower.includes(nameLower)) s += 5;
    return s;
  };

  return candidates
    .filter((c) => matches(c.path))
    .map((c, i) => ({ c, i, s: score(c.path) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}
