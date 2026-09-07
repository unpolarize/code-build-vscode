// Claude /design artboard pick binder — pure transcript-scanning core
// (kp: ideas/cb-design-artboard-pick-binder-capture-claude-de).
//
// Anthropic's `/design` research preview turns a UI description into
// editable artboards (Claude artifacts); the user picks one and implements
// against it. That pick lives only in the Claude transcript, so the moment
// a multi-backend session moves to Codex/Grok the chosen visual contract is
// lost. This module extracts artboard/artifact URLs (with any label the
// transcript gives them) from assistant text so the host can bind the chosen
// one into a KP item's Acceptance — making the design decision git-backed
// and vendor-portable. v1 is capture+bind only: no Claude Design MCP calls,
// no uploads, transcript text is the sole input.

export interface DesignArtboardRef {
  /** Canonical artboard/artifact URL (query/fragment stripped). */
  url: string;
  /** Human label from the transcript (markdown link text, "Variant B", …). */
  label?: string;
}

/** claude.ai artifact/design/artboard URLs. Path segments are liberal on
 * purpose — /design is a moving research preview; anchoring on the host +
 * a known family segment beats pinning today's exact route shape. */
const ARTBOARD_URL_RE =
  /https:\/\/claude\.ai\/(?:public\/)?(?:artifacts?|design|artboards?)\/[A-Za-z0-9][A-Za-z0-9\-_/.]*/g;

/** Markdown link whose target is an artboard URL: `[label](url)`. */
const MD_LINK_RE = /\[([^\]\n]{1,120})\]\(\s*(https:\/\/claude\.ai\/[^)\s]+)\s*\)/g;

/** Loose same-line label preceding a bare URL: "Variant B", "Option 2",
 * "Artboard 3" (optionally bolded). */
const NEARBY_LABEL_RE =
  /(?:\*\*|__)?((?:variant|option|artboard|version)\s+[A-Za-z0-9]{1,12})(?:\*\*|__)?\s*[:—–-]?\s*$/i;

function canonicalUrl(raw: string): string {
  // Strip query/fragment and trailing punctuation a prose sentence may add.
  return raw.split(/[?#]/)[0].replace(/[.,;:!)\]]+$/, '').replace(/\/+$/, '');
}

/** Extract artboard refs from one block of transcript text, in order of
 * first appearance. A markdown link's text wins as the label; a bare URL
 * looks left on its own line for a "Variant X"-style label. */
export function extractDesignArtboards(text: string): DesignArtboardRef[] {
  if (!text) return [];
  const refs: DesignArtboardRef[] = [];
  const labelByUrl = new Map<string, string>();

  for (const m of text.matchAll(MD_LINK_RE)) {
    const urls = m[2].match(ARTBOARD_URL_RE);
    if (!urls) continue;
    const url = canonicalUrl(urls[0]);
    const label = m[1].trim();
    if (label && !labelByUrl.has(url)) labelByUrl.set(url, label);
  }

  for (const line of text.split('\n')) {
    ARTBOARD_URL_RE.lastIndex = 0;
    for (const m of line.matchAll(ARTBOARD_URL_RE)) {
      const url = canonicalUrl(m[0]);
      if (!labelByUrl.has(url)) {
        const before = line.slice(0, m.index).replace(/[\[\(<"'`]+\s*$/, '');
        const lm = before.match(NEARBY_LABEL_RE);
        if (lm) labelByUrl.set(url, lm[1].trim());
      }
      if (!refs.some((r) => r.url === url)) {
        refs.push({ url });
      }
    }
  }

  for (const ref of refs) {
    const label = labelByUrl.get(ref.url);
    if (label) ref.label = label;
  }
  return refs;
}

/** Scan many transcript text blocks (assistant turns, in order), dedupe by
 * URL. First appearance fixes the order; the first non-empty label wins so
 * a later bare repeat of the URL can't erase the labeled introduction. */
export function collectDesignArtboards(texts: Iterable<string | undefined>): DesignArtboardRef[] {
  const byUrl = new Map<string, DesignArtboardRef>();
  for (const text of texts) {
    if (!text) continue;
    for (const ref of extractDesignArtboards(text)) {
      const prev = byUrl.get(ref.url);
      if (!prev) byUrl.set(ref.url, ref);
      else if (!prev.label && ref.label) prev.label = ref.label;
    }
  }
  return [...byUrl.values()];
}

/** Acceptance bullets for `kp edit <id> --append-section "## Acceptance"`.
 * One bullet carries the whole contract (URL + label + provenance) so a
 * later reader — or a Codex/Grok implement run — needs no other context. */
export function formatArtboardAcceptanceBullets(
  ref: DesignArtboardRef,
  opts?: { boundAt?: string; sessionId?: string }
): string {
  // Labels come from transcript text — strip markdown metacharacters and
  // newlines so a hostile/odd label can't malform the Acceptance bullet
  // that later implement runs parse.
  const safeLabel = ref.label
    ?.replace(/[*_`\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const label = safeLabel ? `**${safeLabel}** — ` : '';
  const prov = [
    'bound from Code Build /design pick',
    opts?.boundAt,
    opts?.sessionId ? `session ${opts.sessionId}` : undefined
  ]
    .filter(Boolean)
    .join(', ');
  return `- Implement against the chosen design artboard: ${label}${ref.url} (${prov})`;
}
