/**
 * ACP cache-miss segment diagnostics chip — why the last prompt-cache
 * miss happened (system / tools / history / unknown) across backends.
 *
 * Claude Cache Diagnostics class: consecutive-request misses named by
 * prefix segment (`model ✓ → tools ✓ → system ✗` + missed tokens).
 * Distinct from the parked prompt-cache hit meter (rate only) and the
 * TTL idle chip. Never claims Anthropic's exact diagnostics API for
 * other vendors — degrades to hit% when the miss segment is unknown.
 */

export type CacheMissSegment = 'system' | 'tools' | 'history' | 'unknown';

/** Host pre-send gate. `off` keeps the chip and skips notices. */
export type CacheMissMode = 'off' | 'warn';

export interface CacheMissChip {
  /** False when the payload had no cache fields — chip hidden / n/a. */
  available: boolean;
  /** 0–100 cache-read share of the prompt. Null when n/a. */
  hitPct: number | null;
  /** Last miss segment; null on first-turn cache write or full hit. */
  lastMissSegment: CacheMissSegment | null;
  /** Tokens that missed the cache this turn (creation + uncached prefix). */
  lastMissTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  inputTokens: number | null;
  /**
   * Short chip label, e.g. `cache 72% · sys +4.2k`, `cache 98%`,
   * `cache n/a`. Tooltip carries the full `cache: hit% | last miss: …`.
   */
  label: string;
  /** Amber when the miss is host-controllable (system/tools) or severe. */
  warn: boolean;
  warnReason?: string;
  sourceDetail?: string;
}

/** Host-side prefix mutations that invalidate a cached prompt prefix. */
export interface HostPrefixMutation {
  injectsClock?: boolean;
  injectsNonce?: boolean;
  /** Dynamic header injected *before* the stable system/tools prefix. */
  dynamicHeaderBeforeStablePrefix?: boolean;
  toolsReordered?: boolean;
  toolsAdded?: boolean;
}

/** Loose usage / diagnostics payload (Claude, Codex, generic ACP). */
export interface CacheUsageFields {
  inputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_missed_input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_creation?: unknown;
  cacheCreation?: unknown;
  cache_diagnostics?: unknown;
  cacheDiagnostics?: unknown;
  cache_miss_reason?: unknown;
  cacheMissReason?: unknown;
  miss_segment?: unknown;
  missSegment?: unknown;
  system_changed?: unknown;
  tools_changed?: unknown;
  history_changed?: unknown;
  systemChanged?: unknown;
  toolsChanged?: unknown;
  historyChanged?: unknown;
  usage?: unknown;
  _meta?: unknown;
}

export interface CacheMissSnapshot {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  missTokens: number;
  totalPromptTokens: number;
}

export interface CacheMissGate {
  action: 'allow' | 'warn';
  message?: string;
  segment?: CacheMissSegment;
}

const SEGMENTS: CacheMissSegment[] = ['system', 'tools', 'history', 'unknown'];

/** Prefix-order of Anthropic-class cache breakpoints. */
const PREFIX_ORDER = ['model', 'tools', 'system', 'history'] as const;

export const CACHE_MISS_WARN_HIT_PCT = 10;
export const CACHE_MISS_SEVERE_TOKENS = 1000;

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return null;
}

function asSegment(v: unknown): CacheMissSegment | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if ((SEGMENTS as string[]).includes(s)) return s as CacheMissSegment;
  if (s === 'sys' || s === 'system_prompt' || s === 'system-prompt') return 'system';
  if (s === 'tool' || s === 'tool_list' || s === 'mcp') return 'tools';
  if (s === 'messages' || s === 'conversation' || s === 'hist') return 'history';
  return null;
}

function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Compact token count for the chip (`+4.2k`, `+40k`, `+512`). */
export function formatCacheTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    const v = abs / 1_000_000;
    return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}m`;
  }
  if (abs >= 1000) {
    const v = abs / 1000;
    return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}k`;
  }
  return String(Math.round(abs));
}

function shortSegment(seg: CacheMissSegment): string {
  if (seg === 'system') return 'sys';
  if (seg === 'history') return 'hist';
  if (seg === 'unknown') return 'unk';
  return 'tools';
}

function unwrapUsage(fields: CacheUsageFields | null | undefined): Record<string, unknown> | null {
  if (!fields || typeof fields !== 'object') return null;
  const top = fields as Record<string, unknown>;
  const nested = asRecord(top.usage);
  const meta = asRecord(top._meta);
  const metaUsage = meta ? asRecord(meta.usage) : null;
  return { ...(meta ?? {}), ...(nested ?? {}), ...(metaUsage ?? {}), ...top };
}

