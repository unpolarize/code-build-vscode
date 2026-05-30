// Typed envelope for host <-> webview messaging. Imported by BOTH the extension
// host (esbuild) and the React webview (Vite). Keep this types-only + tiny helpers;
// no runtime dependency on vscode or DOM here.

import type {
  BackendId,
  ContentBlock,
  PermissionMode,
  PermissionOutcome,
  SessionUpdate
} from './acpTypes';

/** Which session store this row originated from. Local code-build sessions
 * live in ~/.codebuild; external rows are surfaced from the upstream CLI's
 * own session store (~/.claude/projects, ~/.grok/sessions) so the history
 * picker can offer them too. Resuming an external session spawns the CLI
 * with the appropriate `--resume <id>` flag (claude) or a fresh process
 * (grok — no documented external resume flag yet). */
export type SessionSource = 'codebuild' | 'claude' | 'grok';

/** Metadata describing one chat session shown in the UI. */
export interface SessionMeta {
  id: string;
  backend: BackendId;
  title: string;
  mode: PermissionMode;
  cwd: string;
  createdAt: number;
  /** Defaults to 'codebuild' for legacy rows that pre-date this field. */
  source?: SessionSource;
  /** For external sessions: absolute path of the upstream transcript file
   * (claude jsonl or grok chat_history.jsonl). Lets the picker show a
   * "Reveal in finder" affordance and lets future code peek at content. */
  externalPath?: string;
}

/** Snapshot used to (re)hydrate the webview on load / window-move reload. */
export interface HydrateState {
  session: SessionMeta | null;
  /** Available backends detected on this machine. */
  backends: { id: BackendId; label: string; available: boolean }[];
  allowBypass: boolean;
  /** Recent persisted sessions, newest first, for the in-chat history dropdown. */
  sessions: SessionMeta[];
  /** Default backend from settings. */
  defaultBackend: BackendId;
}

// ---- Webview -> Host commands ----
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'prompt'; blocks: ContentBlock[] }
  | { type: 'cancel' }
  | { type: 'setMode'; mode: PermissionMode }
  | { type: 'pickBackend'; backend: BackendId }
  | { type: 'newSession'; backend?: BackendId }
  | { type: 'respondPermission'; requestId: string; outcome: PermissionOutcome }
  | { type: 'openDiff'; path: string; oldText: string; newText: string }
  | { type: 'revealLocation'; path: string; line?: number }
  | { type: 'openInCoderSessions' }
  | { type: 'openInNewTab' }
  | { type: 'openInNewWindow' }
  | { type: 'getFileSuggestions'; query: string }
  | { type: 'listSessions' }
  /** Resume a session by id. When `source` is set to 'claude' or 'grok',
   * the host loads the upstream transcript (cwd is required to locate it)
   * instead of looking in the local ~/.codebuild store. Older callers that
   * only send `id` continue to work and are treated as local. */
  | { type: 'resumeSession'; id: string; source?: SessionSource; cwd?: string };

// ---- Host -> Webview events ----
export type HostToWebview =
  | { type: 'hydrate'; state: HydrateState }
  | { type: 'sessionUpdate'; sessionId: string; update: SessionUpdate }
  | { type: 'sessionMeta'; session: SessionMeta }
  | { type: 'busy'; busy: boolean }
  | { type: 'fileSuggestions'; suggestions: Array<{ path: string; label?: string }> }
  | { type: 'sessionsList'; sessions: SessionMeta[] }
  | { type: 'historyLoaded'; meta: SessionMeta; records: Array<{ type: string; text?: string; update?: SessionUpdate }> };

export function isWebviewToHost(msg: unknown): msg is WebviewToHost {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
