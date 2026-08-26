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
import type { SessionKind, VoiceMode } from './voiceIdeation';

export type { SessionKind, VoiceMode } from './voiceIdeation';

/** Which session store this row originated from. Local code-build sessions
 * live in ~/.codebuild; external rows are surfaced from the upstream CLI's
 * own session store (~/.claude/projects, ~/.grok/sessions) so the history
 * picker can offer them too. Resuming an external session spawns the CLI
 * with the appropriate `--resume <id>` flag (claude) or a fresh process
 * (grok — no documented external resume flag yet). */
export type SessionSource = 'codebuild' | 'claude' | 'grok';

/** Why `backendSessionId` transitioned to a new value.
 * - initial: first `system_init` of the session
 * - respawn: backend process respawned mid-session (model/effort change,
 *   compaction respawn we can't distinguish yet) and issued a fresh id
 * - compact: reserved — emitted once compaction respawns are detectable
 * - resume_fallback: native resume was rejected and the transport fell
 *   back to a fresh session (see `resume_fallback` update) */
export type BackendSessionTransitionReason = 'initial' | 'respawn' | 'compact' | 'resume_fallback';

/** One entry in a session's native-id lineage (see `backendSessionHistory`). */
export interface BackendSessionTransition {
  id: string;
  ts: number;
  reason: BackendSessionTransitionReason;
}

/** On-disk format of a backend's native transcript store:
 * claude-jsonl → ~/.claude/projects/<slug>/<uuid>.jsonl,
 * grok-jsonl → ~/.grok/sessions/<cwd>/<uuid>/,
 * codex-rollout → ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<uuid>.jsonl. */
export type NativeTranscriptFormat = 'claude-jsonl' | 'grok-jsonl' | 'codex-rollout';

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
   * the agent itself wrote. Always the CURRENT native id: reassigned
   * whenever the backend emits a `system_init` with a new id (respawn,
   * compact, failed resume → fresh session); prior ids are kept in
   * `backendSessionHistory` so no native transcript is orphaned. */
  backendSessionId?: string;
  /** Every native session id this CB session has owned, oldest first.
   * Appended ONLY when the id CHANGES (re-inits with the same id are
   * no-ops — long sessions can re-init hundreds of times). N native ids
   * map to this ONE CB session; the join contract for cross-store
   * correlation (CSV analytics) reads `history[].id ∪ backendSessionId`. */
  backendSessionHistory?: BackendSessionTransition[];
  /** Pointer to the backend's own on-disk transcript for the CURRENT
   * native session. Invariant: `native.id === backendSessionId` — one
   * source of truth; this only adds the store format so consumers can
   * locate the file without a per-backend switch. */
  native?: { format: NativeTranscriptFormat; id: string };
  /** Durable per-backend native-session memory for THIS conversation: maps a
   * backend id -> the CB local session id that already holds that backend's
   * native thread. Lets a switch back to a backend the conversation has
   * already used resume natively (via that session's `--resume`) instead of
   * re-summarizing. Survives panel reopen (persisted on the meta line). */
  backendSessions?: Partial<Record<BackendId, string>>;
  /** Session kind — coding (default) or voice-ideation (VIS). */
  sessionKind?: SessionKind;
  /** Stop-governor trips (warn or hard stop) recorded on this session,
   * oldest first. Persisted so CSV can join stop outcomes to sessions. */
  stopEvents?: StopEventRecord[];
}

/** Compact boundary marker — written to the transcript when a host-side
 * /compact summarizes the conversation and respawns the backend at the
 * same CB session id. Renders as a divider (never a bubble) between the
 * pre-compact scrollback and the post-compact continuation; on reload the
 * persisted record replays both segments around the divider. */
export interface CompactMarker {
  /** Epoch-ms when the compact completed (marker append time). */
  at: number;
  /** Input-token level just before the compact (from the last usage event),
   * when known — lets the divider say what was reclaimed. */
  preTokens?: number;
  /** First ~200 chars of the generated summary, for the divider tooltip.
   * The full summary travels to the agent as the next-prompt primer and
   * is auditable via the contextInjected card, not stored here. */
  summaryPreview: string;
  /** User's `/compact <focus>` instructions, when given. */
  instructions?: string;
}