function cacheCreationFromObject(raw: unknown): number {
  const rec = asRecord(raw);
  if (!rec) return 0;
  const keys = [
    'ephemeral_5m_input_tokens',
    'ephemeral_1h_input_tokens',
    'ephemeral5mInputTokens',
    'ephemeral1hInputTokens',
    'input_tokens',
    'inputTokens'
  ];
  let sum = 0;
  let any = false;
  for (const k of keys) {
    const n = asFiniteNumber(rec[k]);
    if (n != null) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : 0;
}

/**
 * Pull cache-read / cache-creation / uncached input from Claude-shaped,
 * Codex-shaped, or generic ACP usage. Never throws.
 */
export function parseCacheUsage(
  fields: CacheUsageFields | null | undefined
): CacheMissSnapshot | null {
  const u = unwrapUsage(fields);
  if (!u) return null;

  const cacheRead =
    asFiniteNumber(
      u.cacheReadTokens ??
        u.cache_read_input_tokens ??
        u.cached_input_tokens ??
        u.cache_read
    ) ?? 0;
  const creationObj = cacheCreationFromObject(u.cache_creation ?? u.cacheCreation);
  const cacheCreation =
    asFiniteNumber(u.cacheCreationTokens ?? u.cache_creation_input_tokens) ??
    (creationObj > 0 ? creationObj : 0);
  const missedExplicit = asFiniteNumber(
    u.cache_missed_input_tokens ?? u.cacheMissedInputTokens
  );
  const input = asFiniteNumber(u.inputTokens ?? u.input_tokens) ?? 0;

  const hasCacheField =
    asFiniteNumber(u.cacheReadTokens) != null ||
    asFiniteNumber(u.cache_read_input_tokens) != null ||
    asFiniteNumber(u.cached_input_tokens) != null ||
    asFiniteNumber(u.cacheCreationTokens) != null ||
    asFiniteNumber(u.cache_creation_input_tokens) != null ||
    asFiniteNumber(u.cache_missed_input_tokens) != null ||
    asFiniteNumber(u.cacheMissedInputTokens) != null ||
    creationObj > 0;
  if (!hasCacheField) return null;

  // Claude: input_tokens is uncached (exclusive of cache_read/creation).
  // Codex: input_tokens is the full prompt; cached_input_tokens ⊆ input.
  const claudeNamed =
    asFiniteNumber(u.cache_read_input_tokens) != null ||
    asFiniteNumber(u.cache_creation_input_tokens) != null ||
    creationObj > 0 ||
    asFiniteNumber(u.cacheCreationTokens) != null;
  const exclusive =
    claudeNamed || cacheRead + cacheCreation > input + 1;

  const totalPromptTokens = exclusive
    ? input + cacheRead + cacheCreation
    : Math.max(input, cacheRead + cacheCreation);
  const missTokens =
    missedExplicit ??
    (exclusive
      ? cacheCreation + Math.max(0, input)
      : Math.max(0, totalPromptTokens - cacheRead));
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    missTokens,
    totalPromptTokens
  };
}

function hitStatus(v: unknown): 'hit' | 'miss' | 'unknown' {
  if (v === true || v === 'hit' || v === '✓' || v === 'yes' || v === 'cached') {
    return 'hit';
  }
  if (
    v === false ||
    v === 'miss' ||
    v === '✗' ||
    v === 'no' ||
    v === 'changed' ||
    v === 'invalidated'
  ) {
    return 'miss';
  }
  return 'unknown';
}

function firstMissInPrefixOrder(diag: Record<string, unknown>): CacheMissSegment | null {
  const segments = asRecord(diag.segments) ?? asRecord(diag.segment) ?? diag;
  for (const key of PREFIX_ORDER) {
    const status = hitStatus(segments[key] ?? segments[`${key}_changed`]);
    if (status === 'miss') {
      if (key === 'model') return 'system';
      if (key === 'tools') return 'tools';
      if (key === 'system') return 'system';
      return 'history';
    }
  }
  return null;
}

function classifyFromDiagnostics(
  fields: Record<string, unknown>
): { segment: CacheMissSegment; detail: string } | null {
  const explicit = asSegment(
    fields.miss_segment ??
      fields.missSegment ??
      fields.cache_miss_reason ??
      fields.cacheMissReason
  );
  if (explicit) {
    return { segment: explicit, detail: 'vendor cache_miss_reason' };
  }

  const diag =
    asRecord(fields.cache_diagnostics) ??
    asRecord(fields.cacheDiagnostics) ??
    asRecord(fields.cache);
  if (diag) {
    const fromDiag = asSegment(
      diag.miss_segment ?? diag.missSegment ?? diag.reason ?? diag.missed
    );
    if (fromDiag) {
      return { segment: fromDiag, detail: 'vendor cache_diagnostics' };
    }
    const ordered = firstMissInPrefixOrder(diag);
    if (ordered) {
      return {
        segment: ordered,
        detail: 'vendor cache_diagnostics prefix-order (model→tools→system→history)'
      };
    }
  }

  const sys =
    asBool(fields.system_changed ?? fields.systemChanged) === true;
  const tools =
    asBool(fields.tools_changed ?? fields.toolsChanged) === true;
  const hist =
    asBool(fields.history_changed ?? fields.historyChanged) === true;
  if (sys) return { segment: 'system', detail: 'vendor system_changed' };
  if (tools) return { segment: 'tools', detail: 'vendor tools_changed' };
  if (hist) return { segment: 'history', detail: 'vendor history_changed' };

  return null;
}

