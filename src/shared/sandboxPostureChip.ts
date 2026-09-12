/**
 * Restricted / sandbox posture matrix chip — translate vendor-specific
 * `--restricted` / sandbox / network / tool-deny signals into a shared
 * vocabulary (shell, network, files, creds) across ACP backends.
 *
 * Claude 2.1.248 class (`--restricted` / CLAUDE_CODE_RESTRICTED=1: no
 * shell/code runners, file tools cwd-bound). Codex defaults OS sandbox
 * + network-off. Surface only — never changes enforcement.
 *
 * Unknown dimensions stay `unknown` (amber chip), never silent green.
 */

export type ShellPosture = 'off' | 'on' | 'unknown';
export type NetworkPosture = 'off' | 'on' | 'allowlist' | 'unknown';
export type FilesPosture = 'cwd' | 'workspace' | 'unrestricted' | 'unknown';
export type CredsPosture = 'blocked' | 'allowed' | 'unknown';

export type SandboxSignalSource = 'spawn-args' | 'env' | 'initialize';

export interface SandboxPostureSignal {
  key: string;
  value: string;
  source: SandboxSignalSource;
}

export interface SandboxPostureChip {
  available: boolean;
  shell: ShellPosture;
  network: NetworkPosture;
  files: FilesPosture;
  creds: CredsPosture;
  /** Short chip, e.g. `posture sh× cwd ?`, `posture ?`. */
  label: string;
  /** Amber when any dimension is unknown, restricted, or in conflict. */
  warn: boolean;
  warnReason?: string;
  signals: SandboxPostureSignal[];
  conflict?: boolean;
  conflictDetail?: string;
}

export interface SandboxPostureSession {
  sessionId: string;
  cwd: string;
  backend?: string;
  chip: SandboxPostureChip;
}

export interface SandboxPostureConflict {
  cwd: string;
  sessionIds: string[];
  backends: string[];
  reasons: string[];
}

/** Loose ACP initialize / config shapes — never throws on garbage. */
export interface SandboxInitializeFields {
  restricted?: unknown;
  isRestricted?: unknown;
  sandbox?: unknown;
  sandboxMode?: unknown;
  sandbox_mode?: unknown;
  network?: unknown;
  networkAccess?: unknown;
  network_access?: unknown;
  credentials?: unknown;
  creds?: unknown;
  agentCapabilities?: {
    restricted?: unknown;
    sandbox?: unknown;
    [k: string]: unknown;
  };
  _meta?: {
    restricted?: unknown;
    sandbox?: unknown;
    sandboxMode?: unknown;
    sandbox_mode?: unknown;
    network?: unknown;
    networkAccess?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function truthyFlag(v: unknown): boolean | null {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off' || s === '') return false;
  return null;
}

function argHasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('-')) return null;
  return next;
}

function pushSignal(
  signals: SandboxPostureSignal[],
  source: SandboxSignalSource,
  key: string,
  value: string
): void {
  signals.push({ source, key, value });
}

function applyRestricted(
  chip: Pick<SandboxPostureChip, 'shell' | 'files'>,
  signals: SandboxPostureSignal[],
  source: SandboxSignalSource,
  key: string,
  value: string
): void {
  chip.shell = 'off';
  chip.files = 'cwd';
  pushSignal(signals, source, key, value);
}

function mapSandboxMode(
  raw: string,
  backend?: string
): Partial<Pick<SandboxPostureChip, 'shell' | 'network' | 'files'>> {
  const s = raw.trim().toLowerCase().replace(/_/g, '-');
  if (
    s === 'restricted' ||
    s === 'cwd' ||
    s === 'cwd-bound' ||
    (backend === 'claude' && (s === 'read-only' || s === 'readonly'))
  ) {
    return { shell: 'off', files: 'cwd' };
  }
  if (s === 'read-only' || s === 'readonly' || s === 'read-only-access') {
    return { shell: 'on', network: 'off', files: 'workspace' };
  }
  if (s === 'workspace-write' || s === 'workspace' || s === 'workspace-write-access') {
    return { shell: 'on', network: 'off', files: 'workspace' };
  }
  if (
    s === 'danger-full-access' ||
    s === 'full-access' ||
    s === 'unrestricted' ||
    s === 'danger-full'
  ) {
    return { shell: 'on', network: 'on', files: 'unrestricted' };
  }
  return {};
}