/** One stop-governor trip: which budget fired, what the counters were. */
export interface StopEventRecord {
  at: number;
  budget: 'toolCalls' | 'wallClock' | 'estUsd';
  action: 'warn' | 'stop';
  /** The configured limit that was crossed (calls, ms, or USD). */
  limit: number;
  toolCalls: number;
  /** Active (in-turn) wall-clock ms at trip time. */
  activeMs: number;
  estUsd?: number;
  /** Last few tool titles before the trip, oldest first. */
  lastTools: string[];
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
  /** Performance debug level from `codeBuild.perfDebug`. */
  perfDebug?: 'off' | 'hud' | 'full';
  /** Voice feature config snapshot (settings → webview). */
  voice?: VoiceHydrateConfig;
  /** Effective stall auto-cancel for this session (seconds). `0` = warn-only. */
  stallAutoCancelSeconds?: number;
}

/** Voice settings + capability flags sent on hydrate. */
export interface VoiceHydrateConfig {
  enabled: boolean;
  ttsEngine: 'webview' | 'system' | 'auto' | 'off';
  ttsEnabled: boolean;
  lang: string;
  utteranceEndMs: number;
  /** Host will use macOS `say` (or similar) when true. */
  hostSpeaks: boolean;
  /** Default system voice name for `say` (optional). */
  systemVoice?: string;
  /**
   * Resolved STT path for this machine.
   * - host: extension-host STT (macOS Speech) — preferred; uses OS mic grant
   * - webview: browser Web Speech inside the sandboxed iframe (often blocked)
   * - off: STT disabled
   */
  sttEngine: 'host' | 'webview' | 'off';
  /** True when host STT binary/source can run on this OS (currently darwin). */
  hostSttAvailable: boolean;
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
  /** Per-session stall auto-cancel override (seconds). `0` = warn-only, never auto-stop. */
  | { type: 'setStallTimeout'; seconds: number }
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
  /** Files dropped onto the chat from the Explorer (or OS). `uris` are raw
   * `file://` strings; the host maps them to workspace-relative paths and
   * base64-encodes images, replying with `droppedFilesResolved`. */
  | { type: 'resolveDroppedUris'; uris: string[] }
  | { type: 'listSessions' }
  /** Resume a session by id. When `source` is set to 'claude' or 'grok',
   * the host loads the upstream transcript (cwd is required to locate it)
   * instead of looking in the local ~/.codebuild store. Older callers that
   * only send `id` continue to work and are treated as local. */
  | { type: 'resumeSession'; id: string; source?: SessionSource; cwd?: string }
  /** User's click on an AskUserQuestion option card. The host translates
   * this into the upstream tool_result the backend is waiting for. */
  | { type: 'askUserAnswer'; toolCallId: string; answers: Record<string, string> }
  /** Webview paint / reduce samples while busy (perf debug). */
  | {
      type: 'perfSample';
      samples: Array<{ t: number; renderMs: number; items: number; paintLagMs?: number }>;
    }
  /** Toggle the in-chat Session Performance panel. */
  | { type: 'togglePerfPanel' }
  /** Request a full perf snapshot (panel refresh / /perf). */
  | { type: 'requestPerfSnapshot' }
  /** Copy flight report to clipboard (host-side). */
  | { type: 'copyPerfReport' }
  /** Write ~/.codebuild/sessions/<id>.perf.json and reveal it. */
  | { type: 'exportPerf' }
  /** /handoff — write a structured HANDOFF.md pack for continuing this
   * work on another backend. */
  | { type: 'handoff' }
  /** /compact [focus] — summarize the transcript and respawn the backend at
   * the same CB session id with a summary primer (host-side for all
   * backends; never forwarded to the agent as prompt text). `focus` is the
   * optional user steer for the summary. Host handler lands with the
   * compact verb slice; the marker plumbing (CompactMarker + compactMarker
   * event + persistence) is already wired. */
  | { type: 'compact'; focus?: string }
  /** Start a Voice Ideation Session (new chat + VIS preamble + KP bias). */
  | { type: 'startVoiceIdeation'; backend?: BackendId }
  /** End VIS: send close prompt and parse/write KP objects from the reply. */
  | { type: 'endVoiceIdeation' }
  /** Ask host to speak text (system TTS path). */
  | { type: 'ttsSpeak'; text: string }
  | { type: 'ttsStop' }
  /** Webview reports voice UI mode for status bar / debugging. */
  | { type: 'voiceModeChanged'; mode: VoiceMode }
  /** Start host-side STT (macOS Speech / future backends). */
  | { type: 'sttStart'; lang?: string }
  | { type: 'sttStop' };

// ---- Host -> Webview events ----
/** Compact HUD fields for the chat header. */
export interface PerfHudMsg {
  enabled: boolean;
  ttfeMs?: number;
  ttftMs?: number;
  hostTaxMs: number;
  eventsPerSec?: number;
  paintLagMs?: number;
  openTools: number;
  phase: string;
}

/** One segment of the activity strip (relative to turn start). */
export interface ActivitySegmentMsg {
  kind: 'think' | 'text' | 'tool' | 'wait' | 'error' | 'idle';
  label: string;
  startMs: number;
  endMs: number;
  toolCallId?: string;
}

/** Full snapshot for the Performance panel / event inspector. */
export interface PerfSnapshotMsg {
  mode: 'off' | 'hud' | 'full';
  sessionId?: string;
  backend?: string;
  model?: string;
  modePerm?: string;
  currentTurn?: {
    turnId: string;
    promptSentAt: number;
    firstEventAt?: number;
    firstTokenAt?: number;
    firstThoughtAt?: number;
    firstToolAt?: number;
    resultAt?: number;
    eventCount: number;
    byKind: Record<string, number>;
    diskWriteCount: number;
    diskMsTotal: number;
    maxDiskMs: number;
    ipcPostCount: number;
    ipcBatchMax: number;
    silenceMaxMs: number;
    openToolsMax: number;
    segments: ActivitySegmentMsg[];
    paintLagMs?: number;
    renderMsAvg?: number;
    itemsAtEnd?: number;
  };
  previousTurns: PerfSnapshotMsg['currentTurn'][];
  eventRing: Array<{
    t: number;
    kind: string;
    preview: string;
    bytes: number;
    diskMs?: number;
    rawPreview?: string;
  }>;
  dualStore?: {
    codebuildPath?: string;
    codebuildBytes?: number;
    codebuildMtimeMs?: number;
    claudePath?: string;
    claudeBytes?: number;
    claudeMtimeMs?: number;
  };
  hud: PerfHudMsg;
  flightReport: string;
}

export type HostToWebview =
  | { type: 'hydrate'; state: HydrateState }
  | { type: 'sessionUpdate'; sessionId: string; update: SessionUpdate }
  /** Batched stream updates (IPC coalesce, 16–32ms window). */
  | { type: 'sessionUpdates'; sessionId: string; updates: SessionUpdate[] }
  | { type: 'sessionMeta'; session: SessionMeta }
  | { type: 'busy'; busy: boolean }
  /** Host confirms the effective stall auto-cancel after a picker change. */
  | { type: 'stallTimeout'; seconds: number }
  | { type: 'perfHud'; hud: PerfHudMsg }
  | { type: 'activityStrip'; segments: ActivitySegmentMsg[]; turnDurationMs: number }
  | { type: 'perfSnapshot'; snapshot: PerfSnapshotMsg }
  | { type: 'perfPanelOpen'; open: boolean }
  | { type: 'fileSuggestions'; suggestions: Array<{ path: string; label?: string }> }
  /** Resolution of a `resolveDroppedUris` request. Non-image items carry a
   * workspace-relative `path` to insert as `@path`; image items carry base64
   * `data` + `mimeType` to attach as a tile (like paste). */
  | {
      type: 'droppedFilesResolved';
      items: Array<{ path: string; isImage: boolean; mimeType?: string; data?: string; name?: string }>;
    }
  | { type: 'sessionsList'; sessions: SessionMeta[] }
  | { type: 'historyLoaded'; meta: SessionMeta; records: Array<{ type: string; text?: string; update?: SessionUpdate; marker?: CompactMarker }> }
  /** A compact completed on the live session — append the divider to the
   * timeline. Reload replay comes from the persisted `compact` transcript
   * record via `historyLoaded`, not this event. */
  | { type: 'compactMarker'; marker: CompactMarker }
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
    }
  /** Host finished system TTS (or failed). Webview resumes listen. */
  | { type: 'ttsDone'; ok: boolean; error?: string }
  /** Host-driven voice command (palette / keybinding). */
  | {
      type: 'voiceCommand';
      action:
        | 'toggleDictation'
        | 'toggleInteractive'
        | 'startVis'
        | 'endVis'
        | 'stopVoice';
    }
  /** VIS lifecycle notice for the webview badge. */
  | { type: 'voiceIdeationState'; active: boolean; sessionId?: string }
  /** Host STT transcript chunk (interim or final). */
  | { type: 'sttResult'; transcript: string; isFinal: boolean }
  /** Host STT lifecycle / errors. */
  | {
      type: 'sttStatus';
      status: 'idle' | 'listening' | 'error' | 'unsupported' | 'starting';
      detail?: string;
    };

export function isWebviewToHost(msg: unknown): msg is WebviewToHost {
  return typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string';
}
