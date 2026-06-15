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
  /** Backend's NATIVE session id (e.g. claude's `session_id` from the
   * `system` init line). Distinct from `id`, which is our local UUID.
   * Persisted so a reload of the panel can spawn the agent with
   * `--resume <backendSessionId>` and pick up the on-disk transcript
   * the agent itself wrote. Set the first time the backend emits a
   * `system_init` event; never reassigned. */
  backendSessionId?: string;
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
  /** Memory inventory snapshot. The Header renders a small chip showing
   * the number of memory entries discovered across CLAUDE.md /
   * AGENTS.md / MEMORY.md / ~/.claude / ~/.codex sources visible from
   * the current workspace. Clicking the chip surfaces a tooltip with
   * the per-provider breakdown. Refreshed on hydrate; live changes
   * picked up by re-hydration on session swap or panel reload. */
  memoryEntries: number;
  memoryFiles: number;
  memoryByProvider: Record<string, number>;
  /** Sticky-banner toggle from `codeBuild.showActiveQuestionBanner`.
   * When false the ActiveQuestionBanner never renders even if a
   * question is present. */
  showActiveQuestionBanner: boolean;
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
  /** Send a user message to the agent. `interjected: true` marks a mid-stream
   * steer (the user sent while the agent was still generating); the host
   * still calls `session.prompt()` immediately — claude stream-json queues
   * the new input on stdin, grok ACP queues at the session/prompt layer. */
  | { type: 'prompt'; blocks: ContentBlock[]; interjected?: boolean }
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
  /** User's answer to the cross-backend context-handoff prompt:
   *   - 'full'   = prepend the prior conversation verbatim
   *   - 'hybrid' = ask the SOURCE backend to LLM-summarise the prior
   *                conversation (one-shot fork), then append the last
   *                `lastNTurns` user/assistant turns verbatim so the
   *                new backend has both a high-level recap AND recent
   *                detail. `lastNTurns >= 0`; 0 = summary only.
   *   - 'none'   = no carry-over, start fresh
   */
  | { type: 'primerDecision'; choice: 'full' | 'hybrid' | 'none'; lastNTurns?: number }
  | { type: 'respondPermission'; requestId: string; outcome: PermissionOutcome }
  | { type: 'openDiff'; path: string; oldText: string; newText: string }
  | { type: 'revealLocation'; path: string; line?: number }
  | { type: 'openInCodeSessions' }
  | { type: 'openInNewTab' }
  | { type: 'openInNewWindow' }
  | { type: 'getFileSuggestions'; query: string }
  | { type: 'listSessions' }
  /** Resume a session by id. When `source` is set to 'claude' or 'grok',
   * the host loads the upstream transcript (cwd is required to locate it)
   * instead of looking in the local ~/.codebuild store. Older callers that
   * only send `id` continue to work and are treated as local. */
  | { type: 'resumeSession'; id: string; source?: SessionSource; cwd?: string }
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
  /** Backend-swap primer Q&A. The webview shows a card picker above the
   * composer; the answer comes back as `primerDecision`. `sourceBackendId`
   * is the BackendId (not the human label) of the source — the host
   * uses it to know which CLI to fork for the LLM summary. */
  | {
      type: 'primerPrompt';
      turnCount: number;
      fromBackend: string;
      toBackend: string;
      sourceBackendId: BackendId;
      /** Whether we can run a one-shot LLM summarization on this source
       * backend. False → the webview hides the hybrid option's
       * "(LLM-generated)" tag and the host falls back to a clipped
       * summary. Today only claude supports the one-shot fork. */
      llmSummarySupported: boolean;
    }
  /** Informational notice (not an error) — soft amber banner in the chat.
   * Used when the host wants to tell the user something is unusual (e.g.
   * a session is being held by another panel and we fell back to a fresh
   * chat) without the red-error visual treatment.
   *
   * `detail` is rendered as a `title` attribute on the notice bubble so
   * the user can hover for a multi-line tooltip. Startup notices fill
   * this with the resolved spawn command, cwd, and any --resume id so
   * the user can see WHAT we're actually waiting on when the panel
   * stalls during "Starting claude agent…".
   *
   * `key` lets the host retroactively remove a notice that turned out
   * to be stale — e.g., the 30s "still waiting" nudge fires, then the
   * agent's first event arrives at 31s and the nudge is no longer
   * true. Without dismissal, the stale notice persisted at the bottom
   * of the chat and looked like an unresolved hang. See dismissNotice. */
  | { type: 'notice'; text: string; detail?: string; key?: string }
  /** Remove every notice in the timeline whose `key` matches. No-op when
   * nothing matches. Used to clean up the 30s "still waiting on claude"
   * nudge once the agent actually emits an event — without this, a
   * timer that fired just before the agent woke up sat in the chat
   * forever and made it look like the turn never finished. */
  | { type: 'dismissNotice'; key: string }
  /** Topic labels for a completed turn. The host's classifier fires
   * after each end-of-turn `result` event when `codeBuild.classifyTurns`
   * is enabled. `turnIndex` is the 0-based index of the user prompt
   * within this session; the webview maps it to the matching user
   * bubble (small chips next to the role line). Off by default;
   * each call costs a small Haiku-tier inference. */
  | { type: 'turnLabels'; turnIndex: number; labels: string[] }
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
    }
  /** Transparency hook fired BEFORE every prompt / tool_result is written
   * to the agent's stdin. Renders as a collapsible card in the chat so
   * the user can audit exactly what we injected — the carry-over primer
   * (if any), each `@`-mention resolution, the raw user text, image
   * attachments, tool_result payloads. Without this, the agent's
   * effective input is invisible: a 12K primer or a mis-resolved file
   * ref can silently steer the turn and the user has no idea why. The
   * sections are stacked in the order they appear in the final stdin
   * line so a reader can mentally reconstruct the wire format. */
  | {
      type: 'contextInjected';
      origin: 'prompt' | 'tool_result' | 'system';
      summary: string;
      sections: Array<{
        label: string;
        body: string;
        chars: number;
        kind?: 'primer' | 'mention' | 'user_text' | 'image' | 'tool_result' | 'system';
      }>;
    };

export function isWebviewToHost(msg: unknown): msg is WebviewToHost {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
