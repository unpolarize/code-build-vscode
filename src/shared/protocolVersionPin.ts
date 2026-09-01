/**
 * ACP protocol-version pin — read-only handshake diagnostics for the chat
 * header chip. Host currently speaks ACP v1 only; agents that advertise v2
 * or an experimental draft get an amber warn (never block session start).
 *
 * Distinct from capability-matrix (methods/extensions) and harness-version
 * chips (CLI/model). Source of truth is the initialize result only — no
 * network registry fetch.
 */

/** Protocol version CB sends on `initialize` today. */
export const HOST_ACP_PROTOCOL_VERSION = 1;

export interface ProtocolVersionPin {
  /** Version the host advertised on initialize. */
  hostVersion: number;
  /** Version the agent returned; null when initialize omitted/invalid. */
  agentVersion: number | null;
  /** True when the agent marked the handshake as experimental / draft. */
  experimental: boolean;
  /** Short chip label, e.g. `ACP v1`, `ACP v2*`. */
  label: string;
  /** Amber warn when host/agent major or experimental flags disagree. */
  warn: boolean;
  /** Human reason for the warn (tooltip); undefined when warn is false. */
  warnReason?: string;
}

/** Loose shape of an ACP initialize result (v1 + experimental-v2 fixtures). */
export interface InitializeProtocolFields {
  protocolVersion?: unknown;
  /** Some draft SDKs nest experimental under `_meta` or top-level flags. */
  experimental?: unknown;
  protocolExperimental?: unknown;
  _meta?: { experimental?: unknown; protocolExperimental?: unknown };
}

function asPositiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return Math.floor(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n >= 1 ? n : null;
  }
  return null;
}

function truthyFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/** Detect experimental/draft signaling across known initialize shapes. */
export function isExperimentalInitialize(init: InitializeProtocolFields | null | undefined): boolean {
  if (!init || typeof init !== 'object') return false;
  if (truthyFlag(init.experimental) || truthyFlag(init.protocolExperimental)) return true;
  const meta = init._meta;
  if (meta && typeof meta === 'object') {
    if (truthyFlag(meta.experimental) || truthyFlag(meta.protocolExperimental)) return true;
  }
  return false;
}

/**
 * Build the header pin from host version + agent initialize payload.
 * Never throws — bad payloads degrade to a warn chip with null agentVersion.
 */
export function evaluateProtocolVersionPin(input: {
  hostVersion?: number;
  agentInitialize: InitializeProtocolFields | null | undefined;
}): ProtocolVersionPin {
  const hostVersion =
    typeof input.hostVersion === 'number' && Number.isFinite(input.hostVersion) && input.hostVersion >= 1
      ? Math.floor(input.hostVersion)
      : HOST_ACP_PROTOCOL_VERSION;

  const raw = input.agentInitialize;
  const agentVersion =
    raw && typeof raw === 'object' ? asPositiveInt(raw.protocolVersion) : null;
  const experimental = isExperimentalInitialize(raw ?? undefined);

  let warn = false;
  let warnReason: string | undefined;

  if (agentVersion == null) {
    warn = true;
    warnReason = 'Agent initialize omitted a usable protocolVersion — treating handshake as unknown.';
  } else if (agentVersion !== hostVersion) {
    warn = true;
    warnReason = `Host speaks ACP v${hostVersion}; agent negotiated v${agentVersion}. Mixed major versions can fail opaquely.`;
  } else if (experimental) {
    warn = true;
    warnReason = `Agent flagged experimental/draft ACP while host is stable v${hostVersion}-only.`;
  }

  const base =
    agentVersion == null ? `ACP ?` : `ACP v${agentVersion}`;
  const label = experimental ? `${base}*` : base;

  return {
    hostVersion,
    agentVersion,
    experimental,
    label,
    warn,
    ...(warnReason ? { warnReason } : {})
  };
}