/**
 * Map host prefix-injection flags onto a miss segment.
 * Clock/nonce/dynamic header → system; tool list edits → tools.
 */
export function classifyHostPrefixMutation(
  mutation: HostPrefixMutation | null | undefined
): { segment: CacheMissSegment; detail: string } | null {
  if (!mutation) return null;
  if (mutation.injectsClock) {
    return { segment: 'system', detail: 'host injecting clock into prefix' };
  }
  if (mutation.injectsNonce) {
    return { segment: 'system', detail: 'host injecting nonce into prefix' };
  }
  if (mutation.dynamicHeaderBeforeStablePrefix) {
    return {
      segment: 'system',
      detail: 'host dynamic header before stable cached prefix'
    };
  }
  if (mutation.toolsReordered) {
    return { segment: 'tools', detail: 'host reordered tool list' };
  }
  if (mutation.toolsAdded) {
    return { segment: 'tools', detail: 'host added tools to prefix' };
  }
  return null;
}

function classifyHeuristic(
  snap: CacheMissSnapshot,
  previous: CacheMissSnapshot | null | undefined
): { segment: CacheMissSegment; detail: string } | null {
  if (!previous) return null;
  const expectedRead = previous.cacheReadTokens + previous.cacheCreationTokens;
  if (expectedRead <= 0) return null;
  // Previously written prefix no longer reads back → prefix invalidation.
  if (snap.cacheReadTokens < expectedRead * 0.9) {
    return {
      segment: 'unknown',
      detail: 'prefix cache-read dropped vs prior write (segment unknown)'
    };
  }
  // Prefix held; new tokens are conversation growth.
  if (snap.cacheCreationTokens > 0 || snap.missTokens > 0) {
    return { segment: 'history', detail: 'prefix held; new tokens are history' };
  }
  return null;
}

function buildLabel(
  available: boolean,
  hitPct: number | null,
  segment: CacheMissSegment | null,
  missTokens: number | null,
  firstWrite: boolean
): string {
  if (!available || hitPct == null) return 'cache n/a';
  if (firstWrite && (missTokens ?? 0) > 0) {
    return `cache write +${formatCacheTokens(missTokens ?? 0)}`;
  }
  if (!segment || (missTokens ?? 0) <= 0 || hitPct >= 99) {
    return `cache ${hitPct}%`;
  }
  return `cache ${hitPct}% · ${shortSegment(segment)} +${formatCacheTokens(missTokens ?? 0)}`;
}

/**
 * Build the header chip from a usage payload. Never throws.
 * `previous` enables consecutive-request miss detection (first write is
 * not a miss). `hostMutation` overlays a segment when the vendor omitted
 * diagnostics.
 */