function parseNetwork(raw: unknown): NetworkPosture | null {
  if (typeof raw === 'boolean') return raw ? 'on' : 'off';
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (s === 'off' || s === 'none' || s === 'disabled' || s === 'false' || s === '0') return 'off';
  if (s === 'on' || s === 'full' || s === 'enabled' || s === 'true' || s === '1') return 'on';
  if (s === 'allowlist' || s === 'restricted' || s === 'limited') return 'allowlist';
  return null;
}

function parseFiles(raw: unknown): FilesPosture | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/_/g, '-');
  if (s === 'cwd' || s === 'cwd-bound' || s === 'restricted') return 'cwd';
  if (s === 'workspace' || s === 'workspace-write' || s === 'read-only') return 'workspace';
  if (s === 'unrestricted' || s === 'danger-full-access' || s === 'full') return 'unrestricted';
  return null;
}

function parseCreds(raw: unknown): CredsPosture | null {
  const flag = truthyFlag(raw);
  if (flag === true) return 'allowed';
  if (flag === false) return 'blocked';
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'blocked' || s === 'deny' || s === 'denied') return 'blocked';
    if (s === 'allowed' || s === 'allow' || s === 'permitted') return 'allowed';
  }
  return null;
}

function applyObjectSandbox(
  obj: Record<string, unknown>,
  chip: Pick<SandboxPostureChip, 'shell' | 'network' | 'files' | 'creds'>,
  signals: SandboxPostureSignal[],
  source: SandboxSignalSource,
  prefix: string,
  backend?: string
): void {
  const modeRaw = obj.mode ?? obj.sandboxMode ?? obj.sandbox_mode ?? obj.policy;
  if (typeof modeRaw === 'string' && modeRaw.trim()) {
    const mapped = mapSandboxMode(modeRaw, backend);
    if (mapped.shell) chip.shell = mapped.shell;
    if (mapped.network) chip.network = mapped.network;
    if (mapped.files) chip.files = mapped.files;
    pushSignal(signals, source, prefix + '.mode', modeRaw);
  }
  const net = parseNetwork(obj.network ?? obj.networkAccess ?? obj.network_access);
  if (net) {
    chip.network = net;
    pushSignal(signals, source, prefix + '.network', net);
  }
  const files = parseFiles(obj.files ?? obj.filesystem ?? obj.fs ?? obj.fileAccess);
  if (files) {
    chip.files = files;
    pushSignal(signals, source, prefix + '.files', files);
  }
  const shellFlag = truthyFlag(obj.shell ?? obj.bash ?? obj.codeRunners);
  if (shellFlag === false) {
    chip.shell = 'off';
    pushSignal(signals, source, prefix + '.shell', 'off');
  } else if (shellFlag === true) {
    chip.shell = 'on';
    pushSignal(signals, source, prefix + '.shell', 'on');
  }
  const creds = parseCreds(obj.credentials ?? obj.creds ?? obj.allowCredentials);
  if (creds) {
    chip.creds = creds;
    pushSignal(signals, source, prefix + '.creds', creds);
  }
}

