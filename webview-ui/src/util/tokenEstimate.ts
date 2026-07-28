/**
 * Pre-send token estimate (heuristic).
 *
 * Used by the composer chip so users see rough outbound cost *before*
 * pressing Send. This is NOT a tokenizer — accuracy within ~20% is the
 * goal (chars/4 is the industry default when no model tokenizer is
 * available client-side). No network calls; pure functions only.
 *
 * Complements the post-turn usage footer / context-fill meter: those
 * report what already landed; this estimates what is about to leave.
 */

/** Rough tokens ≈ UTF-16 code units / 4. Empty → 0. */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  // Use length (UTF-16 code units). Good enough for Latin/CJK mix at the
  // accuracy bar we target; avoids depending on Intl.Segmenter.
  return Math.ceil(text.length / 4);
}

/**
 * Images: base64 payload length / 4 is a weak proxy for vision tokens.
 * Cap contribution so a huge paste doesn't dominate the chip; treat
 * missing data as a small flat cost so the chip still appears.
 */
export function estimateTokensFromImage(base64Data?: string): number {
  if (!base64Data) return 256;
  // base64 chars ≈ 4/3 of raw bytes; vision models bill ~tiles, not raw
  // bytes. Scale down aggressively so the estimate stays order-of-magnitude.
  const rawish = Math.ceil((base64Data.length * 3) / 4);
  return Math.min(8_000, Math.max(256, Math.ceil(rawish / 750)));
}

/** Hardcoded context-window table (tokens). Family match, longest-first. */
const CONTEXT_WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  // Anthropic Claude 4.x family — 200k
  { match: /claude|opus|sonnet|haiku/i, tokens: 200_000 },
  // xAI Grok
  { match: /grok/i, tokens: 128_000 },
  // OpenAI GPT-5 / o-series
  { match: /gpt-5|o3|o4|codex/i, tokens: 128_000 },
  // OpenAI GPT-4o / 4.1
  { match: /gpt-4|o1/i, tokens: 128_000 }
];

/** Lookup a known model family’s context window, or undefined. */
export function lookupContextWindow(model?: string | null): number | undefined {
  if (!model || model === 'default') return undefined;
  for (const row of CONTEXT_WINDOWS) {
    if (row.match.test(model)) return row.tokens;
  }
  return undefined;
}

export interface PreSendEstimateInput {
  /** Composer text about to be sent. */
  text: string;
  /** Pasted/dropped image base64 payloads (data only, no data: prefix). */
  imageData?: string[];
  /** Sticky primer / system prompt bytes when the host has already measured them. */
  primerChars?: number;
  /** Optional measured MCP tool-schema overhead in tokens. */
  schemaTokens?: number;
  /** Active model id for window % (optional). */
  model?: string | null;
}

export interface PreSendEstimate {
  /** Total estimated outbound tokens. */
  tokens: number;
  /** Context window when known. */
  windowTokens?: number;
  /** tokens / windowTokens * 100 when window known; else undefined. */
  windowPct?: number;
}

/** Compute a pre-send estimate from composer + optional known extras. */
export function computePreSendEstimate(input: PreSendEstimateInput): PreSendEstimate {
  const textTok = estimateTokensFromText(input.text ?? '');
  const imgTok = (input.imageData ?? []).reduce(
    (sum, d) => sum + estimateTokensFromImage(d),
    0
  );
  const primerTok =
    input.primerChars != null && input.primerChars > 0
      ? Math.ceil(input.primerChars / 4)
      : 0;
  const schemaTok =
    input.schemaTokens != null && input.schemaTokens > 0
      ? Math.ceil(input.schemaTokens)
      : 0;
  const tokens = textTok + imgTok + primerTok + schemaTok;
  const windowTokens = lookupContextWindow(input.model);
  const windowPct =
    windowTokens && windowTokens > 0
      ? Math.min(100, (tokens / windowTokens) * 100)
      : undefined;
  return { tokens, windowTokens, windowPct };
}

/** Format for the chip: `~12k tok · ~8% window` or `~420 tok`. Empty when 0. */
export function formatTokenEstimate(est: PreSendEstimate): string | null {
  if (!est || est.tokens <= 0) return null;
  const tokLabel = formatTokCount(est.tokens);
  if (est.windowPct != null && est.windowTokens != null) {
    let pct: string;
    if (est.windowPct < 1 && est.tokens > 0) {
      pct = '<1';
    } else if (est.windowPct < 10) {
      // One decimal when useful (1.2%), drop trailing .0 (8% not 8.0%).
      const one = est.windowPct.toFixed(1);
      pct = one.endsWith('.0') ? one.slice(0, -2) : one;
    } else {
      pct = String(Math.round(est.windowPct));
    }
    return `~${tokLabel} tok · ~${pct}% window`;
  }
  return `~${tokLabel} tok`;
}

function formatTokCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
