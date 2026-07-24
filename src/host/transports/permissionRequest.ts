// Pure helpers behind the ACP session/request_permission gate.
//
// Two halves of one integrity fix (kp: tasks/cb-permission-gate-integrity):
//   1. buildPermissionToolCall — forward the FULL toolCall context
//      (rawInput / content / locations) to the webview instead of the old
//      {toolCallId, title, kind, status} skeleton, so the human approves
//      what the agent is actually about to run. Every field is optional:
//      a bare {toolCallId} payload must produce a renderable fallback,
//      never a throw (a crash here would deadlock the agent's RPC).
//   2. PendingPermissionResolvers — FIFO-safe registry of outstanding
//      request resolvers. The old single-slot store meant a second
//      concurrent request orphaned the first resolver and the agent hung
//      until the stall watchdog fired. Teardown resolves EVERY pending
//      request with {outcome:'cancelled'} so no promise leaks.
import type { PermissionOutcome, ToolCall } from '../../shared/acpTypes';
import { extractAcpToolContent } from './normalizers/acp';

/** Normalize the agent-supplied toolCall from a session/request_permission
 * into our ToolCall shape, preserving rawInput/content/locations when the
 * agent sent them (claude-code-acp does; some adapters send title only). */
export function buildPermissionToolCall(raw: unknown, requestId: string): ToolCall {
  try {
    const tc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: ToolCall = {
      toolCallId: String(tc.toolCallId ?? requestId),
      title: String(tc.title ?? 'Permission request'),
      kind: typeof tc.kind === 'string' ? tc.kind : undefined,
      status: 'pending'
    };
    if (tc.rawInput != null) out.rawInput = tc.rawInput;
    const locations = extractLocations(tc.locations);
    if (locations.length) out.locations = locations;
    const content = extractAcpToolContent(tc.content);
    if (content.length) out.content = content;
    return out;
  } catch {
    // Defensive: malformed params must still yield a promptable request.
    return { toolCallId: requestId, title: 'Permission request', status: 'pending' };
  }
}

function extractLocations(raw: unknown): { path: string; line?: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { path: string; line?: number }[] = [];
  for (const item of raw) {
    const loc = item as Record<string, unknown>;
    if (loc && typeof loc.path === 'string') {
      out.push({ path: loc.path, line: typeof loc.line === 'number' ? loc.line : undefined });
    }
  }
  return out;
}

/** Outstanding permission-request resolvers keyed by our requestId.
 * Insertion-ordered (Map), so the webview's FIFO queue and this registry
 * agree on ordering; each resolver fires at most once. */
export class PendingPermissionResolvers {
  private resolvers = new Map<string, (outcome: PermissionOutcome) => void>();

  add(requestId: string, resolver: (outcome: PermissionOutcome) => void): void {
    this.resolvers.set(requestId, resolver);
  }

  /** Resolve one request. Returns false for unknown/already-resolved ids
   * (stale webview response after teardown — safe to ignore). */
  resolve(requestId: string, outcome: PermissionOutcome): boolean {
    const resolver = this.resolvers.get(requestId);
    if (!resolver) return false;
    this.resolvers.delete(requestId);
    resolver(outcome);
    return true;
  }

  /** Teardown: cancel every outstanding request so no agent-side JSON-RPC
   * promise is left hanging (the old .clear() leaked them all). */
  cancelAll(): void {
    const pending = [...this.resolvers.values()];
    this.resolvers.clear();
    for (const resolver of pending) resolver({ outcome: 'cancelled' });
  }

  get size(): number {
    return this.resolvers.size;
  }
}
