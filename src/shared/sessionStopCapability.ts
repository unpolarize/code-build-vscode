/**
 * ACP session/stop force-teardown shim — capability-aware stop path.
 *
 * Registry matrix (2026-08/09): `session/stop` is supported by ~1 of 32
 * probed agents; most omit stop/close entirely. Hosts that assume a clean
 * agent-side stop leave hung children and orphaned MCP heaps. CB parents
 * the ACP process, so when initialize does not advertise stop/close we
 * must use host teardown (process kill) and never claim a protocol stop
 * was sent.
 *
 * Equivalents accepted as "agent can stop itself":
 *   - agentCapabilities.sessionCapabilities.close  → session/close (ACP)
 *   - agentCapabilities.sessionCapabilities.stop   → session/stop (extension)
 *   - top-level / _meta flags some SDKs use
 *
 * Pure and network-free: fixtures only.
 */

export type SessionStopPath = 'agent-close' | 'agent-stop' | 'host-teardown';

export interface SessionStopDecision {
  /** Which teardown path the host should take. */
  path: SessionStopPath;
  /** True when the host must kill/reap — do not claim protocol stop. */
  hostTeardown: boolean;
  /** Short chip label: `stop host` | `stop close` | `stop rpc`. */
  label: string;
  /** Human reason (tooltip / timeline). */
  reason: string;
}

/** Loose initialize payload — never throws on garbage. */
export interface InitializeStopFields {
  agentCapabilities?: {
    loadSession?: unknown;
    sessionCapabilities?: {
      close?: unknown;
      stop?: unknown;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  /** Rare draft SDKs advertise methods as a string list. */
  methods?: unknown;
  capabilities?: unknown;
  _meta?: { sessionStop?: unknown; sessionClose?: unknown; [k: string]: unknown };
}

function presentCap(v: unknown): boolean {
  // `{}` / `true` / non-null object all mean "advertised".
  if (v === true || v === 1 || v === 'true') return true;
  if (v && typeof v === 'object') return true;
  return false;
}

function methodsList(init: InitializeStopFields): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) if (typeof x === 'string') out.push(x);
    }
  };
  push(init.methods);
  const caps = init.capabilities;
  if (caps && typeof caps === 'object') {
    push((caps as { methods?: unknown }).methods);
  }
  return out.map((m) => m.toLowerCase());
}

/**
 * Decide the stop/teardown path from an ACP initialize result.
 * Missing/garbage initialize → host-teardown (safe default).
 */
export function decideSessionStopPath(
  agentInitialize: InitializeStopFields | null | undefined
): SessionStopDecision {
  if (!agentInitialize || typeof agentInitialize !== 'object') {
    return {
      path: 'host-teardown',
      hostTeardown: true,
      label: 'stop host',
      reason: 'initialize omitted agentCapabilities — host teardown (no protocol stop)'
    };
  }

  const sessionCaps = agentInitialize.agentCapabilities?.sessionCapabilities;
  const meta = agentInitialize._meta;
  const methods = methodsList(agentInitialize);

  const hasClose =
    presentCap(sessionCaps?.close) ||
    presentCap(meta?.sessionClose) ||
    methods.includes('session/close');

  const hasStop =
    presentCap(sessionCaps?.stop) ||
    presentCap(meta?.sessionStop) ||
    methods.includes('session/stop');

  if (hasClose) {
    return {
      path: 'agent-close',
      hostTeardown: false,
      label: 'stop close',
      reason: 'agent advertised sessionCapabilities.close — will send session/close'
    };
  }
  if (hasStop) {
    return {
      path: 'agent-stop',
      hostTeardown: false,
      label: 'stop rpc',
      reason: 'agent advertised session/stop — will send session/stop'
    };
  }

  return {
    path: 'host-teardown',
    hostTeardown: true,
    label: 'stop host',
    reason:
      'agent lacks session/stop and session/close — host teardown (process kill); no protocol stop claimed'
  };
}

/**
 * Best-effort kill of an ACP agent child. Prefers process-group kill when
 * the child was spawned detached (its pid is a group leader); falls back
 * to killing the single process. Never throws.
 */
export function hostKillAgentProcess(
  proc: { pid?: number | null; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals = 'SIGTERM'
): 'process-group' | 'process' | 'noop' {
  const pid = proc.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      // Negative pid = process group. Only safe when the child is a group
      // leader (spawned with detached:true). Otherwise Node/OS rejects and
      // we fall through.
      process.kill(-pid, signal);
      return 'process-group';
    } catch {
      /* not a group leader, already dead, or EPERM */
    }
    try {
      proc.kill(signal);
      return 'process';
    } catch {
      return 'noop';
    }
  }
  try {
    proc.kill(signal);
    return 'process';
  } catch {
    return 'noop';
  }
}
