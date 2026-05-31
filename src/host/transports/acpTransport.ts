import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
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
      if (code && code !== 0) this.emit({ kind: 'error', message: `${bin} exited with code ${code}` });
    });
    this.proc.stderr.on('data', (b: Buffer) => {
      const t = b.toString().trim();
      if (t) console.error(`[code-build:${this.backend}] ${t}`);
    });

    this.rpc = new JsonRpcEndpoint(this.proc.stdin, this.proc.stdout);
    this.rpc.onNotification((method, params) => this.onNotification(method, params));
    this.rpc.onRequest((method, params) => this.onRequest(method, params));

    await this.rpc.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'code-build-vscode', version: '0.0.1' }
    });

    const session = await this.rpc.request<NewSessionResult>('session/new', {
      cwd: opts.cwd,
      mcpServers: []
    });
    this.acpSessionId = session.sessionId;
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = params as { update?: Record<string, unknown> };
      if (p.update) {
        for (const u of normalizeAcpUpdate(p.update as never)) this.emit(u);
      }
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'fs/read_text_file': {
        const p = params as { path: string };
        const content = await fs.readFile(p.path, 'utf8');
        return { content };
      }
      case 'fs/write_text_file': {
        const p = params as { path: string; content: string };
        await fs.writeFile(p.path, p.content, 'utf8');
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
    if (!this.rpc || !this.acpSessionId) {
      this.emit({ kind: 'error', message: 'ACP session not started' });
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
