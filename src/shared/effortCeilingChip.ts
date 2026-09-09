/**
 * maxEffortLevel org/host ceiling chip — Claude Code 2.1.267 effort caps
 * across ACP backends (Bedrock/Vertex/Foundry class) plus codex-acp
 * recommended-effort advertising.
 *
 * Distinct from the vendor effort-semantics drift canary (silent label
 * remaps). This module surfaces a host-visible ceiling and gates
 * setEffort / send when the selected level is above it.
 */

export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Rank for comparison. `default` = let backend pick — never over a ceiling. */
export const EFFORT_RANK: Record<EffortLevel, number> = {
  default: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5
};

export const EFFORT_LEVELS: EffortLevel[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
];

/** Where the ceiling came from — tooltip / block copy. */
export type EffortCeilingSource = 'managed' | 'local' | 'agent-recommended';

/** Host gate when selected effort exceeds the ceiling. */
export type EffortCeilingMode = 'off' | 'warn' | 'block';

export interface EffortCeilingChip {
  /** False when no ceiling is known — chip hidden / n/a. */
  available: boolean;
  /** Cap level; null when unavailable. */
  ceiling: EffortLevel | null;
  /** Currently selected session effort (may be null before session meta). */
  selected: EffortLevel | null;
  source: EffortCeilingSource | null;
  /** Human pointer to the setting / agent field that supplied the ceiling. */
  sourceDetail?: string;
  /** Short chip label, e.g. `ceil high · local`, `ceil med · managed`. */
  label: string;
  /** Amber when selected rank > ceiling rank. */
  warn: boolean;
  warnReason?: string;
}

export interface EffortCeilingGate {
  action: 'allow' | 'warn' | 'block';
  /** Notice / tooltip copy when action is warn or block. */
  message?: string;
  ceiling: EffortLevel | null;
  source: EffortCeilingSource | null;
  sourceDetail?: string;
}

/** Loose Claude settings / ACP initialize / host-config shapes. */
export interface EffortCeilingFields {
  maxEffortLevel?: unknown;
  max_effort_level?: unknown;
  modelSettings?: unknown;
  model_settings?: unknown;
  /** codex-acp 1.11.0-class recommended model + reasoning effort. */
  recommended?: unknown;
  recommendedEffort?: unknown;
  recommended_effort?: unknown;
  _meta?: {
    maxEffortLevel?: unknown;
    max_effort_level?: unknown;
    recommendedEffort?: unknown;
    recommended_effort?: unknown;
    recommended?: unknown;
    modelSettings?: unknown;
  };
}

export interface EffortCeilingSourceHit {
  ceiling: EffortLevel;
  source: EffortCeilingSource;
  sourceDetail: string;
}

function asEffortLevel(v: unknown): EffortLevel | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if ((EFFORT_LEVELS as string[]).includes(s)) return s as EffortLevel;
  // Common aliases from Claude / Codex docs.
  if (s === 'xlarge' || s === 'extra-high' || s === 'extra_high') return 'xhigh';
  if (s === 'highest' || s === 'ultra') return 'max';
  return null;
}

/** Compare two effort levels by rank. Negative if a < b. */
export function compareEffort(a: EffortLevel, b: EffortLevel): number {
  return EFFORT_RANK[a] - EFFORT_RANK[b];
}

/** True when selected is strictly above the ceiling (default never is). */
export function isEffortAboveCeiling(
  selected: EffortLevel | null | undefined,
  ceiling: EffortLevel | null | undefined
): boolean {
  if (!selected || !ceiling) return false;
  if (selected === 'default') return false;
  return compareEffort(selected, ceiling) > 0;
}

function shortSource(source: EffortCeilingSource): string {
  if (source === 'managed') return 'managed';
  if (source === 'agent-recommended') return 'rec';
  return 'local';
}

function shortCeiling(ceiling: EffortLevel): string {
  if (ceiling === 'medium') return 'med';
  if (ceiling === 'xhigh') return 'xhi';
  return ceiling;
}

