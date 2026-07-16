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
import { confineToRoot } from '../pathGuard';
import {
  defaultBrowserMcpServers,
  normalizeMcpServerConfig,
  type AcpMcpServer
} from './mcpServers';

export type { AcpMcpServer };
export { DEFAULT_BROWSER_MCP_SERVERS } from './mcpServers';

interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: { loadSession?: boolean };
}
interface NewSessionResult {
  sessionId: string;
}
interface PromptResult {
  stopReason: string;
}

/**
 * Resolve MCP servers to pass on ACP session/new.
 * Setting `codeBuild.mcpServers` overrides; when empty, inject the personal-browser stack
 * so Grok (and other ACP backends) can drive the user's real Chrome profile.
 */
export function resolveAcpMcpServers(): AcpMcpServer[] {
  const cfg = vscode.workspace.getConfiguration('codeBuild');
  const raw = cfg.get<unknown>('mcpServers');
  return normalizeMcpServerConfig(raw) ?? defaultBrowserMcpServers();
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
  private pendingPermissions = new Map<string, (outcome: PermissionOutcome) => void>();
  /** Resolves when initialize + session/new have completed (or rejects on
   * any failure). prompt() awaits this so the user can hit Send while the
   * ACP handshake is still in flight — the prompt is queued instead of
   * failing with the cryptic "ACP session not started". */
  private readyPromise?: Promise<void>;
  /** Captured stderr while spawn + handshake are in progress; surfaced in
   * the error bubble if the handshake fails so the user sees what went
   * wrong instead of a generic timeout. */
  private startupStderr = '';

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
    this.proc.on('exit', (code) => {
      if (code && code !== 0) {
        const tail = this.startupStderr.trim().slice(-512);
        this.emit({
          kind: 'error',
          message: `${bin} exited with code ${code}${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`
        });
      }
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
        await this.rpc!.request<InitializeResult>('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: { name: 'code-build-vscode', version: '0.0.1' }
        });
        // Pass MCP servers (default: chrome-devtools autoConnect + playwright)
        // so Grok ACP can drive the personal Chrome profile without relying only
        // on ~/.grok/config.toml. User override: codeBuild.mcpServers.
        const mcpServers = resolveAcpMcpServers();
        const session = await this.rpc!.request<NewSessionResult>('session/new', {
          cwd: opts.cwd,
          mcpServers
        });
        this.acpSessionId = session.sessionId;
        // Emit for parity with the Claude path. This lets SessionManager
        // captureBackendSessionId persist the native grok ACP session id
        // into SessionMeta, powering "Open in Code Sessions", history
        // cross-links, and any future load/resume using the agent's own id.
        this.emit({ kind: "system_init", backendSessionId: session.sessionId });
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

  private onNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = params as { update?: Record<string, unknown> };
      if (p.update) {
        for (const u of normalizeAcpUpdate(p.update as never)) this.emit(u);
      }
    }
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
      return path.resolve(root, requested);
    }
    return confineToRoot(root, requested);
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file': {
        const p = params as { path: string };
        const safe = this.resolveFsPath(p.path);
        const content = await fs.readFile(safe, 'utf8');
        return { content };
      }
      case 'fs/write_text_file': {
        const p = params as { path: string; content: string };
        const safe = this.resolveFsPath(p.path);
        await fs.writeFile(safe, p.content, 'utf8');
        return null;
      }
      case 'session/request_permission':
        return this.handlePermission(params as Record<string, unknown>);
      default:
        throw new Error(`Method not found: ${method}`);
    }
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

    this.emit({
      kind: 'permission_request',
      requestId,
      toolCall: {
        toolCallId: String(toolCall.toolCallId ?? requestId),
        title: String(toolCall.title ?? 'Permission request'),
        kind: toolKind,
        status: 'pending'
      },
      options: options as never
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, (outcome) => resolve({ outcome }));
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
      this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  cancel(): void {
    if (this.rpc && this.acpSessionId) {
      this.rpc.notify('session/cancel', { sessionId: this.acpSessionId });
    }
  }

  setMode(mode: PermissionMode): void {
    // Track the mode so handlePermission can auto-approve in bypass/acceptEdits.
    // (ACP session/set_mode for the agent's own mode tracking lands later;
    // the auto-approve path is what actually unblocks the user today.)
    this.mode = mode;
  }

  respondPermission(requestId: string, outcome: PermissionOutcome): void {
    const resolver = this.pendingPermissions.get(requestId);
    if (resolver) {
      this.pendingPermissions.delete(requestId);
      resolver(outcome);
    }
  }

  override dispose(): void {
    super.dispose();
    this.rpc?.dispose();
    this.rpc = undefined;
    this.proc?.kill();
    this.proc = undefined;
    this.pendingPermissions.clear();
  }
}

function toAcpBlock(b: ContentBlock): Record<string, unknown> {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'resource_link') return { type: 'resource_link', uri: b.uri, name: b.name };
  if (b.type === 'image') return { type: 'image', mimeType: b.mimeType, data: b.data };
  return { type: 'text', text: '' };
}