function parseInitialize(
  raw: unknown,
  chip: Pick<SandboxPostureChip, 'shell' | 'network' | 'files' | 'creds'>,
  signals: SandboxPostureSignal[],
  backend?: string
): void {
  const fields = asRecord(raw) as SandboxInitializeFields | null;
  if (!fields) return;

  const restricted =
    truthyFlag(fields.restricted) ??
    truthyFlag(fields.isRestricted) ??
    truthyFlag(fields.agentCapabilities?.restricted) ??
    truthyFlag(fields._meta?.restricted);
  if (restricted === true) {
    applyRestricted(chip, signals, 'initialize', 'restricted', 'true');
  }

  const sandboxRaw =
    fields.sandbox ??
    fields.sandboxMode ??
    fields.sandbox_mode ??
    fields.agentCapabilities?.sandbox ??
    fields._meta?.sandbox ??
    fields._meta?.sandboxMode ??
    fields._meta?.sandbox_mode;
  if (typeof sandboxRaw === 'string' && sandboxRaw.trim()) {
    const mapped = mapSandboxMode(sandboxRaw, backend);
    if (mapped.shell) chip.shell = mapped.shell;
    if (mapped.network) chip.network = mapped.network;
    if (mapped.files) chip.files = mapped.files;
    pushSignal(signals, 'initialize', 'sandbox', sandboxRaw);
  } else {
    const obj = asRecord(sandboxRaw);
    if (obj) applyObjectSandbox(obj, chip, signals, 'initialize', 'sandbox', backend);
  }

  const net = parseNetwork(
    fields.network ??
      fields.networkAccess ??
      fields.network_access ??
      fields._meta?.network ??
      fields._meta?.networkAccess
  );
  if (net) {
    chip.network = net;
    pushSignal(signals, 'initialize', 'network', net);
  }

  const creds = parseCreds(fields.credentials ?? fields.creds);
  if (creds) {
    chip.creds = creds;
    pushSignal(signals, 'initialize', 'creds', creds);
  }
}

function shortLabel(chip: Pick<SandboxPostureChip, 'shell' | 'network' | 'files' | 'creds'>): {
  parts: string[];
  unknown: boolean;
} {
  const parts: string[] = [];
  let unknown = false;
  if (chip.shell === 'off') parts.push('sh×');
  else if (chip.shell === 'on') parts.push('sh');
  else unknown = true;
  if (chip.network === 'off') parts.push('net×');
  else if (chip.network === 'on') parts.push('net');
  else if (chip.network === 'allowlist') parts.push('net~');
  else unknown = true;
  if (chip.files === 'cwd') parts.push('cwd');
  else if (chip.files === 'workspace') parts.push('ws');
  else if (chip.files === 'unrestricted') parts.push('uns');
  else unknown = true;
  if (chip.creds === 'blocked') parts.push('creds×');
  else if (chip.creds === 'allowed') parts.push('creds');
  else unknown = true;
  return { parts, unknown };
}

/**
 * Map spawn argv + env + ACP initialize into posture badges.
 * Missing/garbage input → all `unknown` (amber), never silent green.
 */
