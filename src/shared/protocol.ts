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
  /** Currently-selected model id (e.g. 'claude-opus-4-7', 'grok-build').
   * Optional — when missing the backend picks the default. */
  model?: string;
  /** Currently-selected effort/thinking-budget level. */
  effort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Snapshot used to (re)hydrate the webview on load / window-move reload. */
export interface HydrateState {
  session: SessionMeta | null;
  /** Available backends detected on this machine, with their model lists
   * + effort-support flags so the header can populate the dropdowns. */
  backends: BackendCapability[];
  allowBypass: boolean;
  /** Recent persisted sessions, newest first, for the in-chat history dropdown. */
  sessions: SessionMeta[];
  /** Default backend from settings. */
  defaultBackend: BackendId;
}

/** Capability snapshot of one backend, served to the webview on hydrate. */
export interface BackendCapability {
  id: BackendId;
  label: string;
  available: boolean;
  /** Known model ids (first entry conventionally 'default'). Empty list
   * means the picker is hidden. */
  models?: string[];
  supportsEffort?: boolean;
}

// ---- Webview -> Host commands ----
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'prompt'; blocks: ContentBlock[] }
  | { type: 'cancel' }
  | { type: 'setMode'; mode: PermissionMode }
  | { type: 'pickBackend'; backend: BackendId }
  /** Change the active model for the current session. Triggers a respawn
   * with the new --model flag at the next prompt (or immediately if the
   * agent is idle). */
  | { type: 'setModel'; model: string }
  /** Change the active effort/thinking-budget level. Same respawn rules. */
  | { type: 'setEffort'; effort: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { type: 'newSession'; backend?: BackendId }
  /** User's answer to the cross-backend context-handoff prompt: carry the
   * full prior conversation, a summary, or nothing into the new backend. */
  | { type: 'primerDecision'; choice: 'full' | 'summary' | 'none' }
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
  | { type: 'resumeSession'; id: string; source?: SessionSource; cwd?: string }
  /** User's response to a `primerPrompt` shown on backend swap or
   * external-session import. 'full' = verbatim prior turns; 'summary' =
   * user prompts + brief assistant excerpts; 'none' = drop the primer.
   * Dismissing the banner without choosing is equivalent to 'none'. */
  | { type: 'primerDecision'; choice: 'full' | 'summary' | 'none' }
  /** User's click on an AskUserQuestion option card. The host translates
   * this into the upstream tool_result the backend is waiting for. */
  | { type: 'askUserAnswer'; toolCallId: string; answers: Record<string, string> };

// ---- Host -> Webview events ----
export type HostToWebview =
  | { type: 'hydrate'; state: HydrateState }
  | { type: 'sessionUpdate'; sessionId: string; update: SessionUpdate }
  | { type: 'sessionMeta'; session: SessionMeta }
  | { type: 'busy'; busy: boolean }
  | { type: 'fileSuggestions'; suggestions: Array<{ path: string; label?: string }> }
  | { type: 'sessionsList'; sessions: SessionMeta[] }
  | { type: 'historyLoaded'; meta: SessionMeta; records: Array<{ type: string; text?: string; update?: SessionUpdate }> }
  /** Backend-swap / external-session-import primer Q&A. The webview shows
   * a 3-button banner ('Full / Summary / Start fresh') above the composer;
   * the answer comes back as `primerDecision`. The existing camelCase
   * fields are kept for backward-compat with prior code-build releases. */
  | { type: 'primerPrompt'; turnCount: number; fromBackend: string; toBackend: string }
  /** AskUserQuestion tool call surfaced from the agent. Each entry is one
   * pickable card with the agent's question + N options. Clicking posts
   * `askUserAnswer` which the host converts to the upstream tool_result. */
  | {
      type: 'askUserQuestion';
      toolCallId: string;
      questions: Array<{
        question: string;
        header?: string;
        multiSelect?: boolean;
        options: Array<{ label: string; description?: string; preview?: string }>;
      }>;
    }
  /** TodoWrite-style task list emitted by the agent. Renders as a checklist
   * card (one per snapshot). The agent owns updates — clicking is read-only. */
  | {
      type: 'taskList';
      toolCallId: string;
      tasks: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; activeForm?: string }>;
    };

export function isWebviewToHost(msg: unknown): msg is WebviewToHost {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
