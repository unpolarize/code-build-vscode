// Settle an ACP transport when the agent child process exits mid-turn.
//
// Bug class (kp: tasks/cb-harden-acp-process-exit-mid-turn-settle-pendi):
//   Grok/ACP daemon crash/OOM/kill mid-turn left the webview "working…"
//   spinner stuck forever. StreamJsonTransport already emits a synthetic
//   `result` on clean mid-turn exit; AcpTransport's exit handler only
//   emitted `error` for nonzero codes and never disposed the JSON-RPC
//   endpoint or drained pending permission resolvers — so in-flight
//   session/prompt promises never settled and permission prompts for a
//   dead process stayed clickable.
//
// Pure helper so unit tests can drive the settlement logic without
// spawning a real agent or mocking vscode.

import type { SessionUpdate } from '../../shared/acpTypes';
import { classifyBackendError } from '../../shared/backendErrorClass';

export interface AcpExitSettlement {
  /** Child process exit code (`null` when killed by signal). */
  code: number | null;
  /** Signal that killed the process, if any. */
  signal: NodeJS.Signals | null;
  /** Binary name for the error bubble (e.g. `grok`). */
  bin: string;
  /** Rolling stderr tail captured during the session. */
  startupStderr: string;
  emit: (update: SessionUpdate) => void;
  /** Reject outstanding JSON-RPC requests (session/prompt etc.). */
  disposeRpc: () => void;
  /** Resolve every pending permission request as cancelled. */
  cancelPermissions: () => void;
}

/** Nonzero exit code, or any signal kill, is abnormal. */
export function isAbnormalAcpExit(
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  if (signal != null) return true;
  return code !== null && code !== 0;
}

/**
 * Drain pending work, surface abnormal exits, and always emit a synthetic
 * `result` so the reducer's busy flag clears.
 *
 * Call order matters: cancel permissions + dispose RPC first so in-flight
 * prompt() promises settle before we emit UI events; emit error (if any)
 * before result so the user sees the diagnostic and then busy=false.
 */
export function settleAcpProcessExit(s: AcpExitSettlement): void {
  s.cancelPermissions();
  s.disposeRpc();

  if (isAbnormalAcpExit(s.code, s.signal)) {
    const tail = s.startupStderr.trim().slice(-512);
    const reason =
      s.signal != null ? `signal ${s.signal}` : `code ${s.code}`;
    s.emit({
      kind: 'error',
      message: `${s.bin} exited (${reason})${
        tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''
      }`,
      errorClass: classifyBackendError(tail)
    });
  }

  // Always clear busy — mirrors StreamJsonTransport's mid-turn exit path.
  // Even after an error bubble the spinner must not stick.
  s.emit({ kind: 'result', stopReason: 'exit' });
}