export function evaluateSandboxPosture(input?: {
  backend?: string | null;
  spawnArgs?: string[] | null;
  env?: Record<string, string | undefined> | null;
  agentInitialize?: unknown;
  conflict?: SandboxPostureConflict | null;
} | null): SandboxPostureChip {
  const src = input && typeof input === 'object' ? input : {};
  const backend = src.backend ?? undefined;
  const args = Array.isArray(src.spawnArgs) ? src.spawnArgs : [];
  const env = src.env ?? {};
  const signals: SandboxPostureSignal[] = [];
  const dims: Pick<SandboxPostureChip, 'shell' | 'network' | 'files' | 'creds'> = {
    shell: 'unknown',
    network: 'unknown',
    files: 'unknown',
    creds: 'unknown'
  };

  if (argHasFlag(args, '--restricted')) {
    applyRestricted(dims, signals, 'spawn-args', '--restricted', 'true');
  }
  const envRestricted = truthyFlag(env.CLAUDE_CODE_RESTRICTED);
  if (envRestricted === true) {
    applyRestricted(dims, signals, 'env', 'CLAUDE_CODE_RESTRICTED', String(env.CLAUDE_CODE_RESTRICTED));
  }

  const sandboxArg = argValue(args, '--sandbox') ?? argValue(args, '-s');
  if (sandboxArg) {
    const mapped = mapSandboxMode(sandboxArg, backend);
    if (mapped.shell) dims.shell = mapped.shell;
    if (mapped.network) dims.network = mapped.network;
    if (mapped.files) dims.files = mapped.files;
    pushSignal(signals, 'spawn-args', '--sandbox', sandboxArg);
  }

  if (argHasFlag(args, '--add-dir') && dims.files === 'unknown') {
    dims.files = 'workspace';
    pushSignal(signals, 'spawn-args', '--add-dir', 'present');
  }

  parseInitialize(src.agentInitialize, dims, signals, backend);

  const { parts, unknown } = shortLabel(dims);
  const restricted = dims.shell === 'off' || dims.files === 'cwd';
  const conflict = src.conflict ?? null;
  const warn = unknown || restricted || !!conflict;

  let warnReason: string | undefined;
  if (conflict) {
    warnReason =
      `Conflicting sandbox posture on ${conflict.cwd}: ` +
      conflict.reasons.join('; ') +
      ` (sessions ${conflict.sessionIds.join(', ')}).`;
  } else if (restricted && unknown) {
    warnReason =
      'Restricted/cwd-bound posture detected; other dimensions unknown — not assumed open.';
  } else if (unknown) {
    warnReason =
      'One or more posture dimensions unknown (vendor did not declare them). Not assumed open.';
  } else if (restricted) {
    warnReason = 'Restricted posture: shell off and/or file tools cwd-bound.';
  }

  const label = parts.length === 0 ? 'posture ?' : `posture ${parts.join(' ')}${unknown ? ' ?' : ''}`;

  return {
    available: true,
    shell: dims.shell,
    network: dims.network,
    files: dims.files,
    creds: dims.creds,
    label,
    warn,
    ...(warnReason ? { warnReason } : {}),
    signals,
    ...(conflict
      ? { conflict: true, conflictDetail: warnReason }
      : {})
  };
}

/** Tooltip: badges + raw vendor signals. */
export function formatSandboxPostureTooltip(chip: SandboxPostureChip): string {
  const lines = [
    chip.label,
    `shell: ${chip.shell} · network: ${chip.network} · files: ${chip.files} · creds: ${chip.creds}`
  ];
  if (chip.warnReason) lines.push(chip.warnReason);
  if (chip.signals.length > 0) {
    lines.push('Signals:');
    for (const s of chip.signals) {
      lines.push(`  ${s.source} ${s.key}=${s.value}`);
    }
  } else {
    lines.push('Signals: (none — unknown, not assumed open)');
  }
  lines.push('Read-only surface — does not change sandbox enforcement.');
  lines.push('Click for the full vendor-signal panel.');
  return lines.join('\n');
}

/** Click-through panel copy listing every raw signal used. */
export function formatSandboxPostureDetail(chip: SandboxPostureChip): string {
  const lines = [
    'Sandbox posture (read-only)',
    `shell: ${chip.shell}`,
    `network: ${chip.network}`,
    `files: ${chip.files}`,
    `creds: ${chip.creds}`,
    ''
  ];
  if (chip.signals.length === 0) {
    lines.push('No vendor signals declared. Badges stay unknown — never silent green.');
  } else {
    lines.push('Raw vendor signals:');
    for (const s of chip.signals) {
      lines.push(`- [${s.source}] ${s.key} = ${s.value}`);
    }
  }
  if (chip.conflictDetail) {
    lines.push('');
    lines.push(chip.conflictDetail);
  }
  return lines.join('\n');
}

export function postureSignature(chip: SandboxPostureChip): string {
  return [
    chip.label,
    chip.warn ? '1' : '0',
    chip.shell,
    chip.network,
    chip.files,
    chip.creds,
    chip.conflict ? 'c' : '',
    chip.signals.map((s) => `${s.source}:${s.key}=${s.value}`).join(',')
  ].join('|');
}

function knownDiff(
  a: string,
  b: string
): boolean {
  return a !== 'unknown' && b !== 'unknown' && a !== b;
}

