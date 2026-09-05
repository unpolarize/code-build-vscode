import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  BackendId,
  ContentBlock,
  PermissionMode,
  PermissionOutcome
} from '../../shared/acpTypes';
import { BaseAgentSession, type StartOpts } from '../agentSession';
import { BACKENDS, resolveBin } from '../backendRegistry';
import { JsonRpcEndpoint } from './acp/jsonRpc';
import { normalizeAcpUpdate } from './normalizers/acp';
import { classifyBackendError } from '../../shared/backendErrorClass';
import { acpIdForPermissionMode, permissionModeFromAcpId } from '../../shared/permissionModes';
import { settleAcpProcessExit } from './acpProcessExit';
import { buildPermissionToolCall, PendingPermissionResolvers } from './permissionRequest';
import { createPathGuard, type PathGuard } from '../pathGuard';
import {
  appendKpMcpServer,
  resolveAcpMcpServersFromInspect,
  type AcpMcpServer
} from './mcpServers';
import {
  applyMcpSchemaBudget,
  toAcpMcpPayload
} from './mcpSchemaBudget';
import {
  buildAskUserQuestionAccepted,
  buildAskUserQuestionCancelled,
  isAskUserQuestionMethod,
  parseAskUserQuestionParams
} from './askUserQuestion';
import {
  evaluateProtocolVersionPin,
  HOST_ACP_PROTOCOL_VERSION
} from '../../shared/protocolVersionPin';
import { evaluateSpendLimitChip } from '../../shared/spendLimitChip';

export type { AcpMcpServer };

function updateHasRateLimits(update: Record<string, unknown>): boolean {
  if (update.rate_limits != null || update.rateLimits != null) return true;
  const meta = update._meta;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (m.rate_limits != null || m.rateLimits != null) return true;
  }
  return false;
}
export { DEFAULT_BROWSER_MCP_SERVERS } from './mcpServers';

let mcpOutput: vscode.OutputChannel | undefined;
function getMcpOutput(): vscode.OutputChannel {
  if (!mcpOutput) {
    mcpOutput = vscode.window.createOutputChannel('Code Build: MCP');
  }
  return mcpOutput;
}

interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: { loadSession?: boolean };
}
/** `modes` object on the ACP session/new | session/load RESPONSE. There is
 * no available_modes_update event — this response is the only inventory. */
interface SessionModes {
  currentModeId: string;
  availableModes?: { id: string; name?: string; description?: string }[];
}
interface NewSessionResult {
  sessionId: string;
  modes?: SessionModes;
}
interface PromptResult {
  stopReason: string;
}

/**
 * Resolve MCP servers to pass on ACP session/new.
 *
 * Unset `codeBuild.mcpServers` → personal-browser defaults (chrome-devtools +
 * playwright). Explicit `[]` or `codeBuild.disableDefaultMcpServers: true` →
 * no servers (no npx default spawns). Populated array → as configured.
 * Uses `inspect` because package.json default is `[]` and `get()` cannot
 * distinguish unset from explicit empty.
 *
 * After kp append, applies `codeBuild.mcpSchemaTokenBudget` knapsack (PR1
 * static table). budget 0/unset → identity. Host-only `schemaTokens` fields
 * are stripped before the ACP payload.
 */
