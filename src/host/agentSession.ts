import type {
  BackendId,
  ContentBlock,
  PermissionMode,
  PermissionOutcome,
  SessionUpdate
} from '../shared/acpTypes';

export interface StartOpts {
  cwd: string;
  mode: PermissionMode;
  model?: string;
  /** Resume an existing backend session id, if supported. */
  resumeId?: string;
  /** Effort / thinking-budget level — claude code, codex, grok. Not all
   * backends honor it; buildArgs is the gatekeeper. Levels match the CLIs:
   * low/medium/high/xhigh/max. */
  effort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Whether the user opted into the skip-permissions escape hatch
   * (codeBuild.allowDangerouslySkipPermissions). Gates the
   * --dangerously-skip-permissions flag (claude) and ACP auto-approve. */
  allowBypass?: boolean;
  /** Additional directories the agent is allowed to touch beyond the
   * spawn cwd. Plumbed into claude as `--add-dir <path>` flags so the
   * agent's Read/Write/Bash tools aren't restricted to the workspace
   * folder. Without this, --dangerously-skip-permissions skips the
   * permission UI but the tools still respect the cwd boundary — that
   * was the "code-build chat is locked to the project repo" bug. */
  additionalTrustedDirs?: string[];
}

/**
 * The single abstraction the UI/SessionManager talks to. Each concrete transport
 * (AcpTransport, StreamJsonTransport) implements it and emits ACP-shaped SessionUpdates.
 */
export interface AgentSession {
  readonly id: string;
  readonly backend: BackendId;

  start(opts: StartOpts): Promise<void>;
  prompt(blocks: ContentBlock[]): Promise<void>;
  cancel(): void;
  setMode(mode: PermissionMode): void;
  respondPermission(requestId: string, outcome: PermissionOutcome): void;

  /** Resolves once the transport's startup handshake has settled (either
   * way — a failed handshake resolves too; the error is surfaced through
   * the event stream). Hosts that mutate prompt inputs based on handshake
   * outcomes (e.g. the resume_fallback primer promotion) MUST await this
   * before snapshotting that state, or a prompt sent mid-handshake races
   * the outcome. Default: already-resolved (spawn-per-prompt transports
   * have no handshake). */
  ready(): Promise<void>;

  /** Subscribe to the normalized event stream. Returns an unsubscribe fn. */
  onEvent(cb: (update: SessionUpdate) => void): () => void;

  dispose(): void;
}

/** Small base that handles the event-listener bookkeeping for transports. */
export abstract class BaseAgentSession implements AgentSession {
  abstract readonly id: string;
  abstract readonly backend: BackendId;

  private listeners = new Set<(u: SessionUpdate) => void>();

  abstract start(opts: StartOpts): Promise<void>;
  abstract prompt(blocks: ContentBlock[]): Promise<void>;
  abstract cancel(): void;
  abstract setMode(mode: PermissionMode): void;
  abstract respondPermission(requestId: string, outcome: PermissionOutcome): void;

  ready(): Promise<void> {
    return Promise.resolve();
  }

  onEvent(cb: (update: SessionUpdate) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected emit(update: SessionUpdate): void {
    for (const l of this.listeners) {
      l(update);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
