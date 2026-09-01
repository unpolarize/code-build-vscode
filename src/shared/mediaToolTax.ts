/**
 * Runtime browser/pixel tool-tax governor (v1).
 *
 * Meters **tool_result payloads** after a tool returns — image/pixel MIME and
 * large base64 blobs — distinct from the MCP schema budget (pre-send schema
 * tokens in mcpSchemaBudget.ts). Advisory + pause only: never rewrites tools.
 *
 * Token heuristic mirrors webview estimateTokensFromImage / chars÷4 so the
 * chip stays order-of-magnitude consistent with the composer estimate.
 */

export type MediaKind = 'image' | 'pixel' | 'text' | 'unknown';

export interface ClassifiedToolResultPart {
  kind: MediaKind;
  mimeType?: string;
  /** Raw payload size proxy (base64 chars or text length). */
  byteLength: number;
  /** Estimated vision/media tokens; 0 for plain text. */
  estimatedTokens: number;
  /**
   * Extra tokens vs treating the same payload as text (chars/4).
   * Positive for media; 0 for text.
   */
  extraTokens: number;
  reason: string;
}

export interface MediaToolTaxConfig {
  /** 'off' disables metering side-effects; classification still works. */
  mode: 'off' | 'warn';
  /** Soft gate: media result count this session. `<= 0` disables. Default 5. */
  maxMediaResults: number;
  /**
   * Soft gate: session media-tax tokens as % of context window.
   * `<= 0` disables. Default 15.
   */
  maxMediaWindowPct: number;
}

export const DEFAULT_MEDIA_TOOL_TAX_CONFIG: MediaToolTaxConfig = {
  mode: 'warn',
  maxMediaResults: 5,
  maxMediaWindowPct: 15
};

/** Prefer DOM / browser-personal over screenshot MCP loops. */
export const MEDIA_TAX_DOM_HINT =
  'Prefer browser-personal / DOM or text snapshots over screenshot / pixel MCP loops.';

const IMAGE_MIME = /^image\//i;
const PIXEL_MIME = /^(image\/|video\/|application\/octet-stream)/i;
/** Base64-ish blob long enough to be a real screenshot, not a short id. */
const LARGE_B64_MIN = 8_000;
const B64_CHAR = /^[A-Za-z0-9+/=\s]+$/;

