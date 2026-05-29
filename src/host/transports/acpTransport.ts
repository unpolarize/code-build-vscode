import type {
  BackendId,
  ContentBlock,
  PermissionMode,
  PermissionOutcome
} from '../../shared/acpTypes';
import { BaseAgentSession, type StartOpts } from '../agentSession';

/**
 * ACP JSON-RPC transport stub. Fully implemented in P2 (Grok via `grok agent stdio`,
 * then opencode/Cline). For now it surfaces a clear, actionable error so the UI
 * degrades gracefully when an ACP backend is selected before P2 lands.
 */
export class AcpTransport extends BaseAgentSession {
  constructor(
    public readonly id: string,
    public readonly backend: BackendId,
    private readonly binOverrides: Record<string, string>
  ) {
    super();
  }

  async start(_opts: StartOpts): Promise<void> {
    /* P2 */
  }

  async prompt(_blocks: ContentBlock[]): Promise<void> {
    this.emit({
      kind: 'error',
      message: `ACP backend "${this.backend}" is not wired yet (lands in P2). Use the Claude backend for now.`
    });
    this.emit({ kind: 'result', stopReason: 'not_implemented' });
  }

  cancel(): void {
    /* P2 */
  }

  setMode(_mode: PermissionMode): void {
    /* P2 */
  }

  respondPermission(_requestId: string, _outcome: PermissionOutcome): void {
    /* P2 */
  }
}