function pickFromModelSettings(
  modelSettings: unknown,
  modelId: string | null | undefined
): EffortLevel | null {
  if (!modelSettings || typeof modelSettings !== 'object') return null;
  const map = modelSettings as Record<string, unknown>;
  if (modelId && map[modelId] && typeof map[modelId] === 'object') {
    const row = map[modelId] as Record<string, unknown>;
    const hit = asEffortLevel(row.maxEffortLevel ?? row.max_effort_level);
    if (hit) return hit;
  }
  // Fallback: first per-model maxEffortLevel if only one model entry.
  const entries = Object.values(map).filter((v) => v && typeof v === 'object');
  if (entries.length === 1) {
    const row = entries[0] as Record<string, unknown>;
    return asEffortLevel(row.maxEffortLevel ?? row.max_effort_level);
  }
  return null;
}

function pickRecommended(raw: unknown): EffortLevel | null {
  if (!raw) return null;
  if (typeof raw === 'string') return asEffortLevel(raw);
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return asEffortLevel(
      o.effort ?? o.reasoningEffort ?? o.reasoning_effort ?? o.maxEffortLevel
    );
  }
  return null;
}

/**
 * Parse a Claude 2.1.267-class maxEffortLevel (top-level or per-model under
 * modelSettings) or a codex-acp recommended-effort advertise.
 * Prefer managed maxEffortLevel over recommended.
 */
export function parseEffortCeilingFromAgent(
  fields: EffortCeilingFields | null | undefined,
  opts?: { modelId?: string | null }
): EffortCeilingSourceHit | null {
  if (!fields || typeof fields !== 'object') return null;

  const top = asEffortLevel(fields.maxEffortLevel ?? fields.max_effort_level);
  if (top) {
    return {
      ceiling: top,
      source: 'managed',
      sourceDetail: 'agent maxEffortLevel (Claude 2.1.267 class)'
    };
  }

  const fromModels = pickFromModelSettings(
    fields.modelSettings ?? fields.model_settings,
    opts?.modelId
  );
  if (fromModels) {
    return {
      ceiling: fromModels,
      source: 'managed',
      sourceDetail: 'agent modelSettings.maxEffortLevel'
    };
  }

  const meta = fields._meta;
  if (meta && typeof meta === 'object') {
    const metaTop = asEffortLevel(meta.maxEffortLevel ?? meta.max_effort_level);
    if (metaTop) {
      return {
        ceiling: metaTop,
        source: 'managed',
        sourceDetail: 'agent _meta.maxEffortLevel'
      };
    }
    const metaModels = pickFromModelSettings(meta.modelSettings, opts?.modelId);
    if (metaModels) {
      return {
        ceiling: metaModels,
        source: 'managed',
        sourceDetail: 'agent _meta.modelSettings.maxEffortLevel'
      };
    }
    const metaRec = pickRecommended(
      meta.recommendedEffort ?? meta.recommended_effort ?? meta.recommended
    );
    if (metaRec) {
      return {
        ceiling: metaRec,
        source: 'agent-recommended',
        sourceDetail: 'agent _meta.recommendedEffort (codex-acp class)'
      };
    }
  }

  const rec = pickRecommended(
    fields.recommendedEffort ?? fields.recommended_effort ?? fields.recommended
  );
  if (rec) {
    return {
      ceiling: rec,
      source: 'agent-recommended',
      sourceDetail: 'agent recommended effort (codex-acp 1.11.0 class)'
    };
  }

  return null;
}

/** Host setting `codeBuild.maxEffortLevel` — empty / default / unset → null. */
export function parseHostMaxEffortLevel(raw: unknown): EffortCeilingSourceHit | null {
  if (raw == null || raw === '' || raw === 'none' || raw === 'off') return null;
  const level = asEffortLevel(raw);
  if (!level || level === 'default') return null;
  return {
    ceiling: level,
    source: 'local',
    sourceDetail: 'codeBuild.maxEffortLevel'
  };
}