/** Vision token estimate — same bounds as webview estimateTokensFromImage. */
export function estimateMediaTokensFromBase64(base64Data?: string): number {
  if (!base64Data) return 256;
  const rawish = Math.ceil((base64Data.length * 3) / 4);
  return Math.min(8_000, Math.max(256, Math.ceil(rawish / 750)));
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function looksLikeBase64Blob(s: string): boolean {
  if (s.length < LARGE_B64_MIN) return false;
  const sample = s.slice(0, 200).replace(/\s+/g, '');
  return sample.length >= 64 && B64_CHAR.test(sample);
}

function stripDataUrl(data: string): { mimeType?: string; payload: string } {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is.exec(data);
  if (!m) return { payload: data };
  return { mimeType: m[1] || undefined, payload: m[2] };
}

/**
 * Classify one ContentBlock-shaped or loose tool-result part.
 * Never throws — unknown shapes → kind unknown/text with zero media tax.
 */
export function classifyToolResultPart(
  part: unknown,
  toolTitle?: string
): ClassifiedToolResultPart {
  if (part == null) {
    return {
      kind: 'text',
      byteLength: 0,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: 'empty'
    };
  }

  if (typeof part === 'string') {
    const stripped = stripDataUrl(part);
    if (stripped.mimeType && IMAGE_MIME.test(stripped.mimeType)) {
      const tok = estimateMediaTokensFromBase64(stripped.payload);
      const textEq = estimateTextTokens(stripped.payload);
      return {
        kind: 'image',
        mimeType: stripped.mimeType,
        byteLength: stripped.payload.length,
        estimatedTokens: tok,
        extraTokens: Math.max(0, tok - Math.min(textEq, tok)),
        reason: 'data-url-image'
      };
    }
    if (looksLikeBase64Blob(part)) {
      const tok = estimateMediaTokensFromBase64(part);
      return {
        kind: 'pixel',
        byteLength: part.length,
        estimatedTokens: tok,
        extraTokens: tok,
        reason: 'large-base64-blob'
      };
    }
    const tok = estimateTextTokens(part);
    return {
      kind: 'text',
      byteLength: part.length,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: `text(~${tok} tok)`
    };
  }

  if (typeof part !== 'object') {
    return {
      kind: 'unknown',
      byteLength: 0,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: typeof part
    };
  }

  const o = part as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : undefined;
  const mimeType =
    (typeof o.mimeType === 'string' && o.mimeType) ||
    (typeof o.media_type === 'string' && o.media_type) ||
    (typeof o.mediaType === 'string' && o.mediaType) ||
    undefined;
  const data =
    typeof o.data === 'string'
      ? o.data
      : typeof o.source === 'object' &&
          o.source &&
          typeof (o.source as { data?: unknown }).data === 'string'
        ? String((o.source as { data: string }).data)
        : typeof o.text === 'string'
          ? o.text
          : undefined;

  // Explicit text blocks win — DOM/CLI snapshots must not be taxed as pixels
  // even when the body is long (or a tool title says "screenshot").
  if (type === 'text') {
    const text = String(o.text ?? '');
    return {
      kind: 'text',
      byteLength: text.length,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: 'content-block-text'
    };
  }

  if (type === 'image' || (mimeType && IMAGE_MIME.test(mimeType))) {
    const payload = data ?? '';
    const tok = estimateMediaTokensFromBase64(payload || undefined);
    return {
      kind: 'image',
      mimeType: mimeType ?? 'image/*',
      byteLength: payload.length,
      estimatedTokens: tok,
      extraTokens: tok,
      reason: type === 'image' ? 'content-block-image' : 'mime-image'
    };
  }

  if (mimeType && PIXEL_MIME.test(mimeType) && data && looksLikeBase64Blob(data)) {
    const tok = estimateMediaTokensFromBase64(data);
    return {
      kind: 'pixel',
      mimeType,
      byteLength: data.length,
      estimatedTokens: tok,
      extraTokens: tok,
      reason: 'mime-pixel-blob'
    };
  }

  if (typeof data === 'string' && looksLikeBase64Blob(data)) {
    const titleHint =
      !!toolTitle &&
      /screenshot|screencapture|take_photo|page\.screenshot/i.test(toolTitle);
    const tok = estimateMediaTokensFromBase64(data);
    return {
      kind: titleHint ? 'image' : 'pixel',
      mimeType,
      byteLength: data.length,
      estimatedTokens: tok,
      extraTokens: tok,
      reason: titleHint ? 'tool-title-screenshot+blob' : 'embedded-large-base64'
    };
  }

  if (typeof o.text === 'string') {
    const text = o.text;
    return {
      kind: 'text',
      byteLength: text.length,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: 'content-block-text'
    };
  }

  // Nested content arrays (ACP tool_result wrappers)
  if (Array.isArray(o.content)) {
    const nested = o.content.map((c) => classifyToolResultPart(c, toolTitle));
    return mergeClassifications(nested);
  }

  return {
    kind: 'unknown',
    byteLength: 0,
    estimatedTokens: 0,
    extraTokens: 0,
    reason: 'unrecognized-shape'
  };
}

function mergeClassifications(parts: ClassifiedToolResultPart[]): ClassifiedToolResultPart {
  if (parts.length === 0) {
    return {
      kind: 'text',
      byteLength: 0,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: 'empty-array'
    };
  }
  const media = parts.filter((p) => p.kind === 'image' || p.kind === 'pixel');
  if (media.length === 0) {
    const bytes = parts.reduce((s, p) => s + p.byteLength, 0);
    return {
      kind: 'text',
      byteLength: bytes,
      estimatedTokens: 0,
      extraTokens: 0,
      reason: 'all-text'
    };
  }
  const bytes = media.reduce((s, p) => s + p.byteLength, 0);
  const tok = media.reduce((s, p) => s + p.estimatedTokens, 0);
  const kind: MediaKind = media.some((p) => p.kind === 'image') ? 'image' : 'pixel';
  return {
    kind,
    mimeType: media.find((p) => p.mimeType)?.mimeType,
    byteLength: bytes,
    estimatedTokens: tok,
    extraTokens: tok,
    reason: `merged:${media.map((p) => p.reason).join('+')}`
  };
}

/** Classify a tool_call.content array (or single part). */
export function classifyToolResultContent(
  content: unknown,
  toolTitle?: string
): ClassifiedToolResultPart[] {
  if (content == null) return [];
  if (Array.isArray(content)) {
    return content.map((c) => classifyToolResultPart(c, toolTitle));
  }
  // ACP wrapper: [{ type:'content', content: block }]
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (Array.isArray(o.content)) {
      return o.content.map((c) => classifyToolResultPart(c, toolTitle));
    }
  }
  return [classifyToolResultPart(content, toolTitle)];
}

export function isMediaPart(p: ClassifiedToolResultPart): boolean {
  return p.kind === 'image' || p.kind === 'pixel';
}

export interface MediaToolTaxSnapshot {
  /** Media tokens attributed to the current open turn. */
  turnMediaTokens: number;
  /** Rolling session media-tax tokens. */
  sessionMediaTokens: number;
  /** Count of media tool results this session. */
  sessionMediaCount: number;
  /** Soft gate: thresholds crossed (warn mode). */
  pause: boolean;
  /** Which gate(s) fired. */
  pauseReasons: string[];
}