export function resolveAcpMcpServers(kpContext?: {
  backend: BackendId;
  model: string | undefined;
  sessionId: string;
  /** Force-enable KP MCP (e.g. Voice Ideation Session) even when setting is off. */
  forceKp?: boolean;
}): AcpMcpServer[] {
  const cfg = vscode.workspace.getConfiguration('codeBuild');
  const base = resolveAcpMcpServersFromInspect(
    cfg.inspect('mcpServers'),
    cfg.get<boolean>('disableDefaultMcpServers') === true
  );
  let servers = base;
  if (kpContext) {
    const enabled =
      kpContext.forceKp === true || cfg.get<boolean>('kpMcp.enabled') === true;
    const { servers: withKp, skip } = appendKpMcpServer(base, {
      enabled,
      command: cfg.get<string>('kp.command'),
      root: cfg.get<string>('kp.root'),
      backend: kpContext.backend,
      model: kpContext.model,
      sessionId: kpContext.sessionId
    });
    if (skip === 'missing-command' || skip === 'missing-root') {
      // Fail-open: the session still starts, just without kp tools.
      console.warn(
        `[code-build] KP MCP requested (enabled=${enabled}, force=${Boolean(
          kpContext.forceKp
        )}) but codeBuild.kp.${
          skip === 'missing-command' ? 'command' : 'root'
        } is not set — skipping kp MCP injection`
      );
    }
    servers = withKp;
  }

  const budgetRaw = cfg.get<number>('mcpSchemaTokenBudget');
  const budget =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : 0;
  const priorityRaw = cfg.get<unknown>('mcpPriority');
  const priority = Array.isArray(priorityRaw)
    ? priorityRaw.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];

  try {
    const result = applyMcpSchemaBudget(servers, { budget, priority });
    if (budget > 0) {
      const ch = getMcpOutput();
      ch.appendLine(result.logLine);
      for (const w of result.warnings) ch.appendLine(w);
    }
    return toAcpMcpPayload(result.included);
  } catch (err) {
    // Fail-open: malformed budget path never blocks session start.
    console.warn(
      `[code-build] MCP schema budget failed — using unfiltered list: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return toAcpMcpPayload(servers);
  }
}

/**
 * Drives ACP agents (Grok, opencode, Cline) over newline-delimited JSON-RPC on
 * the agent's stdio. Normalizes `session/update` notifications into SessionUpdates
 * and bridges agent->client requests (fs, permission) back to the editor/UI.
 */
export class AcpTransport extends BaseAgentSession {
  private proc?: ChildProcessWithoutNullStreams;
  private rpc?: JsonRpcEndpoint;
  private acpSessionId?: string;
  private startOpts?: StartOpts;
  private mode: PermissionMode = 'default';
  /** Mode ids advertised on session/new|load `modes.availableModes`, when
   * present. setMode validates against this so an unsupported selection
   * fails fast (and the caller reverts) instead of a wire round-trip. */
  private availableModeIds?: string[];
  private pendingPermissions = new PendingPermissionResolvers();
  /** In-flight Grok `_x.ai/ask_user_question` RPC resolvers, keyed by toolCallId. */
  private pendingAskUser = new Map<string, (value: unknown) => void>();
  /** Resolves when initialize + session/new have completed (or rejects on
   * any failure). prompt() awaits this so the user can hit Send while the
   * ACP handshake is still in flight — the prompt is queued instead of
   * failing with the cryptic "ACP session not started". */
  private readyPromise?: Promise<void>;
  /** Captured stderr while spawn + handshake are in progress; surfaced in
   * the error bubble if the handshake fails so the user sees what went
   * wrong instead of a generic timeout. */
  private startupStderr = '';
  /** Cached realpath-based path guard for the non-bypass fs/* bridge.
   * Built once per start() when cwd is known; root is realpathed at init. */
  private pathGuard?: PathGuard;
  /** `startOpts.cwd` string the cached guard was built for. */
  private pathGuardCwd?: string;
  /** True once the process exit path (or dispose) has settled pending
   * RPC + permissions. Prevents double-settle when dispose() kills the
   * child and the exit handler also fires; also lets prompt() swallow
   * the "endpoint disposed" rejection after a mid-turn exit. */
  private exitSettled = false;

  constructor(
    public readonly id: string,
    public readonly backend: BackendId,
    private readonly binOverrides: Record<string, string>
  ) {
    super();
  }

  async start(opts: StartOpts): Promise<void> {
    this.startOpts = opts;
    this.mode = opts.mode;
    // Drop any prior guard so a restarted session re-realpaths the new cwd.
    this.pathGuard = undefined;
    this.pathGuardCwd = undefined;
    this.exitSettled = false;
    const spec = BACKENDS[this.backend];
    const bin = resolveBin(spec, this.binOverrides);
    const args = spec.buildArgs({
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      effort: opts.effort,
      allowBypass: opts.allowBypass
    });

    this.proc = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (err) =>
      this.emit({ kind: 'error', message: `Failed to start ${bin}: ${err.message}` })
    );
    // Mid-turn exit (daemon crash/OOM/kill) must settle pending RPC and
    // permission prompts and emit a synthetic result — otherwise the
    // webview spinner sticks forever. See settleAcpProcessExit.
    this.proc.on('exit', (code, signal) => {
      this.handleProcessExit(code, signal ?? null, bin);
    });
    this.proc.stderr.on('data', (b: Buffer) => {
      const t = b.toString();
      if (t.trim()) console.error(`[code-build:${this.backend}] ${t.trim()}`);
      // Keep a rolling tail so the exit/handshake handler can include it.
      if (this.startupStderr.length < 8192) this.startupStderr += t;
    });

    this.rpc = new JsonRpcEndpoint(this.proc.stdin, this.proc.stdout);
    this.rpc.onNotification((method, params) => this.onNotification(method, params));
    this.rpc.onRequest((method, params) => this.onRequest(method, params));

    // Wrap the handshake in a promise so prompt() can await it. Without
    // this, a user who hits Send while the ACP init is still in flight
    // sees the cryptic "ACP session not started" error. With it, the
    // prompt simply waits until session/new resolves and then proceeds.
    this.readyPromise = (async () => {
      try {
        const init = await this.rpc!.request<InitializeResult>('initialize', {
          protocolVersion: HOST_ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: 'code-build-vscode', version: '0.0.1' }
        });
        // Protocol-version pin chip — read-only; warn never blocks start.
        const pin = evaluateProtocolVersionPin({
          hostVersion: HOST_ACP_PROTOCOL_VERSION,
          agentInitialize: init
        });
        this.emit({
          kind: 'protocol_version_update',
          hostVersion: pin.hostVersion,
          agentVersion: pin.agentVersion,
          experimental: pin.experimental,
          label: pin.label,
          warn: pin.warn,
          ...(pin.warnReason ? { warnReason: pin.warnReason } : {})
        });
        // Spend-limit parity: Grok/Codex-via-ACP usually omit rate_limits →
        // chip shows n/a (never fake 100%). If initialize carries Claude-shaped
        // rate_limits.spend_limit (or camelCase), surface remaining %.
        this.emitSpendLimit(init);
        // Pass MCP servers (default: chrome-devtools autoConnect + playwright).
        // Each entry MUST include `env: []` — ACP's untagged McpServer enum
        // rejects objects without env (Invalid params → broken Grok restore).
        const mcpServers = resolveAcpMcpServers({
          backend: this.backend,
          model: opts.model,
          sessionId: this.id,
          forceKp: opts.forceKp === true
        });
        const canLoad =
          !!init.agentCapabilities?.loadSession && !!opts.resumeId;

        let loaded = false;
        let loadFailure: string | undefined;
        if (canLoad) {
          // True native resume: Grok (and any ACP agent with loadSession)
          // restores on-disk transcript + context. History may also stream
          // as session/update notifications; CB already replays from disk.
          try {
            const loadResult = await this.rpc!.request<{ modes?: SessionModes }>('session/load', {
              sessionId: opts.resumeId,
              cwd: opts.cwd,
              mcpServers
            });
            this.acpSessionId = opts.resumeId;
            this.emit({ kind: 'system_init', backendSessionId: opts.resumeId! });
            this.ingestModes(loadResult?.modes);
            loaded = true;
          } catch (err) {
            // session/load can reject for reasons that don't doom the
            // process: the on-disk session dir was deleted, the id came
            // from a different machine, or a grok update changed the
            // session schema. Mirror StreamJsonTransport's --resume
            // auto-fallback: continue into session/new instead of killing
            // the whole handshake. resume_fallback is emitted only AFTER
            // session/new succeeds — emitting it here would tell the user
            // "started a fresh session" moments before a hard error if
            // session/new also rejects.
            loadFailure = err instanceof Error ? err.message : String(err);
          }
        }
        if (!loaded) {
          const session = await this.rpc!.request<NewSessionResult>('session/new', {
            cwd: opts.cwd,
            mcpServers
          });
          this.acpSessionId = session.sessionId;
          if (loadFailure !== undefined) {
            // Now that the fresh session exists, tell the host so it can
            // arm the transcript primer + notify the user.
            this.emit({
              kind: 'resume_fallback',
              requestedSessionId: opts.resumeId!,
              reason: loadFailure
            });
          }
          // Emit for parity with the Claude path. SessionManager persists
          // this as meta.backendSessionId for later session/load resume.
          // After a resume_fallback this OVERWRITES the stale id, so the
          // next reload resumes the session that actually exists.
          this.emit({ kind: 'system_init', backendSessionId: session.sessionId });
          this.ingestModes(session.modes);
        }
      } catch (err) {
        // Surface handshake failures in the chat (the message handler's
        // .catch only sees the start() rejection; if start() itself
        // returned but the deferred handshake failed mid-flight, this
        // is where the user finds out). Include the stderr tail so the
        // root cause is visible.
        const tail = this.startupStderr.trim().slice(-512);
        const detail = tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : '';
        this.emit({
          kind: 'error',
          message: `Failed to initialize ${bin} ACP session: ${
            err instanceof Error ? err.message : String(err)
          }${detail}`
        });
        throw err;
      }
    })();

    await this.readyPromise;
  }

  /** Settled (never rejecting) view of the ACP handshake. The host awaits
   * this before snapshotting primer state so a prompt sent while
   * "Resuming…" is still in flight can't race the resume_fallback
   * promotion. Handshake errors were already surfaced from start(). */
  override ready(): Promise<void> {
    return this.readyPromise?.catch(() => undefined) ?? Promise.resolve();
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = params as { update?: Record<string, unknown> };
      if (p.update) {
        for (const u of normalizeAcpUpdate(p.update as never)) {
          // Keep the auto-approve mode in lockstep with the agent's own
          // mode changes — otherwise the chip shows agent truth while
          // handlePermission still applies the stale spawn-time mode.
          if (u.kind === 'current_mode_update' && u.mode) this.mode = u.mode;
          this.emit(u);
        }
        // Only re-evaluate when the update actually carries rate_limits —
        // a bare agent_message_chunk must not wipe a prior spend chip to n/a.
        if (updateHasRateLimits(p.update)) this.emitSpendLimit(p.update);
      }
    }
  }

  private lastSpendLimitLabel?: string;

  private emitSpendLimit(status: unknown): void {
    const chip = evaluateSpendLimitChip(
      status && typeof status === 'object' ? (status as Record<string, unknown>) : null
    );
    if (chip.label === this.lastSpendLimitLabel) return;
    this.lastSpendLimitLabel = chip.label;
    this.emit({
      kind: 'spend_limit_update',
      available: chip.available,
      usedPercentage: chip.usedPercentage,
      remainingPercentage: chip.remainingPercentage,
      resetsAt: chip.resetsAt,
      label: chip.label,
      warn: chip.warn,
      ...(chip.warnReason ? { warnReason: chip.warnReason } : {})
    });
  }

  /** Session cwd used as the sandbox root for the fs/* bridge. */
  private requireRoot(): string {
    const root = this.startOpts?.cwd;
    if (!root) throw new Error('No workspace root for fs request');
    return root;
  }

  /** Resolve an agent-requested path. In bypass mode (the user opted
   * into the dangerous escape hatch) we skip the workspace-root
   * confinement so grok can touch files anywhere on the filesystem —
   * mirroring claude's `--dangerously-skip-permissions` semantics
   * which trusts the agent process completely. Otherwise we run
   * the pathGuard and reject anything that escapes session.cwd. */
  private resolveFsPath(requested: string): string {
    const root = this.requireRoot();
    if (this.mode === 'bypass' && this.startOpts?.allowBypass) {
      // No sandbox. Relative requests still resolve against the
      // session cwd so the agent's "./foo.md" works as it would in a
      // terminal; absolute requests pass through verbatim.
      // Intentionally NO realpath/confine — product trust model for bypass.
      return path.resolve(root, requested);
    }
    if (!this.pathGuard || this.pathGuardCwd !== root) {
      // Lazy-init / rebuild if cwd string changes. createPathGuard realpaths
      // root once; confine returns the confined real path for fs ops.
      this.pathGuard = createPathGuard(root);
      this.pathGuardCwd = root;
    }
    return this.pathGuard.confine(requested);
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file': {
        const p = params as { path: string };
        const safe = this.resolveFsPath(p.path);
        // Pre-read size gate — block oversized files before bytes hit the
        // model invoice (kp: ideas/cb-big-file-read-hard-block-host-gate-warn-then).
        if (this.startOpts?.onFsReadCheck) {
          const st = await fs.stat(safe);
          if (!this.startOpts.onFsReadCheck(safe, st.size)) {
            throw new Error(
              `Read blocked by Code Build toolRead gate: ${safe} is ${st.size} bytes. ` +
                `Allow once / Allow session, or raise codeBuild.toolRead.maxBytesBlock.`
            );
          }
        }
        const content = await fs.readFile(safe, 'utf8');
        return { content };
      }
      case 'fs/write_text_file': {
        const p = params as { path: string; content: string };
        const safe = this.resolveFsPath(p.path);
        try {
          // Pre-image capture must see the disk BEFORE this write lands;
          // a capture failure must never block the agent's write.
          this.startOpts?.onFsPreWrite?.(safe);
        } catch {
          /* capture is best-effort */
        }
        await fs.writeFile(safe, p.content, 'utf8');
        return null;
      }
      case 'session/request_permission':
        return this.handlePermission(params as Record<string, unknown>);
      default:
        if (isAskUserQuestionMethod(method)) {
          return this.handleAskUserQuestion(params);
        }
        throw new Error(`Method not found: ${method}`);
    }
  }

  /**
   * Grok blocks the turn on this reverse-request. Show the existing
   * AskUserQuestion card and resolve the JSON-RPC when the user answers
   * (or cancel with `{ outcome: "cancelled" }` on dispose).
   */
  private handleAskUserQuestion(params: unknown): Promise<unknown> {
    const parsed = parseAskUserQuestionParams(params);
    if (!parsed) {
      throw new Error('Invalid x.ai/ask_user_question params');
    }
    this.emit({
      kind: 'tool_call',
      toolCall: {
        toolCallId: parsed.toolCallId,
        title: 'AskUserQuestion',
        status: 'pending',
        rawInput: { questions: parsed.questions, mode: parsed.mode }
      }
    });
    return new Promise((resolve) => {
      this.pendingAskUser.set(parsed.toolCallId, resolve);
    });
  }

  answerAskUserQuestion(toolCallId: string, answers: Record<string, string>): boolean {
    const resolve = this.pendingAskUser.get(toolCallId);
    if (!resolve) return false;
    this.pendingAskUser.delete(toolCallId);
    this.emit({
      kind: 'tool_call_update',
      toolCall: { toolCallId, status: 'completed' }
    });
    resolve(buildAskUserQuestionAccepted(answers));
    return true;
  }

  private cancelPendingAskUser(): void {
    for (const [id, resolve] of this.pendingAskUser) {
      resolve(buildAskUserQuestionCancelled());
      this.emit({
        kind: 'tool_call_update',
        toolCall: { toolCallId: id, status: 'failed' }
      });
    }
    this.pendingAskUser.clear();
  }

  private handlePermission(params: Record<string, unknown>): Promise<{ outcome: PermissionOutcome }> {
    const requestId = crypto.randomUUID();
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const options = (params.options ?? []) as { optionId: string; name: string; kind: string }[];
    const toolKind = toolCall.kind as string | undefined;

    // Auto-approve to match Claude Code's permission semantics:
    //   - bypass  → approve everything (the user opted into the escape hatch)
    //   - acceptEdits → approve edit/write tools, still prompt for the rest
    //     (Bash, fetch, etc.) so destructive non-edit ops keep a gate.
    // We pick the strongest "allow" option the agent offered (allow_always >
    // allow_once) so the agent stops re-asking within the session.
    const isEditKind = toolKind === 'edit' || toolKind === 'write' || toolKind === 'create';
    const shouldAutoApprove =
      (this.mode === 'bypass' && this.startOpts?.allowBypass) ||
      (this.mode === 'acceptEdits' && isEditKind);
    if (shouldAutoApprove) {
      const allow =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once');
      if (allow) {
        // Still surface the tool call to the UI (so the user sees activity),
        // but resolve immediately without a blocking prompt.
        return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
      }
    }

    // Forward the FULL toolCall (rawInput/content/locations) so the prompt
    // can show the actual command/diff being approved, not just "Bash".
    // All rich fields are optional — some adapters send title-only payloads.
    this.emit({
      kind: 'permission_request',
      requestId,
      toolCall: buildPermissionToolCall(params.toolCall, requestId),
      options: options as never
    });
    return new Promise((resolve) => {
      this.pendingPermissions.add(requestId, (outcome) => resolve({ outcome }));
    });
  }

  async prompt(blocks: ContentBlock[]): Promise<void> {
    // Wait for the handshake to finish before we send the first prompt.
    // Hitting Send mid-handshake used to produce "ACP session not started";
    // now the prompt queues until session/new resolves. If the handshake
    // failed entirely, the error was already surfaced from start() — we
    // bail quietly here rather than emit a redundant second error.
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch {
        return;
      }
    }
    if (!this.rpc || !this.acpSessionId) {
      // Last-resort: handshake never even started (start() wasn't called
      // or the process died before init). Surface a clearer message than
      // the old generic string so the user knows what to do.
      const tail = this.startupStderr.trim().slice(-512);
      this.emit({
        kind: 'error',
        message:
          `${this.backend} ACP session never finished its handshake — the agent process either failed to start or didn't respond to \`initialize\`.` +
          (tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : '\n\nNo stderr captured.')
      });
      return;
    }
    try {
      const res = await this.rpc.request<PromptResult>('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: blocks.map(toAcpBlock)
      });
      this.emit({ kind: 'result', stopReason: res.stopReason });
    } catch (err) {
      // Process-exit settlement disposes the RPC endpoint, which rejects
      // this request. The exit handler already emitted error/result — do
      // not double-emit a "JSON-RPC endpoint disposed" bubble.
      if (this.exitSettled) return;
      // Live RPC reject (process still up) is where ACP backends surface
      // overload/unavailable mid-turn — the exit path never sees these.
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        kind: 'error',
        message,
        errorClass: classifyBackendError({
          message,
          code: (err as { code?: number | string }).code
        })
      });
    }
  }

  /**
   * Child-process exit path. Idempotent with dispose(): intentional host
   * teardown sets exitSettled before kill so we don't emit a synthetic
   * result into a panel that's already closing.
   */
  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    bin: string
  ): void {
    if (this.exitSettled) return;
    this.exitSettled = true;
    const rpc = this.rpc;
    this.rpc = undefined;
    this.proc = undefined;
    settleAcpProcessExit({
      code,
      signal,
      bin,
      startupStderr: this.startupStderr,
      emit: (u) => this.emit(u),
      disposeRpc: () => rpc?.dispose(),
      cancelPermissions: () => {
        this.pendingPermissions.cancelAll();
        this.cancelPendingAskUser();
      }
    });
  }

  cancel(): void {
    if (this.rpc && this.acpSessionId) {
      this.rpc.notify('session/cancel', { sessionId: this.acpSessionId });
    }
  }

  /** Ingest the `modes` object from a session/new|load response: remember
   * the advertised inventory (setMode validates against it) and seed the
   * webview picker + chip before any current_mode_update arrives. */
  private ingestModes(modes: SessionModes | undefined): void {
    if (!modes?.currentModeId) return;
    const available = (modes.availableModes ?? [])
      .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
      .map((m) => ({ id: m.id, name: m.name || m.id, description: m.description }));
    this.availableModeIds = available.length > 0 ? available.map((m) => m.id) : undefined;
    this.emit({ kind: 'modes_update', currentModeId: modes.currentModeId, availableModes: available });
    const mapped = permissionModeFromAcpId(modes.currentModeId);
    if (mapped) this.mode = mapped;
    this.emit({
      kind: 'current_mode_update',
      mode: mapped,
      vendorModeId: modes.currentModeId
    });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    // Track the mode locally first so handlePermission can auto-approve in
    // bypass/acceptEdits; before the handshake completes there is no wire
    // session yet, so local tracking is the whole effect.
    const prev = this.mode;
    this.mode = mode;
    if (!this.rpc || !this.acpSessionId) return;
    let modeId = acpIdForPermissionMode(mode);
    // When the agent advertised its inventory on session/new|load, reject
    // unsupported modes locally instead of guessing — the caller reverts
    // the chip and skips persisting the selection. Aliases count: an agent
    // advertising `manual` (not `default`) still accepts mode 'default',
    // and we send the id the agent actually advertised.
    if (this.availableModeIds) {
      const advertised = this.availableModeIds.includes(modeId)
        ? modeId
        : this.availableModeIds.find((id) => permissionModeFromAcpId(id) === mode);
      if (!advertised) {
        this.mode = prev;
        throw new Error(`${this.backend} does not support permission mode '${mode}'`);
      }
      modeId = advertised;
    }
    try {
      await this.rpc.request('session/set_mode', { sessionId: this.acpSessionId, modeId });
    } catch (err) {
      this.mode = prev;
      throw err;
    }
  }

  respondPermission(requestId: string, outcome: PermissionOutcome): void {
    this.pendingPermissions.resolve(requestId, outcome);
  }

  override hasPendingPermissions(): boolean {
    return this.pendingPermissions.size > 0 || this.pendingAskUser.size > 0;
  }

  override dispose(): void {
    // Mark settled before kill so the 'exit' handler does not re-emit
    // synthetic result/error into a disposed session.
    this.exitSettled = true;
    super.dispose();
    this.rpc?.dispose();
    this.rpc = undefined;
    this.proc?.kill();
    this.proc = undefined;
    // Cancel (not drop) every outstanding request — a bare .clear() left
    // the agent's request_permission promises hanging forever.
    this.pendingPermissions.cancelAll();
    this.cancelPendingAskUser();
  }
}

function toAcpBlock(b: ContentBlock): Record<string, unknown> {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'resource_link') return { type: 'resource_link', uri: b.uri, name: b.name };
  if (b.type === 'image') return { type: 'image', mimeType: b.mimeType, data: b.data };
  return { type: 'text', text: '' };
}