/**
 * Resolve the effective ceiling. Host local setting wins over agent-reported
 * managed / recommended (explicit CB pin). Among agent sources, managed
 * maxEffortLevel beats recommended.
 */
export function resolveEffortCeiling(input: {
  hostMaxEffortLevel?: unknown;
  agentFields?: EffortCeilingFields | null;
  modelId?: string | null;
}): EffortCeilingSourceHit | null {
  const host = parseHostMaxEffortLevel(input.hostMaxEffortLevel);
  if (host) return host;
  return parseEffortCeilingFromAgent(input.agentFields, { modelId: input.modelId });
}

/**
 * Build the header chip. Never throws — missing ceiling → available:false.
 */
export function evaluateEffortCeilingChip(input: {
  hostMaxEffortLevel?: unknown;
  agentFields?: EffortCeilingFields | null;
  modelId?: string | null;
  selected?: EffortLevel | null;
}): EffortCeilingChip {
  const hit = resolveEffortCeiling({
    hostMaxEffortLevel: input.hostMaxEffortLevel,
    agentFields: input.agentFields,
    modelId: input.modelId
  });
  const selected = input.selected ?? null;

  if (!hit) {
    return {
      available: false,
      ceiling: null,
      selected,
      source: null,
      label: 'ceil n/a',
      warn: false
    };
  }

  const over = isEffortAboveCeiling(selected, hit.ceiling);
  const label = `ceil ${shortCeiling(hit.ceiling)} · ${shortSource(hit.source)}`;
  let warnReason: string | undefined;
  if (over && selected) {
    warnReason =
      `Selected effort "${selected}" is above the ${hit.source} ceiling ` +
      `"${hit.ceiling}" (${hit.sourceDetail}).`;
  }

  return {
    available: true,
    ceiling: hit.ceiling,
    selected,
    source: hit.source,
    sourceDetail: hit.sourceDetail,
    label,
    warn: over,
    ...(warnReason ? { warnReason } : {})
  };
}

/**
 * Pre-send / setEffort gate. `mode: off` always allows (chip still useful).
 * `default` selected never blocks.
 */
export function checkEffortAgainstCeiling(input: {
  selected: EffortLevel | null | undefined;
  hostMaxEffortLevel?: unknown;
  agentFields?: EffortCeilingFields | null;
  modelId?: string | null;
  mode?: EffortCeilingMode | null;
}): EffortCeilingGate {
  const mode: EffortCeilingMode =
    input.mode === 'block' || input.mode === 'off' || input.mode === 'warn'
      ? input.mode
      : 'warn';

  const hit = resolveEffortCeiling({
    hostMaxEffortLevel: input.hostMaxEffortLevel,
    agentFields: input.agentFields,
    modelId: input.modelId
  });

  if (!hit || mode === 'off' || !isEffortAboveCeiling(input.selected, hit.ceiling)) {
    return {
      action: 'allow',
      ceiling: hit?.ceiling ?? null,
      source: hit?.source ?? null,
      ...(hit?.sourceDetail ? { sourceDetail: hit.sourceDetail } : {})
    };
  }

  const selected = input.selected as EffortLevel;
  const message =
    `Effort "${selected}" exceeds the ${hit.source} ceiling "${hit.ceiling}" ` +
    `(${hit.sourceDetail}). ` +
    (mode === 'block'
      ? 'Send blocked — lower effort or raise/clear the ceiling.'
      : 'Proceeding with a warning — lower effort or raise/clear the ceiling.');

  return {
    action: mode === 'block' ? 'block' : 'warn',
    message,
    ceiling: hit.ceiling,
    source: hit.source,
    sourceDetail: hit.sourceDetail
  };
}

/** Normalize a VS Code setting string into EffortCeilingMode. */
export function parseEffortCeilingMode(raw: unknown): EffortCeilingMode {
  if (raw === 'block' || raw === 'off' || raw === 'warn') return raw;
  return 'warn';
}