export interface MediaToolTaxChip {
  turnMediaTokens: number;
  sessionMediaTokens: number;
  sessionMediaCount: number;
  /** Short chip label, e.g. `media ~2.1k · sess 8.4k`. Empty tax → `media 0`. */
  label: string;
  warn: boolean;
  pause: boolean;
  /** Prefer-DOM host hint when pause/warn. */
  hint?: string;
}

function formatTokCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Build the header/HUD chip from a snapshot. */
export function evaluateMediaToolTaxChip(
  snap: MediaToolTaxSnapshot,
  opts?: { warn?: boolean }
): MediaToolTaxChip {
  const warn = opts?.warn === true || snap.pause;
  let label: string;
  if (snap.sessionMediaTokens <= 0 && snap.turnMediaTokens <= 0) {
    label = 'media 0';
  } else if (snap.turnMediaTokens > 0) {
    label = `media ~${formatTokCount(snap.turnMediaTokens)} · sess ${formatTokCount(snap.sessionMediaTokens)}`;
  } else {
    label = `media sess ${formatTokCount(snap.sessionMediaTokens)}`;
  }
  return {
    turnMediaTokens: snap.turnMediaTokens,
    sessionMediaTokens: snap.sessionMediaTokens,
    sessionMediaCount: snap.sessionMediaCount,
    label,
    warn,
    pause: snap.pause,
    ...(warn ? { hint: MEDIA_TAX_DOM_HINT } : {})
  };
}

/**
 * Per-session accumulator. Pure / timer-free — callers pass windowTokens for
 * the % gate. Each media result is counted once per toolCallId when provided.
 */
export class MediaToolTaxTracker {
  private turnMediaTokens = 0;
  private sessionMediaTokens = 0;
  private sessionMediaCount = 0;
  private seenToolIds = new Set<string>();
  private pauseFired = false;

  startTurn(): void {
    this.turnMediaTokens = 0;
  }

  endTurn(): void {
    this.turnMediaTokens = 0;
  }

  /**
   * Ingest tool_call / tool_call_update content. Returns the classified media
   * parts that contributed tax (empty when all text / already seen).
   */
  noteToolContent(
    content: unknown,
    opts?: { toolCallId?: string; toolTitle?: string }
  ): ClassifiedToolResultPart[] {
    const id = opts?.toolCallId;
    if (id && this.seenToolIds.has(id)) return [];
    const parts = classifyToolResultContent(content, opts?.toolTitle).filter(isMediaPart);
    if (parts.length === 0) return [];
    if (id) this.seenToolIds.add(id);
    const add = parts.reduce((s, p) => s + p.estimatedTokens, 0);
    this.turnMediaTokens += add;
    this.sessionMediaTokens += add;
    this.sessionMediaCount += parts.length;
    return parts;
  }

  snapshot(
    cfg: MediaToolTaxConfig = DEFAULT_MEDIA_TOOL_TAX_CONFIG,
    windowTokens?: number
  ): MediaToolTaxSnapshot {
    const pauseReasons: string[] = [];
    if (cfg.mode !== 'off') {
      if (cfg.maxMediaResults > 0 && this.sessionMediaCount >= cfg.maxMediaResults) {
        pauseReasons.push(
          `media results ${this.sessionMediaCount} ≥ limit ${cfg.maxMediaResults}`
        );
      }
      if (
        cfg.maxMediaWindowPct > 0 &&
        typeof windowTokens === 'number' &&
        windowTokens > 0 &&
        (this.sessionMediaTokens / windowTokens) * 100 >= cfg.maxMediaWindowPct
      ) {
        const pct = ((this.sessionMediaTokens / windowTokens) * 100).toFixed(1);
        pauseReasons.push(
          `media tax ${pct}% of window ≥ ${cfg.maxMediaWindowPct}%`
        );
      }
    }
    return {
      turnMediaTokens: this.turnMediaTokens,
      sessionMediaTokens: this.sessionMediaTokens,
      sessionMediaCount: this.sessionMediaCount,
      pause: pauseReasons.length > 0,
      pauseReasons
    };
  }

  /**
   * Soft gate: returns chip + whether this is a newly crossed pause (fire once).
   * mode 'off' never pauses.
   */
  check(
    cfg: MediaToolTaxConfig = DEFAULT_MEDIA_TOOL_TAX_CONFIG,
    windowTokens?: number
  ): { chip: MediaToolTaxChip; newlyPaused: boolean; pauseReasons: string[] } {
    const snap = this.snapshot(cfg, windowTokens);
    const chip = evaluateMediaToolTaxChip(snap);
    let newlyPaused = false;
    if (cfg.mode !== 'off' && snap.pause && !this.pauseFired) {
      this.pauseFired = true;
      newlyPaused = true;
    }
    return { chip, newlyPaused, pauseReasons: snap.pauseReasons };
  }

  /** Test/helper accessors. */
  getSessionMediaCount(): number {
    return this.sessionMediaCount;
  }
}