/** Same-cwd sessions whose known dimensions disagree. Unknown never conflicts. */
export function findPostureConflicts(
  sessions: SandboxPostureSession[],
  focusSessionId?: string
): SandboxPostureConflict[] {
  const byCwd = new Map<string, SandboxPostureSession[]>();
  for (const s of sessions) {
    const cwd = s.cwd || '';
    if (!cwd) continue;
    const list = byCwd.get(cwd) ?? [];
    list.push(s);
    byCwd.set(cwd, list);
  }
  const out: SandboxPostureConflict[] = [];
  for (const [cwd, group] of byCwd) {
    if (group.length < 2) continue;
    if (focusSessionId && !group.some((g) => g.sessionId === focusSessionId)) continue;
    const reasons: string[] = [];
    const dims: Array<keyof Pick<SandboxPostureChip, 'shell' | 'network' | 'files' | 'creds'>> = [
      'shell',
      'network',
      'files',
      'creds'
    ];
    for (const dim of dims) {
      const known = group.map((g) => g.chip[dim]).filter((v) => v !== 'unknown');
      const uniq = [...new Set(known)];
      if (uniq.length > 1) {
        reasons.push(
          `${dim}: ` +
            group
              .filter((g) => g.chip[dim] !== 'unknown')
              .map((g) => `${g.backend ?? g.sessionId}=${g.chip[dim]}`)
              .join(' vs ')
        );
      }
    }
    if (reasons.length === 0) continue;
    // Drop groups that only differ because of a single session vs itself.
    const disagree = group.filter((g, i) =>
      group.some((h, j) => i !== j && dims.some((d) => knownDiff(g.chip[d], h.chip[d])))
    );
    if (disagree.length < 2) continue;
    out.push({
      cwd,
      sessionIds: group.map((g) => g.sessionId),
      backends: group.map((g) => g.backend).filter((b): b is string => !!b),
      reasons
    });
  }
  return out;
}

/**
 * Process-level registry so concurrent CB panels on the same repo can
 * warn when their sandbox postures disagree.
 */
export class SandboxPostureHub {
  private sessions = new Map<string, SandboxPostureSession>();

  register(session: SandboxPostureSession): SandboxPostureConflict | null {
    this.sessions.set(session.sessionId, session);
    return this.conflictFor(session.sessionId);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  conflictFor(sessionId: string): SandboxPostureConflict | null {
    const hit = this.sessions.get(sessionId);
    if (!hit) return null;
    return findPostureConflicts([...this.sessions.values()], sessionId)[0] ?? null;
  }

  list(): SandboxPostureSession[] {
    return [...this.sessions.values()];
  }
}

let defaultHub: SandboxPostureHub | undefined;

export function getSandboxPostureHub(): SandboxPostureHub {
  if (!defaultHub) defaultHub = new SandboxPostureHub();
  return defaultHub;
}

/** Test hook — never call from production paths. */
export function resetSandboxPostureHubForTests(): void {
  defaultHub = new SandboxPostureHub();
}

export function toSandboxPostureUpdate(chip: SandboxPostureChip): {
  kind: 'sandbox_posture_update';
  available: boolean;
  shell: ShellPosture;
  network: NetworkPosture;
  files: FilesPosture;
  creds: CredsPosture;
  label: string;
  warn: boolean;
  warnReason?: string;
  signals: SandboxPostureSignal[];
  conflict?: boolean;
  conflictDetail?: string;
} {
  return {
    kind: 'sandbox_posture_update',
    available: chip.available,
    shell: chip.shell,
    network: chip.network,
    files: chip.files,
    creds: chip.creds,
    label: chip.label,
    warn: chip.warn,
    signals: chip.signals,
    ...(chip.warnReason ? { warnReason: chip.warnReason } : {}),
    ...(chip.conflict ? { conflict: true } : {}),
    ...(chip.conflictDetail ? { conflictDetail: chip.conflictDetail } : {})
  };
}
