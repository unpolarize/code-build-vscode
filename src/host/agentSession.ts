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
  /** Effort / thinking-budget level — claude code, codex (o-series). Not
   * all backends honor it; buildArgs is the gatekeeper. */
  effort?: 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'max';
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