export function evaluateCacheMissChip(input: {
  usage?: CacheUsageFields | null;
  previous?: CacheMissSnapshot | null;
  hostMutation?: HostPrefixMutation | null;
}): CacheMissChip {
  const snap = parseCacheUsage(input.usage ?? null);
  if (!snap) {
    return {
      available: false,
      hitPct: null,
      lastMissSegment: null,
      lastMissTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      inputTokens: null,
      label: 'cache n/a',
      warn: false
    };
  }

  const hitPct =
    snap.totalPromptTokens > 0
      ? roundPct((100 * snap.cacheReadTokens) / snap.totalPromptTokens)
      : 0;

  const raw = unwrapUsage(input.usage) ?? {};
  const vendor = classifyFromDiagnostics(raw);
  const host = classifyHostPrefixMutation(input.hostMutation);
  const heuristic = classifyHeuristic(snap, input.previous);

  const firstWrite = !input.previous && snap.cacheReadTokens === 0 && snap.cacheCreationTokens > 0;

  let segment: CacheMissSegment | null = null;
  let sourceDetail: string | undefined;
  if (vendor) {
    segment = vendor.segment;
    sourceDetail = vendor.detail;
  } else if (host) {
    segment = host.segment;
    sourceDetail = host.detail;
  } else if (heuristic) {
    segment = heuristic.segment;
    sourceDetail = heuristic.detail;
  } else if (firstWrite) {
    segment = null;
    sourceDetail = 'first-turn cache write (not a consecutive miss)';
  } else if (snap.missTokens > 0 && hitPct < 99) {
    segment = 'unknown';
    sourceDetail = 'cache fields present; vendor segment omitted';
  }

  const lastMissSegment = firstWrite ? null : segment;
  const lastMissTokens = firstWrite
    ? Math.round(snap.cacheCreationTokens)
    : snap.missTokens > 0
      ? Math.round(snap.missTokens)
      : null;

  const hostControllable =
    lastMissSegment === 'system' || lastMissSegment === 'tools';
  const severe =
    !firstWrite &&
    hitPct < CACHE_MISS_WARN_HIT_PCT &&
    (lastMissTokens ?? 0) >= CACHE_MISS_SEVERE_TOKENS;
  const warn = hostControllable || severe;

  let warnReason: string | undefined;
  if (hostControllable) {
    warnReason =
      `Last prompt-cache miss was ${lastMissSegment}` +
      (lastMissTokens != null ? ` (+${formatCacheTokens(lastMissTokens)} tok)` : '') +
      (sourceDetail ? ` — ${sourceDetail}` : '') +
      '. Host-controllable prefix; avoid clock/nonce/reordered tools before the stable prefix.';
  } else if (severe) {
    warnReason =
      `Severe cache miss (${hitPct}% hit, +${formatCacheTokens(lastMissTokens ?? 0)} tok)` +
      (lastMissSegment ? `, segment ${lastMissSegment}` : ', segment unknown') +
      '.';
  }

  return {
    available: true,
    hitPct,
    lastMissSegment,
    lastMissTokens,
    cacheReadTokens: snap.cacheReadTokens,
    cacheCreationTokens: snap.cacheCreationTokens,
    inputTokens: snap.inputTokens,
    label: buildLabel(
      true,
      hitPct,
      lastMissSegment,
      lastMissTokens,
      firstWrite
    ),
    warn,
    ...(warnReason ? { warnReason } : {}),
    ...(sourceDetail ? { sourceDetail } : {})
  };
}

/**
 * Pre-send gate: warn when the host is about to mutate a cached prefix.
 * Never blocks send — the miss is observational. `mode: off` always allows.
 */
export function checkPrefixMutation(input: {
  mutation?: HostPrefixMutation | null;
  mode?: CacheMissMode | null;
}): CacheMissGate {
  const mode = parseCacheMissMode(input.mode);
  if (mode === 'off') return { action: 'allow' };
  const hit = classifyHostPrefixMutation(input.mutation);
  if (!hit) return { action: 'allow' };
  return {
    action: 'warn',
    segment: hit.segment,
    message:
      `About to mutate the cached ${hit.segment} prefix (${hit.detail}). ` +
      'This typically forces a prompt-cache miss on the next turn.'
  };
}

/** Normalize a VS Code setting string into CacheMissMode. */
export function parseCacheMissMode(raw: unknown): CacheMissMode {
  if (raw === 'off' || raw === 'warn') return raw;
  return 'warn';
}

/** SessionUpdate payload from a chip (normalizers / host). */
export function toCacheMissUpdate(chip: CacheMissChip): {
  kind: 'cache_miss_update';
  available: boolean;
  hitPct: number | null;
  lastMissSegment: CacheMissSegment | null;
  lastMissTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  label: string;
  warn: boolean;
  warnReason?: string;
  sourceDetail?: string;
} {
  return {
    kind: 'cache_miss_update',
    available: chip.available,
    hitPct: chip.hitPct,
    lastMissSegment: chip.lastMissSegment,
    lastMissTokens: chip.lastMissTokens,
    cacheReadTokens: chip.cacheReadTokens,
    cacheCreationTokens: chip.cacheCreationTokens,
    label: chip.label,
    warn: chip.warn,
    ...(chip.warnReason ? { warnReason: chip.warnReason } : {}),
    ...(chip.sourceDetail ? { sourceDetail: chip.sourceDetail } : {})
  };
}

/** Full tooltip line matching the KP acceptance copy. */
export function formatCacheMissSummary(chip: CacheMissChip): string {
  if (!chip.available) {
    return (
      'cache: n/a — this backend did not expose cache_read / cache_creation / miss fields. ' +
      'Never invents Anthropic Cache Diagnostics for other vendors.'
    );
  }
  const hit = chip.hitPct != null ? `${chip.hitPct}%` : 'n/a';
  if (!chip.lastMissSegment) {
    return `cache: ${hit}` + (chip.sourceDetail ? ` (${chip.sourceDetail})` : '');
  }
  const tok =
    chip.lastMissTokens != null ? ` (+${formatCacheTokens(chip.lastMissTokens)} tok)` : '';
  return `cache: ${hit} | last miss: ${chip.lastMissSegment}${tok}`;
}
