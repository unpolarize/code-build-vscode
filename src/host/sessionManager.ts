import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type { BackendId, ContentBlock, PermissionMode, SessionUpdate } from '../shared/acpTypes';
import {
  classifyBackendError,
  isFailoverClass,
  type BackendErrorClass
} from '../shared/backendErrorClass';
import {
  buildFailoverOffer,
  FAILOVER_DEFAULT_LAST_N,
  type FailoverOffer
} from '../shared/failoverOffer';
import type {
  BackendSessionTransitionReason,
  HydrateState,
  SessionMeta,
  SessionSource,
  StopEventRecord,
  WebviewToHost
} from '../shared/protocol';
import { applyBackendSessionId } from './backendIdentity';
import {
  buildCompactMarker,
  buildCompactPrimer,
  compactBlockReason,
  foldUsageCost,
  hasCompactableTurns,
  lastCostUsdFromRecords,
  prepareCompactLineage,
  resolveRespawnResumeId
} from './compact';
import { cleanCommandText } from '../shared/cleanCommandText';
import { NowLineTracker } from '../shared/nowLine';
import {
  AUTO_EDUCATE_DISMISSED_KEY,
  AUTO_MODE_DOCS_URL,
  isPermissionMode,
  PIN_UNSUPPORTED_WARNED_KEY,
  PINNED_PERMISSION_MODE_KEY,
  resolveEffectivePermissionMode,
  shouldShowAutoEducateBanner
} from '../shared/permissionModes';
import {
  parseVisClosePayload,
  visClosePrompt,
  visFacilitationPreamble,
  type SessionKind
} from '../shared/voiceIdeation';
import { resolveTtsEngine, speakWithSay, stopSay } from './voice/ttsHost';
import { HostSttSession, isHostSttSupported, resolveSttEngine } from './voice/sttHost';
import {
  engineUnavailableDetail,
  webviewSttEngine,
  type SttAvailability,
  type SttEnginePref
} from './voice/sttResolve';
import { XaiSttSession } from './voice/xaiSttSession';
import { TranscribeSttSession, isTranscribeCredsLikely } from './voice/transcribeStt';
import { resolveXaiCreds, xaiCredsLikely } from './voice/grokAuth';
import { isMicCaptureSupported } from './voice/micCapture';
import { isKpConfigured, writeVisClosePayload } from './voice/kpWrite';
import type { ChatSurface } from './webviewHtml';
import { detectAll, detectBackend, BACKENDS, resolveBin, claudeFamilyAlias, modelsFor } from './backendRegistry';
import type { AgentSession } from './agentSession';
import { createSession } from './transports/factory';
import { EditorTools } from './editorBridge/editorTools';
import { buildSuggestGlob, rankFileSuggestions, isImagePath } from './fileSuggest';
import { SessionStore, hasVisibleReplayRecords } from './persistence/store';
import { LAST_SESSION_KEY, sessionMatchesWorkspace } from './lastSession';
import { daemonAppend, daemonCreate, daemonHello, daemonPatchMeta } from './daemonClient';
import { readOsClipboardImage } from './clipboardImage';
import {
  claudeJsonlPathFor,
  grokChatPathFor,
  loadClaudeHistory,
  loadGrokHistory,
  locateGrokChatHistory
} from './persistence/externalReplay';
import { listAllSessions } from './persistence/externalSources';
import {
  serializeConversation,
  serializeHybridConversation,
  serializeSelfResumePrimer,
  buildTranscriptForSummary,
  countUserTurns,
  type PrimerMode
} from './persistence/conversationSerializer';
import { buildHandoffPack, formatHandoffPackPrimer } from './persistence/handoffPack';
import {
  exportToClaudeJsonl,
  exportToMarkdown,
  exportHasTurns,
  type ExportRecord
} from './persistence/jsonlExporter';
import { spawn, fork, type ChildProcess } from 'node:child_process';
import {
  replayTranscriptFile,
  type ReplayEvent,
  type ReplayRecord
} from './persistence/transcriptReplay';
import { classifyTurn } from './classifier';
import { scanMemorySources, summariseSources } from './memoryScan';
import { TurnWatchdog } from './turnWatchdog';
import { StopGovernor, type GovernorConfig, type GovernorTrip } from './stopGovernor';
import {
  DEFAULT_MEDIA_TOOL_TAX_CONFIG,
  MEDIA_TAX_DOM_HINT,
  MEDIA_TAX_PREFER_DOM_INJECT,
  MediaToolTaxTracker,
  type MediaToolTaxChip,
  type MediaToolTaxConfig
} from '../shared/mediaToolTax';
import { WriteCheckpointEngine } from './writeCheckpoint';
import { createPathGuard } from './pathGuard';
import {
  SessionPerfCollector,
  type PerfDebugMode
} from './perf/sessionPerf';
import * as fsSync from 'node:fs';
import { startSpan, type Span } from './hostTrace';

/** Last `detectAll` result so a new panel can paint before `which`×N. */
let cachedBackends: HydrateState['backends'] = [];

/** Shared Output channel for the flight recorder (one per extension host). */
let perfOutput: vscode.OutputChannel | undefined;
function getPerfOutput(): vscode.OutputChannel {
  if (!perfOutput) {
    perfOutput = vscode.window.createOutputChannel('Code Build: Flight Recorder');
  }
  return perfOutput;
}

/**
 * Owns one chat panel + its live AgentSession. (P5 will generalize to N panels.)
 * Routes webview commands to the session and session events back to the webview.
 */
export class SessionManager {
  private session?: AgentSession;
  private meta?: SessionMeta;
  /** Child that streams JSONL off the extension host (issue #24). */
  private replayChild?: ChildProcess;
  /** Byte offset of the oldest record currently in the webview. 0 = no older. */
  private historyOlderFrom = 0;
  private historyOlderBusy = false;
  private unsubscribe?: () => void;
  private titled = false;
  private pendingResumeId?: string;
  /** When set, the queued resume loads transcript only (no agent spawn). */
  private pendingResumeConnect?: boolean;
  /**
   * Transcript is on screen but the agent process is not running. Set after a
   * VS Code remount / sidebar restore so we don't auto-spawn and stamp
   * "Starting … agent" as if work just began. First prompt connects.
   */
  private idleResume = false;
  private webviewReady = false;
  private readonly editor = new EditorTools();
  private readonly store = new SessionStore();
  private readonly perf = new SessionPerfCollector();
  /** Write-checkpoint engine for the ACTIVE session (lazily rebuilt when
   * the session id changes — resume loads the persisted index from disk). */
  private checkpoints?: WriteCheckpointEngine;
  private checkpointsSessionId?: string;
  /** Coalesced SessionUpdates waiting for the next IPC flush. */
  private ipcQueue: SessionUpdate[] = [];
  private ipcTimer: ReturnType<typeof setTimeout> | undefined;
  private ipcSessionId?: string;
  /** Live duration of the open perf panel (webviews asks for snapshots). */
  private perfPanelOpen = false;
  private perfHudTimer: ReturnType<typeof setInterval> | undefined;

  /** Records captured from the OLD session right before a backend switch,
   * held until the user answers the carry-over prompt. `sourceBackendId`
   * is the actual BackendId (not the display label) so we know which
   * CLI to fork when the user picks the hybrid (LLM-summary) option. */
  private handoffRecords?: {
    records: { type: string; text?: string; update?: any }[];
    fromBackend: string;
    sourceBackendId: BackendId;
    sourceModel?: string;
  };
  /** Text primer to prepend to the user's NEXT prompt (one-shot). Set when
   * the user chooses Full/Summary in the carry-over banner. */
  private pendingPrimer?: string;
  /** Primer held in RESERVE while we attempt a native resume. When the
   * transport reports `resume_fallback` (Grok session/load rejected, so
   * the agent came up fresh with zero memory), this is promoted to
   * pendingPrimer so the user's first message still carries the
   * conversation context. Unused (and harmless) when the native resume
   * succeeds. */
  private fallbackPrimer?: string;
  /** True from the moment the user clicks the backend dropdown until
   * the carry-over decision is fully applied (incl. async LLM
   * summarisation). Used to hold a user prompt across the entire
   * window — without this latch, a user who immediately types & sends
   * after switching backends slips a context-less message through
   * before the banner even renders. The queued blocks are flushed in
   * finishPrimerDecision once the primer is ready. */
  private primerPending = false;
  /** Blocks held while `primerPending` is true. Flushed on completion. */
  private queuedPromptBlocks?: ContentBlock[];

  /**
   * Pending overload/unavailable failover confirm (v1 always asks). Cleared
   * on dismiss, accept, or new session. Debounces repeat offers for the
   * same failing primary within one burst.
   */
  private pendingFailover?: FailoverOffer;

  /** Per-backend memory of the most recent session id used in THIS chat
   * panel. When the user flips claude → grok → claude, we restore the
   * original claude session (with full transcript + native --resume)
   * instead of spawning a fresh blank one. Cleared on `/new` and on
   * panel teardown. The "no new messages were added" intent from
   * notes.md is best served by simply restoring: if the user typed
   * something in grok, they can still flip back to the original
   * claude — both threads are preserved on disk in ~/.codebuild and
   * surface in the history picker either way. */
  private previousSessionByBackend = new Map<BackendId, string>();

  /** 0-based count of user prompts sent in the current session. The
   * end-of-turn classifier uses this as the `turnIndex` so the
   * webview can map labels back to the right user bubble even when
   * the classify call returns out-of-order or after a few seconds.
   * Reset on openSession / loadExistingSession. */
  private userTurnsSent = 0;
  /** Buffered text of the most recent USER prompt — fed to the
   * classifier on the next `result` event. */
  private lastUserText = '';
  /** Buffered text of assistant chunks during the current turn —
   * accumulated as agent_message_chunk events fire, harvested on
   * `result`, then cleared. */
  private currentAssistantBuf = '';
  /** Cleanup for the "still waiting" follow-up timer on startup notices.
   * Invoked when the first agent event arrives or the session is torn
   * down, so the timer doesn't fire after we're already responsive. */
  private startupNoticeCleanup?: () => void;

  /** Per-turn stall watchdog (D1). Armed when a prompt is sent, reset on
   * real agent progress, cleared on result/error. Surfaces a "looks stuck"
   * notice and — as a backstop so the UI never stays frozen — auto-cancels
   * a silent, tool-less turn. Rebuilt each prompt so the thresholds pick up
   * config changes. */
  private watchdog?: TurnWatchdog;
  /** Last input-token level the backend reported (usage/result events) —
   * feeds CompactMarker.preTokens so the /compact divider can say what it
   * reclaimed. Reset on openSession (fresh conversation). */
  private lastInputTokens?: number;
  /** Tool-call ids the agent has opened but not yet finished this turn. A
   * turn with an open tool is doing a (possibly long, silent) command, so
   * the watchdog warns but does NOT auto-cancel it. */
  private readonly openToolCalls = new Set<string>();
  /** Progressive tool-activity narration (quiet-backend feel-speed).
   * Posts `{verb, target, startedAtMs}` only on tool open/close
   * transitions; the webview owns the 1 Hz elapsed tick. Gated by
   * `codeBuild.progressiveActivity`, re-read per transition so live
   * setting changes apply without reload (perfDebug pattern). */
  private readonly nowLine = new NowLineTracker({
    post: (now) => this.panel.post({ type: 'nowLine', now }),
    isEnabled: () => this.progressiveActivityEnabled()
  });
  /** True while a permission_request is outstanding (the agent is blocked on a
   * human decision). Combined with pending AskUserQuestions, this tells the
   * stall watchdog the turn is legitimately paused on the user, not stuck. */
  private awaitingPermission = false;
  /** Per-session stall auto-cancel override (seconds). Undefined = use setting. */
  private stallAutoCancelOverride: number | undefined;
  /** Per-session stop governor — tool-call / active-time / spend budgets that
   * warn (default) or hard-cancel a runaway session. Rebuilt when the session
   * id changes so counters never leak across sessions. */
  private governor?: StopGovernor;
  /** Session id the current governor instance belongs to. */
  private governorSessionId: string | undefined;
  /** Runtime media/pixel tool-tax meter (post-tool payloads; not MCP schemas). */
  private mediaTax = new MediaToolTaxTracker();
  /** Session id the current media-tax tracker belongs to. */
  private mediaTaxSessionId: string | undefined;
  /** Last media-tax chip signature posted to the webview (dedupe). */
  private mediaTaxLastPosted: string | undefined;
  /** Session-sticky Prefer DOM/CLI host hint (armed by one-click action). */
  private preferDomHintArmed = false;
  /** Active Voice Ideation Session — forces KP MCP and close-payload parsing. */
  private voiceIdeationActive = false;
  /** After endVoiceIdeation, parse the next assistant result for KP JSON. */
  private visAwaitingCloseResult = false;
  /** Pending openSession options (session kind / force KP). */
  private pendingOpenOpts: { sessionKind?: SessionKind; forceKp?: boolean } = {};
  /** Host-side STT session (macOS Speech helper), if listening. */
  private hostStt: { stop(): void } | undefined;

  constructor(
    private readonly panel: ChatSurface,
    private readonly context: vscode.ExtensionContext,
    private openSpan?: Span
  ) {
    this.panel.onMessage((msg) => void this.handle(msg));
  }

  /** Let extension commands (toggle perf, copy report) inject webview-shaped messages. */
  postWebviewCommand(msg: WebviewToHost): void {
    void this.handle(msg);
  }

  /** Called from Code Sessions rename so the panel tab matches the tree title. */
  applyExternalTitle(id: string | undefined, title: string): boolean {
    const t = title.trim();
    if (!t) return false;
    if (!this.meta) return false;
    // Issue #16: a falsy id must NOT rename an arbitrary live panel; and the
    // caller (CSV) passes the NATIVE session uuid, which for CB-born sessions
    // differs from the local id — match backendSessionId/history too.
    if (!id) return false;
    const owns =
      this.meta.id === id ||
      this.meta.backendSessionId === id ||
      (this.meta.backendSessionHistory ?? []).some((h) => h.id === id);
    if (!owns) return false;
    this.meta.title = t;
    this.store.updateMeta(this.meta);
    this.panel.setTitle?.(t);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    return true;
  }

  /** Push a host→webview event (voice keybindings, etc.). */
  postHostEvent(msg: import('../shared/protocol').HostToWebview): void {
    this.panel.post(msg);
  }

  /** Daemon visibility (spec R2/R4): chip in the webview header shows
   * connected + version, or that persistence is on the local fallback. */
  private async postDaemonStatus(): Promise<void> {
    try {
      const hello = await daemonHello();
      this.panel.post(
        hello
          ? { type: 'daemonStatus', up: true, version: hello.daemonVersion }
          : { type: 'daemonStatus', up: false, error: 'daemon unreachable — sessions persist to ~/.codebuild only' }
      );
    } catch (e) {
      this.panel.post({
        type: 'daemonStatus',
        up: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  private get config() {
    return vscode.workspace.getConfiguration('codeBuild');
  }

  private get cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.webviewReady = true;
        if (!this.openSpan) this.openSpan = startSpan('cb.hydrate');
        this.openSpan.mark('webview.ready');
        // Transcript first. hydrate() does not clear items, and detectAll
        // (`which` × N) used to sit in front of historyLoaded so a restored
        // chat stayed empty until backends resolved. Keep pendingResumeId
        // set through hydrate() so autoStart does not spawn a fresh session.
        if (this.pendingResumeId) {
          const id = this.pendingResumeId;
          const connect = this.pendingResumeConnect ?? true;
          // Returns after chrome + child fork; does not wait for 200 MB parse.
          await this.loadExistingSession(id, { connect });
          this.openSpan?.mark('resume.start');
        } else if (this.pendingExternal) {
          await this.openExternalSession(this.pendingExternal);
          this.openSpan?.mark('external.load');
        }
        await this.hydrate();
        void this.postDaemonStatus();
        this.pendingResumeId = undefined;
        this.pendingResumeConnect = undefined;
        this.pendingExternal = undefined;
        this.openSpan?.end();
        this.openSpan = undefined;
        break;
      case 'loadOlderHistory':
        this.loadOlderHistory();
        break;
      case 'getFileSuggestions': {
        const suggestions = await this.getFileSuggestions(msg.query);
        this.panel.post({ type: 'fileSuggestions', suggestions });
        break;
      }
      case 'resolveDroppedUris': {
        const items = await this.resolveDroppedUris(msg.uris);
        this.panel.post({ type: 'droppedFilesResolved', items });
        break;
      }
      case 'readClipboardImage': {
        const img = await readOsClipboardImage();
        if (img) {
          this.panel.post({ type: 'clipboardImage', mimeType: img.mimeType, data: img.data, name: img.name });
        } else {
          this.panel.post({ type: 'clipboardText', text: msg.fallbackText ?? '' });
        }
        break;
      }
      case 'newSession':
        // Fresh slate — clear the per-backend restore memory so the
        // new chat doesn't accidentally inherit any prior thread.
        this.previousSessionByBackend.clear();
        this.clearFailoverOffer();
        this.idleResume = false;
        await this.openSession(msg.backend);
        break;
      case 'pickBackend':
        await this.switchBackend(msg.backend);
        break;
      case 'primerDecision':
        void this.applyPrimerDecision(msg.choice, msg.lastNTurns);
        break;
      case 'failoverDecision':
        void this.applyFailoverDecision(msg.accept, msg.backend);
        break;
      case 'askUserAnswer':
        this.answerAskUserQuestion(msg.toolCallId, msg.answers);
        break;
      case 'setStallTimeout':
        this.setStallTimeout(msg.seconds);
        break;
      case 'prompt': {
        // Hold the user's prompt while a cross-backend handoff is in
        // flight. Covers the entire window: from the moment the user
        // picks the new backend (handoffRecords latched in
        // switchBackend, BEFORE the spawn) through the banner click
        // through the async LLM summarisation. Without this, a user
        // who types and sends immediately after switching backends
        // slipped a context-less message through before the primer
        // could ever be set. finishPrimerDecision() flushes the queue
        // once the primer is ready (or once 'Start fresh' is picked).
        if (this.primerPending) {
          this.queuedPromptBlocks = msg.blocks;
          this.panel.post({
            type: 'notice',
            text: this.handoffRecords
              ? `Holding your message — pick a carry-over option above first. Your message goes out the moment you choose.`
              : `Holding your message until the source-backend summary is ready — it'll go out together with the carry-over primer.`,
            detail: `The host queued your blocks because a cross-backend handoff is in progress. Pick a primer mode on the banner (or wait for summary to complete) and your message will be released with the primer prepended.`
          });
          break;
        }
        // Busy first so the working pill stays up while idle-reconnect
        // spawns the CLI (session.start can take several seconds).
        this.panel.post({ type: 'busy', busy: true });
        await this.ensureSession();
        // Arm the stall watchdog for this turn (D1). The silence clock starts
        // now, at submission, so a turn that produces NO output at all (the
        // claude `error_during_execution`/0-token stall) is still caught.
        this.armWatchdog();
        this.perf.onPromptSent();
        this.perf.setSessionMeta({
          sessionId: this.meta?.id,
          backend: this.meta?.backend,
          model: this.meta?.model,
          modePerm: this.meta?.mode
        });
        this.pushPerfHud();
        const originalText = msg.blocks.find((b) => b.type === 'text')?.text ?? '';
        const images = msg.blocks
          .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
          .map((b) => ({ mimeType: b.mimeType, data: b.data }));
        if (originalText || images.length > 0) {
          // First real prompt: promote to history + derive a title from it.
          this.commitAndTitle(originalText || '(image)');
          this.store.appendUserText(
            this.meta!.id,
            originalText,
            Date.now(),
            images.length > 0 ? images : undefined
          );
          void daemonAppend(this.meta!.id, { type: 'user', text: originalText });
        }
        // Stash for the classifier (paired with the upcoming
        // assistant text on the next `result`). Bumps turnIndex AFTER
        // assignment so the count matches the webview's 0-based
        // user-bubble index in the items list.
        this.lastUserText = originalText;
        this.currentAssistantBuf = '';
        const enriched = await this.enrichBlocksWithFileMentions(msg.blocks, this.cwd);
        // Wait for the transport handshake to settle BEFORE snapshotting
        // the primer. A prompt sent while "Resuming…" is still in flight
        // would otherwise capture pendingPrimer before a resume_fallback
        // promotes the reserve primer — the first message would go out
        // contextless and the primer would misfire on the second. ready()
        // never rejects (handshake errors surface via the event stream)
        // and is instant once the session is up.
        await this.session!.ready();
        let blocks = enriched;
        const usedPrimer = this.pendingPrimer;
        // One-shot context handoff: if the user switched backend and chose to
        // carry context, prepend the serialized prior conversation as a
        // leading text block, then clear it so it's only sent once.
        if (this.pendingPrimer) {
          blocks = [{ type: 'text', text: this.pendingPrimer }, ...blocks];
          this.pendingPrimer = undefined;
        }
        // Session-sticky Prefer DOM/CLI hint (media-tax one-click). Advisory
        // only — never rewrites or blocks tools.
        if (this.preferDomHintArmed) {
          blocks = [{ type: 'text', text: MEDIA_TAX_PREFER_DOM_INJECT }, ...blocks];
        }
        // Transparency: surface exactly what we just injected into the
        // agent's stdin BEFORE writing it. Without this, a 12K primer or
        // a mis-resolved @-mention can silently steer a turn and the
        // user has no signal. See HostToWebview.contextInjected.
        this.emitContextInjectedForPrompt({
          originalBlocks: msg.blocks,
          enrichedBlocks: enriched,
          finalBlocks: blocks,
          primer: usedPrimer
        });
        // Fire-and-forget so the message handler can pick up the NEXT prompt
        // immediately. This is what enables mid-stream steering — a second
        // 'prompt' message (interjected) from the webview runs through here
        // without waiting for the previous prompt's promise to resolve. For
        // claude stream-json that means writing two `user` lines on stdin
        // back-to-back (claude queues them); for grok ACP it means two
        // overlapping session/prompt JSON-RPC calls (grok queues them at the
        // protocol layer). Errors still surface via .catch.
        this.session!.prompt(blocks).catch((err) => {
          // Route through the same path as transport-emitted errors so
          // errorClass tagging + overload failover offer both fire.
          const message = String(err);
          this.routeAgentUpdate(this.meta!.id, {
            kind: 'error',
            message,
            errorClass: classifyBackendError(message)
          });
        });
        break;
      }
      case 'cancel':
        this.session?.cancel();
        this.flushIpcImmediate();
        this.perf.onCancel();
        // A soft ACP cancel may never emit result/error — take the
        // now-line down explicitly (busy:false alone leaves it stuck).
        this.nowLine.clear();
        this.panel.post({ type: 'busy', busy: false });
        this.pushPerfHud();
        break;
      case 'preferDomHint':
        this.armPreferDomHint();
        break;
      case 'setMode':
        this.setMode(msg.mode);
        break;
      case 'pinMode':
        this.pinMode(msg.mode);
        break;
      case 'unpinMode':
        this.unpinMode();
        break;
      case 'setModel':
        this.setModel(msg.model);
        break;
      case 'setEffort':
        this.setEffort(msg.effort);
        break;
      case 'respondPermission':
        this.session?.respondPermission(msg.requestId, msg.outcome);
        // Resume normal stall watching only once EVERY queued permission is
        // answered — with concurrent requests, one decision may leave more.
        this.awaitingPermission = this.session?.hasPendingPermissions() ?? false;
        break;
      case 'openDiff':
        await this.editor.openDiff(msg.path, msg.oldText, msg.newText);
        break;
      case 'restoreCheckpoint':
        await this.handleRestoreCheckpoint(msg.toolCallId);
        break;
      case 'revealLocation':
        await this.editor.revealLocation(msg.path, msg.line);
        break;
      case 'openInCodeSessions':
        if (this.meta) {
          await vscode.commands.executeCommand('codeBuild.openInCodeSessions', this.meta.id);
        }
        break;
      case 'openInNewTab':
        await vscode.commands.executeCommand('codeBuild.openInNewTab');
        break;
      case 'openInNewWindow':
        await vscode.commands.executeCommand('codeBuild.openInNewWindow');
        break;
      case 'listSessions': {
        // Merge local ~/.codebuild rows with claude (~/.claude/projects) and
        // grok (~/.grok/sessions). listAllSessions already sorts newest-first
        // by mtime which is "last response from agent" for upstream transcripts
        // (the CLI bumps the JSONL on every assistant write) and last-write
        // for local ones.
        const merged = listAllSessions(this.store.list()).slice(0, 300);
        this.panel.post({ type: 'sessionsList', sessions: merged });
        break;
      }
      case 'resumeSession':
        if (msg.source && (msg.source === 'claude' || msg.source === 'grok') && msg.cwd) {
          await this.openExternalSession({
            source: msg.source,
            sessionId: msg.id,
            cwd: msg.cwd
          });
        } else {
          await this.loadExistingSession(msg.id);
        }
        break;
      case 'perfSample': {
        for (const s of msg.samples) {
          this.perf.recordWebviewSample(s.paintLagMs, s.renderMs, s.items);
        }
        if (this.perf.mode !== 'off') {
          this.pushPerfHud();
        }
        break;
      }
      case 'togglePerfPanel':
        this.perfPanelOpen = !this.perfPanelOpen;
        this.panel.post({ type: 'perfPanelOpen', open: this.perfPanelOpen });
        if (this.perfPanelOpen) {
          this.refreshDualStore();
          this.panel.post({ type: 'perfSnapshot', snapshot: this.perf.snapshot() });
        }
        break;
      case 'requestPerfSnapshot':
        this.refreshDualStore();
        this.panel.post({ type: 'perfSnapshot', snapshot: this.perf.snapshot() });
        break;
      case 'compact':
        await this.compactSession(msg.focus);
        break;
      case 'handoff':
        await this.writeHandoffPack();
        break;
      case 'copyPerfReport': {
        const report = this.perf.formatFlightReport();
        await vscode.env.clipboard.writeText(report);
        getPerfOutput().appendLine(report);
        getPerfOutput().appendLine('---');
        void vscode.window.showInformationMessage('Code Build: flight report copied to clipboard');
        break;
      }
      case 'exportPerf': {
        if (!this.meta) {
          void vscode.window.showWarningMessage('Code Build: no active session to export perf for');
          break;
        }
        this.refreshDualStore();
        const pkg = this.context.extension.packageJSON as { version?: string };
        const data = this.perf.toExportJson(pkg.version ?? '0.0.0');
        const outPath = this.store.writePerfExport(this.meta.id, data);
        getPerfOutput().appendLine(`Exported perf → ${outPath}`);
        void vscode.window.showInformationMessage(`Perf exported: ${outPath}`, 'Reveal').then((c) => {
          if (c === 'Reveal') {
            void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outPath));
          }
        });
        break;
      }
      case 'startVoiceIdeation':
        await this.startVoiceIdeation(msg.backend);
        break;
      case 'endVoiceIdeation':
        await this.endVoiceIdeation();
        break;
      case 'ttsSpeak':
        await this.hostSpeak(msg.text);
        break;
      case 'ttsStop':
        stopSay();
        this.panel.post({ type: 'ttsDone', ok: true });
        break;
      case 'voiceModeChanged':
        // Reserved for status-bar / telemetry; no-op for now.
        break;
      case 'sttStart':
        await this.hostSttStart(msg.lang);
        break;
      case 'sttStop':
        this.hostSttStop();
        break;
    }
  }

  /** Snapshot voice settings for the webview. */
  private voiceHydrateConfig(): HydrateState['voice'] {
    const enabled = this.config.get<boolean>('voice.enabled', true);
    const ttsEngine = resolveTtsEngine(
      this.config.get<'webview' | 'system' | 'auto' | 'off'>('voice.ttsEngine', 'auto')
    );
    const configured = this.config.get<'webview' | 'system' | 'auto' | 'off'>(
      'voice.ttsEngine',
      'auto'
    );
    const sttPref = this.config.get<SttEnginePref>('voice.sttEngine', 'auto');
    const resolved = resolveSttEngine(sttPref, this.sttAvailability());
    const sttEngine = webviewSttEngine(resolved);
    const hostSttAvailable = sttEngine === 'host';
    return {
      enabled,
      ttsEngine: configured,
      ttsEnabled: this.config.get<boolean>('voice.ttsEnabled', true),
      lang: this.config.get<string>('voice.lang', 'en-US') || 'en-US',
      utteranceEndMs: Math.max(
        400,
        this.config.get<number>('voice.utteranceEndMs', 1400) ?? 1400
      ),
      hostSpeaks: ttsEngine === 'system',
      systemVoice: this.config.get<string>('voice.systemVoice', '') || undefined,
      sttEngine,
      hostSttAvailable
    };
  }

  /** Which host STT engines could run on this machine right now. */
  private sttAvailability(): SttAvailability {
    const mic = isMicCaptureSupported();
    return {
      xai: mic && xaiCredsLikely({ settingKey: this.config.get<string>('voice.xaiApiKey', '') }),
      transcribe: mic && isTranscribeCredsLikely(),
      speechExt: isHostSttSupported()
    };
  }

  private async hostSttStart(lang?: string): Promise<void> {
    const sttPref = this.config.get<SttEnginePref>('voice.sttEngine', 'auto');
    const resolved = resolveSttEngine(sttPref, this.sttAvailability());
    const effLang = lang || this.config.get<string>('voice.lang', 'en-US') || 'en-US';
    const handlers = {
      onResult: (r: { transcript: string; isFinal: boolean }) => {
        this.panel.post({
          type: 'sttResult',
          transcript: r.transcript,
          isFinal: r.isFinal
        });
      },
      onStatus: (status: 'idle' | 'listening' | 'error' | 'unsupported' | 'starting', detail?: string) => {
        this.panel.post({ type: 'sttStatus', status, detail });
      }
    };
    this.hostSttStop();

    if (resolved === 'off' || resolved === 'webview') {
      this.panel.post({
        type: 'sttStatus',
        status: 'unsupported',
        detail: engineUnavailableDetail(sttPref)
      });
      return;
    }

    const helperSource = path.join(
      this.context.extensionUri.fsPath,
      'resources',
      'mic',
      'MicCap.swift'
    );
    const storageDir = this.context.globalStorageUri.fsPath;

    if (resolved === 'xai') {
      const creds = resolveXaiCreds({
        settingKey: this.config.get<string>('voice.xaiApiKey', ''),
        env: process.env
      });
      if (!creds) {
        this.panel.post({
          type: 'sttStatus',
          status: 'unsupported',
          detail: engineUnavailableDetail('xai')
        });
        return;
      }
      const session = new XaiSttSession({ lang: effLang, creds, helperSource, storageDir }, handlers);
      this.hostStt = session;
      await session.start();
      return;
    }

    if (resolved === 'transcribe') {
      const session = new TranscribeSttSession(
        {
          lang: effLang,
          region: this.config.get<string>('voice.awsRegion', 'us-west-2') || 'us-west-2',
          profile: this.config.get<string>('voice.awsProfile', '') || undefined,
          helperSource,
          storageDir
        },
        handlers
      );
      this.hostStt = session;
      // start() resolves only when the result stream ends — don't block on it.
      void session.start();
      return;
    }

    const session = new HostSttSession({ lang: effLang, context: this.context }, handlers);
    this.hostStt = session;
    await session.start();
  }

  private hostSttStop(): void {
    if (!this.hostStt) return;
    try {
      this.hostStt.stop();
    } catch {
      /* ignore */
    }
    this.hostStt = undefined;
  }

  private async hostSpeak(text: string): Promise<void> {
    const engine = resolveTtsEngine(
      this.config.get<'webview' | 'system' | 'auto' | 'off'>('voice.ttsEngine', 'auto')
    );
    if (engine !== 'system') {
      this.panel.post({ type: 'ttsDone', ok: true });
      return;
    }
    try {
      const voice = this.config.get<string>('voice.systemVoice', '') || undefined;
      await speakWithSay(text, voice);
      this.panel.post({ type: 'ttsDone', ok: true });
    } catch (e) {
      this.panel.post({
        type: 'ttsDone',
        ok: false,
        error: String(e)
      });
    }
  }

  /** Start a Voice Ideation Session: new chat, VIS kind, preamble, greeting. */
  private async startVoiceIdeation(backend?: BackendId): Promise<void> {
    this.previousSessionByBackend.clear();
    this.pendingOpenOpts = { sessionKind: 'voice-ideation', forceKp: true };
    this.voiceIdeationActive = true;
    this.visAwaitingCloseResult = false;
    await this.openSession(backend);
    if (!this.meta) return;
    this.meta.sessionKind = 'voice-ideation';
    this.meta.title = `VIS · ${this.meta.backend}`;
    this.store.updateMeta(this.meta);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    this.panel.post({
      type: 'voiceIdeationState',
      active: true,
      sessionId: this.meta.id
    });
    // Facilitation contract as one-shot primer on the greeting turn.
    this.pendingPrimer = visFacilitationPreamble(this.meta.id);
    this.panel.post({
      type: 'notice',
      text: 'Voice Ideation Session started — speak freely. Say “close session” or click **End VIS** when done.',
      detail: `session=${this.meta.id}\nKP MCP force-on for ACP backends when codeBuild.kp.command/root are set.\nHost fallback writes KP objects from a final JSON close payload.`
    });
    // Auto-greeting so TTS interactive mode has something to speak first.
    this.panel.post({ type: 'busy', busy: true });
    this.armWatchdog();
    this.perf.onPromptSent();
    const greet =
      "I'm starting a Voice Ideation Session. Please greet me briefly and invite me to ramble about what's on my mind. Keep the reply short and spoken-friendly.";
    // Keep "VIS · backend" title; still commit the session into history.
    if (!this.titled) {
      this.titled = true;
      this.store.commitSession(this.meta);
      this.store.updateMeta(this.meta);
    }
    this.store.appendUserText(this.meta.id, greet);
    this.lastUserText = greet;
    this.currentAssistantBuf = '';
    // Echo user turn into the webview timeline (host-initiated; no local append).
    this.panel.post({
      type: 'sessionUpdate',
      sessionId: this.meta.id,
      update: { kind: 'user_message_chunk', content: { type: 'text', text: greet } }
    });
    await this.session!.ready();
    const primerUsed = this.pendingPrimer;
    const blocks: ContentBlock[] = primerUsed
      ? [
          { type: 'text', text: primerUsed },
          { type: 'text', text: greet }
        ]
      : [{ type: 'text', text: greet }];
    this.pendingPrimer = undefined;
    this.emitContextInjectedForPrompt({
      originalBlocks: [{ type: 'text', text: greet }],
      enrichedBlocks: [{ type: 'text', text: greet }],
      finalBlocks: blocks,
      primer: primerUsed
    });
    this.session!.prompt(blocks).catch((err) => {
      const message = String(err);
      this.routeAgentUpdate(this.meta!.id, {
        kind: 'error',
        message,
        errorClass: classifyBackendError(message)
      });
    });
  }

  /** Send VIS close prompt; on next result, parse JSON and write KP. */
  private async endVoiceIdeation(): Promise<void> {
    if (!this.voiceIdeationActive && this.meta?.sessionKind !== 'voice-ideation') {
      this.panel.post({
        type: 'notice',
        text: 'No Voice Ideation Session is active.'
      });
      return;
    }
    await this.ensureSession();
    if (!this.meta) return;
    this.visAwaitingCloseResult = true;
    this.voiceIdeationActive = true;
    const close = visClosePrompt(this.meta.id);
    this.panel.post({ type: 'busy', busy: true });
    this.armWatchdog();
    this.perf.onPromptSent();
    this.store.appendUserText(this.meta.id, close);
    this.lastUserText = close;
    this.currentAssistantBuf = '';
    this.panel.post({
      type: 'sessionUpdate',
      sessionId: this.meta.id,
      update: { kind: 'user_message_chunk', content: { type: 'text', text: close } }
    });
    await this.session!.ready();
    this.session!.prompt([{ type: 'text', text: close }]).catch((err) => {
      const message = String(err);
      this.routeAgentUpdate(this.meta!.id, {
        kind: 'error',
        message,
        errorClass: classifyBackendError(message)
      });
    });
    this.panel.post({
      type: 'notice',
      text: 'Closing VIS — extracting ideas/thoughts into the knowledge-planning store…'
    });
  }

  /** After a VIS close turn, write KP objects from the assistant payload. */
  private async maybeWriteVisCloseFromAssistant(assistantText: string): Promise<void> {
    this.visAwaitingCloseResult = false;
    const text = assistantText;
    const payload = parseVisClosePayload(text);
    if (!payload) {
      this.panel.post({
        type: 'notice',
        text: 'VIS closed. No structured JSON payload found — if the agent used kp tools, objects may already exist. Otherwise ask it to emit the close JSON fence.'
      });
      this.finishVisState();
      return;
    }
    const cmd = this.config.get<string>('kp.command', '');
    const root =
      this.config.get<string>('kp.root', '') ||
      // Sensible default for this workspace when unset
      (await this.defaultKpRoot());
    if (!isKpConfigured(cmd, root)) {
      this.panel.post({
        type: 'notice',
        text: 'VIS close payload parsed, but KP is not configured (set codeBuild.kp.command + codeBuild.kp.root). Payload summary kept in chat only.',
        detail: JSON.stringify(payload, null, 2).slice(0, 4000)
      });
      this.finishVisState();
      return;
    }
    const result = await writeVisClosePayload(
      {
        command: cmd!,
        root: root!,
        sessionId: this.meta?.id,
        agent: this.meta?.backend,
        model: this.meta?.model
      },
      payload
    );
    const lines: string[] = [];
    if (result.created.length) {
      lines.push(`Created: ${result.created.join(', ')}`);
    } else {
      lines.push('No new KP objects created.');
    }
    if (result.errors.length) {
      lines.push(`Errors: ${result.errors.join('; ')}`);
    }
    if (result.summary) {
      lines.push(`Summary: ${result.summary}`);
    }
    this.panel.post({
      type: 'notice',
      text: `VIS saved to KP — ${lines[0]}`,
      detail: lines.join('\n')
    });
    this.finishVisState();
  }

  private finishVisState(): void {
    this.voiceIdeationActive = false;
    if (this.meta) {
      // Keep sessionKind for history; mark inactive in UI.
      this.panel.post({ type: 'sessionMeta', session: this.meta });
    }
    this.panel.post({ type: 'voiceIdeationState', active: false });
  }

  private async defaultKpRoot(): Promise<string | undefined> {
    // Prefer ~/docs/planning when present (this user's SSOT).
    const candidate = path.join(os.homedir(), 'docs', 'planning');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  private async hydrate(): Promise<void> {
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const allowBypass = this.config.get<boolean>('allowDangerouslySkipPermissions', false);
    const defaultBackend = this.defaultBackend();
    const wsRoots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const memSources = scanMemorySources(wsRoots);
    const memTotals = summariseSources(memSources);
    this.openSpan?.mark('hydrate.memory');
    const sessions = this.store.list().slice(0, 100);
    this.openSpan?.mark('hydrate.list');
    const base = {
      session: this.meta ?? null,
      allowBypass,
      sessions,
      defaultBackend,
      memoryEntries: memTotals.totalEntries,
      memoryFiles: memTotals.totalFiles,
      memoryByProvider: memTotals.byProvider,
      showActiveQuestionBanner: this.config.get<boolean>('showActiveQuestionBanner', true),
      perfDebug: this.perfDebugMode(),
      voice: this.voiceHydrateConfig(),
      stallAutoCancelSeconds: this.effectiveStallAutoCancelSeconds(),
      pinnedPermissionMode: this.getPinnedMode() ?? null
    };
    this.perf.setMode(base.perfDebug ?? 'off');
    this.ensurePerfHudTimer();
    // Paint the panel before `which`×N (detectAll). Warm cache makes the
    // second open instant; first open still shows chrome while binaries resolve.
    this.panel.post({
      type: 'hydrate',
      state: { ...base, backends: cachedBackends } as HydrateState
    });
    this.openSpan?.mark('hydrate.paint');
    const backends = await detectAll(overrides);
    cachedBackends = backends;
    this.openSpan?.mark('hydrate.detectAll');
    this.panel.post({ type: 'hydrate', state: { ...base, backends } as HydrateState });

    const autoStart = this.config.get<boolean>('autoStartSession', true);
    const defaultAvailable = backends.find((b) => b.id === defaultBackend)?.available;
    if (autoStart && !this.session && defaultAvailable && !this.pendingResumeId && !this.pendingExternal) {
      await this.openSession(defaultBackend);
      this.openSpan?.mark('hydrate.openSession');
    }
  }

  private defaultBackend(): BackendId {
    return this.config.get<BackendId>('defaultBackend', 'claude');
  }

  private async ensureSession(): Promise<void> {
    if (this.idleResume && this.meta && !this.session) {
      this.idleResume = false;
      await this.loadExistingSession(this.meta.id, { connect: true, skipReplay: true });
      return;
    }
    if (!this.session) {
      await this.openSession(this.defaultBackend());
    }
  }

  /** Handle the backend dropdown. If the current chat already has content
   * AND the backend actually changes, capture the prior transcript and ask
   * the user whether to carry it over before spinning up the new backend. */
  /** Full transcript for the CURRENT session: for externally-imported
   * claude/grok sessions the real conversation lives in the upstream
   * jsonl (the local store only has post-import activity), so merge
   * upstream + local. Used by both the cross-backend primer capture
   * and the /handoff pack. */
  private collectTranscriptRecords(
    sessionId?: string
  ): { type: string; text?: string; update?: any }[] {
    const id = sessionId ?? this.meta?.id;
    if (!id) return [];
    const records: { type: string; text?: string; update?: any }[] = [];
    const source = this.meta?.source;
    if ((source === 'claude' || source === 'grok') && this.meta?.cwd) {
      try {
        const replay =
          source === 'claude'
            ? loadClaudeHistory(claudeJsonlPathFor(this.meta.cwd, id))
            : loadGrokHistory(grokChatPathFor(this.meta.cwd, id));
        if (replay) records.push(...(replay.records as any));
      } catch {
        /* missing file / parse error — fall through to local store */
      }
    }
    const loaded = this.store.load(id);
    records.push(...loaded.records.filter((r) => r.type !== 'meta'));
    return records;
  }

  /** /compact [focus] — host-side context compaction for ALL backends.
   * Order pinned by the KP task (summarize BEFORE kill; marker durable
   * BEFORE kill; lineage append BEFORE clearing the native id):
   * idle-guard → summarize → append marker + flushSync → lineage/clear →
   * teardown + same-meta.id respawn with NO resume id → primer on the
   * next prompt. Scrollback is never wiped — the marker renders as a
   * divider and the meter may read unknown until the next turn. */
  private async compactSession(focus?: string): Promise<void> {
    const meta = this.meta;
    if (!meta) {
      this.panel.post({ type: 'notice', text: 'No active session to compact.' });
      return;
    }
    const blocked = compactBlockReason({
      turnActive: this.watchdog?.active ?? false,
      openToolCalls: this.openToolCalls.size,
      awaitingPermission:
        this.awaitingPermission || (this.session?.hasPendingPermissions() ?? false),
      pendingQuestions: this.pendingAskUserQuestions.size,
      primerPending: this.primerPending,
      queuedPrompt: this.queuedPromptBlocks !== undefined
    });
    if (blocked) {
      this.panel.post({
        type: 'notice',
        text: `Can't compact yet — ${blocked}. Let it finish (or hit Stop), then run /compact again.`
      });
      return;
    }
    const records = this.collectTranscriptRecords();
    if (!hasCompactableTurns(records)) {
      this.panel.post({
        type: 'notice',
        text: 'Nothing to compact — this conversation has no user turns yet.'
      });
      return;
    }

    // Hold the guard across the (up to 90s) summarize await: primerPending
    // makes the 'prompt' case QUEUE any message sent mid-compact instead of
    // starting a turn the kill would land on; it also makes a second
    // /compact refuse via compactBlockReason. finishPrimerDecision() in the
    // finally releases the queued prompt WITH the compact primer prepended.
    this.primerPending = true;

    const be = backendLabel(meta.backend);
    const useClaude = meta.backend === 'claude';
    this.panel.post({
      type: 'notice',
      text: `Compacting this conversation${focus ? ` (focus: ${focus})` : ''}…`,
      detail: useClaude
        ? `Summarising ${records.length.toLocaleString()} record(s) via a one-shot \`claude -p\` (typically 10–30s), then restarting the ${be} backend at this same session with the summary + last 5 turns as context. Scrollback stays; a divider marks the boundary. Messages sent meanwhile are queued.`
        : `Building a clipped summary locally, then restarting the ${be} backend at this same session with it + the last 5 turns as context. Scrollback stays; a divider marks the boundary. Messages sent meanwhile are queued.`
    });

    try {
      // Session total so far — records are persisted post-fold, so this
      // already includes any earlier compact's base. meta.costBaseUsd as a
      // floor covers the compact-again-before-any-new-cost-report edge.
      const preTotalUsd = Math.max(lastCostUsdFromRecords(records) ?? 0, meta.costBaseUsd ?? 0);

      // Summarize BEFORE any kill. On failure still compact with the clipped
      // fallback + a visible notice — never abort, never a silent no-op.
      let summary: string;
      let summarizeCostUsd = 0;
      try {
        if (useClaude) {
          const r = await this.summarizeViaClaude(records, meta.model, focus, 'compact');
          summary = r.text;
          summarizeCostUsd = r.costUsd ?? 0;
        } else {
          summary = clippedSummaryFallback(records, be);
        }
      } catch (e) {
        summary = clippedSummaryFallback(records, be);
        this.panel.post({
          type: 'notice',
          text: 'LLM summarisation failed — compacting with a clipped summary instead.',
          detail: `Error: ${e instanceof Error ? e.message : String(e)}`
        });
      }

      // Persist the new cost floor BEFORE the kill: the respawned process
      // restarts its total near $0, so from here on every usage/result
      // costUsd is folded (+= costBaseUsd) at the routeAgentUpdate ingress.
      // The synthetic summarize-usage record makes the folded total (incl.
      // the one-shot's spend) durable and visible immediately — a reload
      // replays it, so the HUD never dips below the pre-compact figure.
      const newCostBaseUsd = preTotalUsd + summarizeCostUsd;
      if (newCostBaseUsd > 0) {
        meta.costBaseUsd = newCostBaseUsd;
        this.store.updateMeta(meta);
        const syntheticUsage: SessionUpdate = { kind: 'usage', usage: { costUsd: newCostBaseUsd } };
        this.store.appendUpdate(meta.id, syntheticUsage);
        // Mirror to the daemon store like every routeAgentUpdate event —
        // CSV analytics must see the same non-decreasing cost trail.
        void daemonAppend(meta.id, syntheticUsage);
        this.panel.post({ type: 'sessionUpdate', sessionId: meta.id, update: syntheticUsage });
        this.governor?.noteUsage(newCostBaseUsd);
      }

      // Marker durable BEFORE the kill (appendCompactMarker only enqueues;
      // kill-before-flush would lose the divider).
      const marker = buildCompactMarker({
        now: Date.now(),
        preTokens: this.lastInputTokens,
        summary,
        focus
      });
      this.store.appendCompactMarker(meta.id, marker);
      this.store.flushSync(meta.id);
      this.panel.post({ type: 'compactMarker', marker });
      // The pre-compact level is spent — a later divider must not reuse it.
      this.lastInputTokens = undefined;

      // One-shot primer for the first post-compact prompt. Latched before the
      // respawn — teardownSession never clears pendingPrimer.
      this.pendingPrimer = buildCompactPrimer({
        records,
        summary,
        backendLabel: be,
        focus,
        transcriptPath: this.store.transcriptPath(meta.id)
      });

      // Lineage first, THEN clear. The store needs the explicit clear verb:
      // mergeSessionMeta skips undefined patch values, so updateMeta alone
      // would leave the stale native id resumable after a reload.
      if (prepareCompactLineage(meta)) {
        this.store.updateMeta(meta);
        this.store.clearBackendSessionId(meta.id);
        this.panel.post({ type: 'sessionMeta', session: meta });
      }

      // Kill + respawn at the same CB session id, never resuming the
      // pre-compact native thread; the respawn arms pendingBackendIdReason so
      // the new system_init is stamped 'compact' in backendSessionHistory.
      try {
        await this.loadExistingSession(meta.id, {
          connect: true,
          skipReplay: true,
          compactRespawn: true
        });
      } catch (e) {
        // The compact itself is durable (marker flushed, id cleared, primer
        // latched) — only the respawn failed. Drop the broken transport and
        // park in idle-restore so the next message retries the reconnect
        // instead of minting a new chat.
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.session?.dispose();
        this.session = undefined;
        this.idleResume = true;
        this.panel.post({
          type: 'notice',
          text: `Compacted, but restarting the ${be} backend failed — send a message to reconnect (the compact summary still goes out with it).`,
          detail: `Error: ${e instanceof Error ? e.message : String(e)}`
        });
        return;
      }
      this.panel.post({
        type: 'notice',
        text: `Compacted${
          typeof marker.preTokens === 'number'
            ? ` from ${Math.round(marker.preTokens / 1000)}K input tokens`
            : ''
        } — the summary + last 5 turns go out with your next message. The context meter may read unknown until the next turn completes.`
      });
    } finally {
      // Always release the prompt queue — a message sent mid-compact goes
      // out now, with the compact primer prepended by the prompt path.
      this.finishPrimerDecision();
    }
  }

  /** /handoff — write a structured HANDOFF.md briefing (goal, decisions,
   * files touched, last check, risks, next step) into the workspace so the
   * user can continue this work on another agent without losing state.
   * After a successful write (or untitled open), offers a "Continue on…"
   * picker that opens a fresh session on the chosen backend with the pack
   * as a one-shot primer. */
  async writeHandoffPack(): Promise<void> {
    const fromBackend = this.meta ? backendLabel(this.meta.backend) : 'unknown backend';
    const records = this.collectTranscriptRecords();
    const pack = buildHandoffPack(records, {
      fromBackend,
      model: this.meta?.model,
      sessionId: this.meta?.id,
      cwd: this.meta?.cwd,
      generatedAt: new Date().toISOString()
    });
    if (!pack) {
      this.panel.post({
        type: 'notice',
        text: 'Nothing to hand off yet — this conversation has no user turns.'
      });
      return;
    }
    const dir = this.meta?.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!dir) {
      // No workspace to write into — show the pack as an untitled doc instead.
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: pack });
      await vscode.window.showTextDocument(doc, { preview: false });
      await this.offerContinueOnBackend(pack, fromBackend);
      return;
    }
    const file = path.join(dir, 'HANDOFF.md');
    try {
      // Regenerating our own pack is fine, but never silently clobber a
      // file the user (or another tool) authored at the same path.
      let existing: string | undefined;
      try {
        existing = await fs.readFile(file, 'utf8');
      } catch {
        /* no existing file */
      }
      if (existing !== undefined && !existing.startsWith('# Handoff Pack')) {
        const pick = await vscode.window.showWarningMessage(
          `Code Build: ${file} exists and doesn't look like a generated handoff pack. Overwrite it?`,
          { modal: true },
          'Overwrite'
        );
        if (pick !== 'Overwrite') return;
      }
      await fs.writeFile(file, pack, 'utf8');
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.panel.post({
        type: 'notice',
        text: `Handoff pack written to \`${file}\`.`,
        key: 'handoff-pack'
      });
      await this.offerContinueOnBackend(pack, fromBackend, file);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Code Build: failed to write handoff pack: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Export the active conversation as Claude-style JSONL (Code Sessions
   * indexable) or simple role-prefixed Markdown. Format via QuickPick;
   * destination via showSaveDialog; success toast offers Reveal in Finder.
   */
  async exportConversation(): Promise<void> {
    if (!this.meta) {
      void vscode.window.showInformationMessage(
        'Code Build: no active conversation to export.'
      );
      return;
    }
    const formatPick = await vscode.window.showQuickPick(
      [
        {
          label: 'Claude JSONL',
          description: 'Code Sessions–indexable transcript',
          format: 'jsonl' as const
        },
        {
          label: 'Markdown',
          description: 'User/assistant turns for reading/sharing',
          format: 'md' as const
        }
      ],
      { placeHolder: 'Export conversation as…', ignoreFocusOut: true }
    );
    if (!formatPick) return;

    const records = this.collectTranscriptRecords() as ExportRecord[];
    if (!exportHasTurns(records)) {
      void vscode.window.showWarningMessage(
        'Code Build: session has no transcript content to export yet.'
      );
      return;
    }

    const body =
      formatPick.format === 'jsonl'
        ? exportToClaudeJsonl(this.meta, records)
        : exportToMarkdown(this.meta, records);

    const ext = formatPick.format === 'jsonl' ? 'jsonl' : 'md';
    const defaultDir =
      this.meta.cwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      os.homedir();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(defaultDir, `${this.meta.id}.${ext}`)),
      filters:
        formatPick.format === 'jsonl'
          ? { 'Claude JSONL': ['jsonl'], 'All files': ['*'] }
          : { Markdown: ['md'], 'All files': ['*'] },
      saveLabel: 'Export'
    });
    if (!uri) return;

    try {
      await fs.writeFile(uri.fsPath, body, 'utf8');
      const choice = await vscode.window.showInformationMessage(
        `Code Build: exported conversation → ${uri.fsPath}`,
        'Reveal in Finder'
      );
      if (choice === 'Reveal in Finder') {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Code Build: export failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * "Continue on…" QuickPick after /handoff. Opens a *fresh* session on the
   * chosen backend (not restore-via-switchBackend) and injects the pack as
   * `pendingPrimer` so the first user message carries the briefing.
   * Cancelling the pick leaves the current session untouched.
   */
  private async offerContinueOnBackend(
    pack: string,
    fromBackend: string,
    filePath?: string
  ): Promise<void> {
    const primer = formatHandoffPackPrimer(pack, fromBackend);
    if (!primer) return;

    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const backends = await detectAll(overrides);
    const current = this.meta?.backend;
    type ContinueItem = vscode.QuickPickItem & { backend?: BackendId };
    const continueItems: ContinueItem[] = backends
      .filter((b) => b.available && b.id !== current)
      .map((b) => ({
        label: `$(arrow-right) Continue on ${backendLabel(b.id)}`,
        description: b.id,
        detail: `Open a new ${backendLabel(b.id)} session with the handoff pack as primer`,
        backend: b.id
      }));

    if (continueItems.length === 0) {
      this.panel.post({
        type: 'notice',
        text: filePath
          ? `No other backends available — reference \`${filePath}\` manually on another agent.`
          : 'No other backends available — copy the pack into another agent manually.',
        key: 'handoff-pack-no-backend'
      });
      return;
    }

    const stay: ContinueItem = {
      label: '$(check) Done — keep current session',
      description: 'Only write the pack',
      detail: filePath
        ? `Leave this conversation as-is. Pack is at ${filePath}.`
        : 'Leave this conversation as-is. Pack is open as an untitled document.'
    };

    const pick = await vscode.window.showQuickPick<ContinueItem>([...continueItems, stay], {
      title: 'Handoff pack ready — continue on another backend?',
      placeHolder: 'Pick a backend to open with the pack as primer',
      ignoreFocusOut: true
    });
    if (!pick?.backend) return;

    // Remember the outgoing session so a later dropdown flip can restore it
    // (same contract as switchBackend). Do NOT go through switchBackend —
    // that path may restore a prior native thread or show the full/hybrid
    // carry-over banner; here the pack *is* the primer.
    const prevBackend = this.meta?.backend;
    const prevId = this.meta?.id;
    if (prevBackend && prevId && prevBackend !== pick.backend) {
      this.previousSessionByBackend.set(prevBackend, prevId);
      this.persistBackendMap();
    }

    // Clear any in-flight cross-backend banner state so we don't hold prompts.
    this.handoffRecords = undefined;
    this.primerPending = false;
    this.queuedPromptBlocks = undefined;
    // Latch primer BEFORE openSession so the first prompt on the new backend
    // carries the pack (openSession does not clear pendingPrimer).
    this.pendingPrimer = primer;

    // skipPin: handoff must not re-apply a Claude permission pin onto the
    // destination backend (agent-role / approval inventories differ).
    await this.openSession(pick.backend, { skipPin: true });
    this.persistBackendMap();

    this.panel.post({
      type: 'notice',
      text: `Continuing on **${backendLabel(pick.backend)}** with the handoff pack as primer — send a message to pick up where you left off.`,
      detail: filePath
        ? `Primer is the structured pack (also written to ${filePath}). It will be prepended to your next message only.`
        : 'Primer is the structured pack from the untitled handoff document. It will be prepended to your next message only.',
      key: `handoff-continue-${pick.backend}`
    });
  }

  private async switchBackend(backend: BackendId): Promise<void> {
    // Preflight: never switch to a backend that isn't installed on this
    // machine. Without this guard, picking (e.g.) grok on a box where grok is
    // not on PATH still latched the OUTGOING session into
    // previousSessionByBackend and then threw inside openSession — leaving the
    // panel poisoned so that flipping BACK to the original backend fired a
    // --resume loop (the repeated "Couldn't resume … error_during_execution"
    // the user hit switching claude → grok → claude). Refuse cleanly and leave
    // the live session completely untouched.
    const detectOverrides = this.config.get<Record<string, string>>('binPaths', {});
    const spec = BACKENDS[backend];
    const available = spec ? await detectBackend(spec, detectOverrides) : false;
    if (!available) {
      this.panel.post({
        type: 'notice',
        text: `**${backendLabel(backend)}** isn't installed on this machine — staying on your current agent.`,
        detail: `Code Build couldn't find the \`${spec ? resolveBin(spec, detectOverrides) : backend}\` binary on PATH (or via \`codeBuild.binPaths.${backend}\`). Install it, or point \`codeBuild.binPaths.${backend}\` at its absolute path, then switch again. Your current session and thread are untouched.`,
        key: `unavailable-${backend}`
      });
      // Re-sync the webview so the backend dropdown snaps back to the live
      // session instead of showing the agent the user just (unsuccessfully)
      // picked. hydrate() is guarded against restarting an existing session.
      await this.hydrate();
      return;
    }

    const prevBackend = this.meta?.backend;
    const prevId = this.meta?.id;
    const prevModel = this.meta?.model;

    // Remember the outgoing session id so a flip back to the original
    // backend lands on the SAME session (with --resume on backends
    // that support it). Without this, every switch creates a fresh
    // session and the user "loses" the prior thread until they fish
    // it back out of the history picker. Per notes.md: "When in CB
    // switching from one agent to another one — do not lose the
    // previous conversation thread, if no new messages were added."
    if (prevBackend && prevId && prevBackend !== backend) {
      this.previousSessionByBackend.set(prevBackend, prevId);
      this.persistBackendMap();
    }

    // Fast path: the user previously had a session in this target
    // backend in this chat panel. Restore it instead of spawning a
    // fresh one + offering a primer. Skips the handoff banner
    // entirely — they're rejoining their own thread, not handing
    // off across agents.
    const restoreId = this.previousSessionByBackend.get(backend);
    if (restoreId && restoreId !== this.meta?.id) {
      // Keep the entry: the conversation already has a native thread in this
      // backend, so EVERY switch back should resume it natively (not just the
      // first). Previously we deleted it here, which made the 2nd flip-back
      // re-summarize — exactly the "no need to summarize when switching back"
      // case. The map is durable (persisted on meta + re-hydrated on load).
      this.panel.post({
        type: 'notice',
        text: `Restoring your earlier **${backendLabel(backend)}** thread (\`${restoreId.slice(0, 8)}\`) — no carry-over needed, the agent already has its own context.`,
        detail: `Per-backend session memory: when you flip claude → grok → claude (or vice-versa), the original session is restored instead of a fresh spawn + primer dance. This keeps the thread you were in the middle of, with native --resume on supported backends.`,
        key: `restore-${restoreId}`
      });
      await this.loadExistingSession(restoreId);
      return;
    }
    // Snapshot the prior transcript BEFORE we tear the session down.
    let captured:
      | {
          records: { type: string; text?: string; update?: any }[];
          fromBackend: string;
          sourceBackendId: BackendId;
          sourceModel?: string;
        }
      | undefined;
    if (prevId && prevBackend && prevBackend !== backend) {
      // Externally-imported sessions (opened via "Open in Code Build"
      // from coder-sessions) only have post-import activity in the
      // local ~/.codebuild store. The actual conversation lives in the
      // upstream jsonl. Without this branch, switchBackend on an
      // imported session sees 0 user turns and silently skips the
      // banner — the user reported exactly this for a grok session
      // they were continuing. Pull the upstream transcript and merge
      // it with any post-import activity so the banner shows AND the
      // primer carries the full conversation.
      const records = this.collectTranscriptRecords(prevId);

      if (records.length > 0 && countUserTurns(records) > 0) {
        captured = {
          records,
          fromBackend: backendLabel(prevBackend),
          sourceBackendId: prevBackend,
          sourceModel: prevModel
        };
      }
    }

    // CRITICAL ORDERING: latch handoff state + show the banner
    // SYNCHRONOUSLY, BEFORE awaiting openSession. The new-agent spawn
    // takes 1-5 seconds; if we awaited first, a user typing & sending
    // immediately after switching the dropdown would slip a
    // context-less prompt through before the banner ever rendered.
    // Now: pickBackend → handoffRecords set + primerPending=true +
    // banner posted, all in the same synchronous task → THEN spawn.
    // The prompt handler sees the latch and queues until the user
    // picks a carry-over option.
    if (captured) {
      this.handoffRecords = captured;
      this.primerPending = true;
      this.panel.post({
        type: 'primerPrompt',
        turnCount: countUserTurns(captured.records),
        fromBackend: captured.fromBackend,
        toBackend: backendLabel(backend),
        sourceBackendId: captured.sourceBackendId,
        // Today only claude supports our one-shot LLM summarization
        // (claude -p --output-format json). Grok-source falls back to a
        // clipped mechanical summary in the host.
        llmSummarySupported: captured.sourceBackendId === 'claude'
      });
    }

    // skipPin: cross-backend switch must not force the workspace Claude pin
    // onto grok/opencode/codex mode inventories (relabel/hide instead).
    await this.openSession(backend, { skipPin: true });
    // The freshly-spawned session inherits the conversation's per-backend
    // native-session memory so a later flip back here resumes natively.
    this.persistBackendMap();
  }

  /** Persist the per-backend native-session map onto the current session's meta
   * (durable across panel reopen) so switch-back can resume natively instead of
   * re-summarizing. No-op until a session exists. */
  private persistBackendMap(): void {
    if (!this.meta) return;
    if (this.previousSessionByBackend.size === 0) return;
    this.meta.backendSessions = Object.fromEntries(this.previousSessionByBackend) as SessionMeta['backendSessions'];
    try {
      this.store.updateMeta(this.meta);
    } catch {
      /* best-effort durability; in-memory map still works this session */
    }
  }

  /** Resolve the carry-over banner. Three paths:
   *
   *   - 'none'   → drop the primer, no-op.
   *   - 'full'   → serialize the prior transcript verbatim (capped),
   *                synchronous.
   *   - 'hybrid' → fork the SOURCE backend one-shot to LLM-summarise
   *                the transcript, then append the last N turns
   *                verbatim. Async (5–30s typical) — meanwhile we
   *                queue any prompt the user sends, so the carry-over
   *                they just opted into isn't accidentally lost when
   *                they hit Enter quickly. Falls back to the clipped
   *                summary if the fork fails (LLM crash, exit code,
   *                timeout) so the turn never silently drops the
   *                primer.
   */
  private async applyPrimerDecision(
    choice: 'full' | 'hybrid' | 'none',
    lastNTurns?: number
  ): Promise<void> {
    const held = this.handoffRecords;
    this.handoffRecords = undefined;
    if (!held || choice === 'none') {
      this.pendingPrimer = undefined;
      this.finishPrimerDecision();
      return;
    }

    if (choice === 'full') {
      const primer = serializeConversation(held.records, 'full', held.fromBackend);
      this.pendingPrimer = primer || undefined;
      this.finishPrimerDecision();
      return;
    }

    // Hybrid (LLM summary + last N turns verbatim). primerPending
    // stays true (set at switchBackend time) until finishPrimerDecision
    // — so queued prompts keep waiting through the async fork.
    const n = Math.max(0, Math.min(50, lastNTurns ?? 5));
    this.panel.post({
      type: 'notice',
      text: `Summarising **${held.fromBackend}** conversation for handoff…`,
      detail:
        held.sourceBackendId === 'claude'
          ? `Forking a one-shot \`claude -p --output-format json\` on ${held.records.length.toLocaleString()} record(s). Typical 10–30s. The last ${n} turn${n === 1 ? '' : 's'} will be appended verbatim once the summary is ready. Any message you send before then is queued and will be released with the primer.`
          : `Building a clipped summary locally — ${held.sourceBackendId} doesn't support one-shot LLM summarisation yet. Should be near-instant. The last ${n} turn${n === 1 ? '' : 's'} will be appended verbatim.`
    });

    try {
      const summary =
        held.sourceBackendId === 'claude'
          ? (await this.summarizeViaClaude(held.records, held.sourceModel)).text
          : clippedSummaryFallback(held.records, held.fromBackend);
      const primer = serializeHybridConversation({
        records: held.records,
        summary,
        lastNTurns: n,
        fromBackend: held.fromBackend
      });
      this.pendingPrimer = primer;
      this.panel.post({
        type: 'notice',
        text: `Summary ready (${primer.length.toLocaleString()} chars). It'll be prepended to your next message.`,
        detail: `Composition:\n- LLM summary: ${summary.length.toLocaleString()} chars\n- Last ${n} verbatim turn${n === 1 ? '' : 's'}\n- Handoff framing block\n\nFull primer text is visible in the audit card that'll appear above your next user message.`
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Don't leave the user with no primer — fall back to the clipped
      // serializer. The notice tells them what happened.
      const clipped = serializeConversation(held.records, 'summary', held.fromBackend);
      this.pendingPrimer = clipped || undefined;
      this.panel.post({
        type: 'notice',
        text: `LLM summarisation failed — falling back to a clipped summary.`,
        detail: `Error: ${msg}\n\nClipped summary length: ${(clipped ?? '').length.toLocaleString()} chars. The handoff still works, just without the LLM-quality recap.`
      });
    } finally {
      this.finishPrimerDecision();
    }
  }

  /** Common post-decision step: clear `primerPending` and, if the user
   * already hit Send while we were waiting, dispatch their queued blocks
   * now (which will pick up `pendingPrimer` on the way through). */
  private finishPrimerDecision(): void {
    this.primerPending = false;
    if (this.queuedPromptBlocks) {
      const blocks = this.queuedPromptBlocks;
      this.queuedPromptBlocks = undefined;
      // Re-enter through `handle({type:'prompt'})` so the queued blocks
      // run through the same enrich/primer/audit pipeline as a fresh
      // send. We construct a minimal WebviewToHost so the type
      // discriminator is right.
      void this.handle({ type: 'prompt', blocks });
    }
  }

  /** One-shot LLM summarisation via `claude -p --output-format json`.
   *
   * Why one-shot (not --resume): --resume would create a side jsonl in
   * ~/.claude/projects + risk colliding with the active session guard
   * if claude is also running interactively elsewhere. We just pipe
   * the transcript on stdin and read the final JSON `result` field
   * out of stdout. The cost is real (the transcript is the input
   * tokens) but bounded — we tail-truncate to 120K chars (~30K
   * tokens). Errors throw so the caller can fall back to a clipped
   * summary instead of silently shipping no primer at all. */
  private summarizeViaClaude(
    records: { type: string; text?: string; update?: any }[],
    model?: string,
    focus?: string,
    variant: 'handoff' | 'compact' = 'handoff'
  ): Promise<{ text: string; costUsd?: number }> {
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const bin = overrides['claude'] || 'claude';
    const transcript = buildTranscriptForSummary(records);
    const brief =
      variant === 'compact'
        ? `You are compacting an ongoing conversation between a user and an AI ` +
          `coding assistant so the SAME assistant can continue it with a fresh, ` +
          `smaller context. The continuation sees nothing but this summary. ` +
          `Write a concise summary (200–400 words) covering: the user's goal, ` +
          `key decisions, files touched + current state, errors already tried, ` +
          `open todos, the immediate next step, and any constraints the user set.`
        : `You are summarising a conversation between a user and an AI coding ` +
          `assistant for handoff to a DIFFERENT AI assistant. The new assistant ` +
          `has zero prior context. Write a concise summary (200–400 words) ` +
          `covering: the user's goal, key findings/decisions, current task ` +
          `state, files involved, and any outstanding questions.`;
    const prompt =
      brief +
      ` Don't include verbatim turns (those will be appended separately). Just the summary text.\n` +
      (focus ? `The user asked you to focus especially on: ${focus}\n` : '') +
      `\n=== CONVERSATION ===\n${transcript}\n=== END ===\n\nSUMMARY:`;

    const args = ['-p', '--output-format', 'json'];
    if (model && model !== 'default') args.push('--model', model);

    return new Promise<{ text: string; costUsd?: number }>((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('claude one-shot summarisation timed out after 90s'));
      }, 90_000);
      proc.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      proc.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          return reject(
            new Error(`claude exited ${code}${stderr ? `: ${stderr.slice(-200)}` : ''}`)
          );
        }
        try {
          const obj = JSON.parse(stdout) as {
            result?: string;
            text?: string;
            total_cost_usd?: number;
          };
          const text = (obj.result || obj.text || '').trim();
          if (!text) return reject(new Error('claude returned an empty summary'));
          // The one-shot's spend is real session cost — /compact folds it
          // into costBaseUsd so the HUD/governor count the summary too.
          const costUsd =
            typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)
              ? obj.total_cost_usd
              : undefined;
          resolve({ text, costUsd });
        } catch (e) {
          reject(
            new Error(
              `Failed to parse claude one-shot output: ${(e as Error).message}. Raw tail: ${stdout.slice(-200)}`
            )
          );
        }
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  /** Whether the user opted into the skip-permissions escape hatch. */
  private get allowBypass(): boolean {
    return this.config.get<boolean>('allowDangerouslySkipPermissions', false);
  }

  /** Directories the agent's tools are allowed to touch beyond the
   * session cwd. Claude only reads/writes/executes inside cwd +
   * --add-dir paths even with --dangerously-skip-permissions; without
   * widening the scope here the agent feels "locked to the project
   * repo" the moment the user opens code-build inside a workspace.
   *
   * Resolution: explicit `codeBuild.additionalTrustedDirs` setting
   * wins; otherwise — and ONLY when bypass mode is fully enabled —
   * default to the user's $HOME so the agent can roam over personal
   * files (~/projects, ~/.config, etc.), matching how terminal claude
   * behaves after a user runs `cd ~ && claude --dangerously-skip-permissions`.
   * In default / acceptEdits / plan modes (or bypass without the
   * user's explicit opt-in), we DON'T auto-widen — the workspace
   * scope is the safer floor. */
  private trustedDirs(mode: PermissionMode): string[] {
    const explicit = this.config.get<string[]>('additionalTrustedDirs', []) ?? [];
    if (explicit.length > 0) return explicit.filter(Boolean);
    if (mode === 'bypass' && this.allowBypass) {
      const home = process.env.HOME;
      return home ? [home] : [];
    }
    return [];
  }

  /** Sticky config remembered across sessions. Mode precedence for NEW
   * sessions: workspace pin > globalState.lastMode > initialPermissionMode
   * (bypass gated by allowDangerouslySkipPermissions). Pass `skipPin` on
   * resume/handoff so a Claude pin is not forced onto a different backend. */
  private rememberedConfig(opts?: {
    skipPin?: boolean;
  }): { mode: PermissionMode; model?: string; effort: SessionMeta['effort']; modeSource: string } {
    const g = this.context.globalState;
    const resolved = resolveEffectivePermissionMode({
      pin: opts?.skipPin ? null : this.getPinnedMode(),
      lastMode: g.get<PermissionMode>('lastMode'),
      initialPermissionMode: this.config.get<PermissionMode>('initialPermissionMode', 'default'),
      allowBypass: this.allowBypass
    });
    const model =
      g.get<string>('lastModel')
      ?? (this.config.get<string>('defaultModel', '') || undefined);
    const effort =
      g.get<SessionMeta['effort']>('lastEffort')
      ?? this.config.get<SessionMeta['effort']>('defaultEffort', 'default')
      ?? 'default';
    return {
      mode: resolved.mode,
      model: model || undefined,
      effort,
      modeSource: resolved.source
    };
  }

  /** Read the per-workspace permission-mode pin, or undefined when unset/invalid. */
  private getPinnedMode(): PermissionMode | undefined {
    const raw = this.context.workspaceState.get<unknown>(PINNED_PERMISSION_MODE_KEY);
    return isPermissionMode(raw) ? raw : undefined;
  }

  /** Persist or clear the workspace pin; notifies the webview. */
  private writePinnedMode(mode: PermissionMode | null): void {
    void this.context.workspaceState.update(PINNED_PERMISSION_MODE_KEY, mode ?? undefined);
    // Clearing the pin also clears the one-shot unsupported warn so a
    // future pin can warn again if the agent inventory rejects it.
    if (mode == null) {
      void this.context.workspaceState.update(PIN_UNSUPPORTED_WARNED_KEY, undefined);
    }
    this.panel.post({ type: 'pinnedMode', mode });
  }

  /** Pin the given mode (or the current session mode) for this workspace. */
  private pinMode(mode?: PermissionMode): void {
    const target = mode ?? this.meta?.mode;
    if (!target || !isPermissionMode(target)) {
      this.panel.post({
        type: 'notice',
        text: 'Nothing to pin — pick a permission mode first.'
      });
      return;
    }
    if (target === 'bypass' && !this.allowBypass) {
      this.panel.post({
        type: 'notice',
        text: 'Cannot pin **bypass** — enable `codeBuild.allowDangerouslySkipPermissions` first.'
      });
      return;
    }
    this.writePinnedMode(target);
    this.panel.post({
      type: 'notice',
      text: `Pinned permission mode **${target}** for this workspace.`
    });
    // Apply immediately on the live session when possible (spawn flags /
    // session/set_mode). Failure does not clear the pin — next new session
    // will still try; unsupported inventory warns once via reapply.
    // systemDriven: pin write is the sticky choice; do not fire educate banner.
    if (this.meta && this.meta.mode !== target) {
      this.setMode(target, { systemDriven: true });
    }
  }

  private unpinMode(): void {
    if (!this.getPinnedMode()) {
      this.panel.post({ type: 'notice', text: 'No workspace permission-mode pin to clear.' });
      return;
    }
    this.writePinnedMode(null);
    this.panel.post({ type: 'notice', text: 'Cleared workspace permission-mode pin.' });
  }

  /**
   * After a fresh session start, push the pin through session/set_mode when
   * the agent came up in a different mode (ACP session/new vendor default).
   * Warns once per workspace when the agent inventory rejects the pin.
   */
  private async reapplyPinnedModeAfterStart(skipPin: boolean): Promise<void> {
    if (skipPin) return;
    const pin = this.getPinnedMode();
    if (!pin || !this.session) return;
    if (pin === 'bypass' && !this.allowBypass) return;
    if (this.meta?.mode === pin) {
      // Stream-json already spawned with the pin; ACP may still need set_mode
      // if ingestModes overwrote transport-local mode to vendor current.
      // Calling setMode when already matching is cheap (local + optional RPC).
    }
    try {
      await this.session.setMode(pin);
      if (this.meta && this.meta.mode !== pin) {
        this.meta.mode = pin;
        this.store.updateMeta(this.meta);
        this.panel.post({ type: 'sessionMeta', session: this.meta });
      }
    } catch (err) {
      const already = this.context.workspaceState.get<boolean>(PIN_UNSUPPORTED_WARNED_KEY);
      if (!already) {
        void this.context.workspaceState.update(PIN_UNSUPPORTED_WARNED_KEY, true);
        this.panel.post({
          type: 'notice',
          text: `Pinned mode **${pin}** is not supported by this agent — left vendor default. Unpin or pick another mode.`,
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  /** Persist the current selection so the next session restores it. */
  private rememberConfig(): void {
    if (!this.meta) return;
    void this.context.globalState.update('lastMode', this.meta.mode);
    void this.context.globalState.update('lastModel', this.meta.model ?? '');
    void this.context.globalState.update('lastEffort', this.meta.effort ?? 'default');
  }

  private async openSession(
    backend?: BackendId,
    opts?: { skipPin?: boolean }
  ): Promise<void> {
    this.teardownSession();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';
    this.lastInputTokens = undefined;
    const openOpts = this.pendingOpenOpts;
    this.pendingOpenOpts = {};
    if (openOpts.sessionKind !== 'voice-ideation') {
      this.voiceIdeationActive = false;
      this.visAwaitingCloseResult = false;
    }
    const id = crypto.randomUUID();
    const be = backend ?? this.defaultBackend();
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const skipPin = opts?.skipPin === true;

    // Startup timing markers — see postStartupNotice() for the detail
    // tooltip + 30s follow-up nudge. Long --resume loads can sit silent
    // for 30+ s; the user now sees both WHAT we're spawning (hover) and
    // gets a 30s "still waiting" beat so a stuck spawn doesn't look like
    // a fast spawn that's just slow.
    const spawnStart = Date.now();
    const cancelNudge = this.postStartupNotice({
      be,
      text: `Starting **${be}** agent…`,
      cwd: this.cwd,
      spawnStart,
      skipPin
    });
    let firstEventAt = 0;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.perf.setSessionMeta({ sessionId: id, backend: be });
    this.unsubscribe = this.session.onEvent((update) => {
      this.routeAgentUpdate(id, update, {
        onFirstEvent: () => {
          if (firstEventAt) return;
          firstEventAt = Date.now();
          const ms = firstEventAt - spawnStart;
          cancelNudge();
          this.panel.post({
            type: 'notice',
            text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
          });
        }
      });
    });

    // Restore sticky mode / model / effort. Pin applies only on ordinary
    // new sessions — resume/handoff pass skipPin so Claude pins do not
    // force-apply onto grok/opencode agent-role inventories.
    const remembered = this.rememberedConfig({ skipPin });
    // A model remembered from a different backend (e.g. 'opus' carried into
    // grok) won't be valid — drop to the backend's default in that case.
    // Validate against the DISCOVERED list (matches the picker) so a
    // dynamically-found model like 'claude-fable-5' isn't dropped on restore.
    const validModels = modelsFor(be);
    const model =
      remembered.model && validModels.includes(remembered.model) ? remembered.model : undefined;

    this.meta = {
      id,
      backend: be,
      title:
        openOpts.sessionKind === 'voice-ideation'
          ? `VIS · ${be}`
          : `New chat · ${be}`,
      mode: remembered.mode,
      cwd: this.cwd,
      createdAt: Date.now(),
      model,
      effort: remembered.effort,
      sessionKind: openOpts.sessionKind ?? 'coding'
    };
    this.titled = false;
    // Write the transcript header but do NOT index yet (lazy: see commitAndTitle).
    this.store.createSession(this.meta);
    this.mirrorCreate(this.meta);
    this.rememberLast(this.meta.id);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    await this.session.start({
      cwd: this.cwd,
      mode: remembered.mode,
      model: this.meta.model,
      effort: this.meta.effort,
      allowBypass: this.allowBypass,
      additionalTrustedDirs: this.trustedDirs(remembered.mode),
      forceKp:
        openOpts.forceKp === true || openOpts.sessionKind === 'voice-ideation',
      onFsPreWrite: (absPath) => this.captureFsPreWrite(absPath)
    });
    await this.reapplyPinnedModeAfterStart(skipPin);
  }

  /** Inspect each SessionUpdate as it streams from the backend and lift
   * structured tool calls into purpose-built webview messages. We don't
   * suppress the underlying `tool_call` event (the webview still shows the
   * generic card briefly) — instead we send an ADDITIONAL `askUserQuestion`
   * or `taskList` message so the UI can render a richer surface. Pending
   * AskUserQuestion calls are remembered here so a later `askUserAnswer`
   * can be translated back into the upstream tool_result. */
  private pendingAskUserQuestions = new Map<
    string,
    Array<{ question: string; options: { label: string; description?: string }[] }>
  >();
  private interceptToolCall(update: SessionUpdate): void {
    if (update.kind !== 'tool_call') return;
    const name = update.toolCall.title;
    const input = update.toolCall.rawInput as any;
    if (!name || !input) return;

    if (
      (name === 'AskUserQuestion' || name === 'ask_user_question') &&
      Array.isArray(input.questions)
    ) {
      // Claude's AskUserQuestion shape: each entry has { question, header,
      // multiSelect, options: [{label, description, preview}] }.
      const questions = (input.questions as Array<any>).map((q) => ({
        question: String(q.question ?? ''),
        header: q.header ? String(q.header) : undefined,
        multiSelect: !!q.multiSelect,
        options: Array.isArray(q.options)
          ? q.options.map((o: any) => ({
              label: String(o.label ?? ''),
              description: o.description ? String(o.description) : undefined,
              preview: o.preview ? String(o.preview) : undefined
            }))
          : []
      }));
      this.pendingAskUserQuestions.set(update.toolCall.toolCallId, questions);
      this.panel.post({
        type: 'askUserQuestion',
        toolCallId: update.toolCall.toolCallId,
        questions
      });
      return;
    }

    // TodoWrite (claude) / todo_write (grok). Schema differs slightly:
    //   claude:  { todos: [{content, status, activeForm}] }
    //   grok:    { merge: bool, todos: [{id, content, status}] }
    if ((name === 'TodoWrite' || name === 'todo_write') && Array.isArray(input.todos)) {
      const tasks = (input.todos as Array<any>).map((t) => ({
        content: String(t.content ?? ''),
        status: (t.status ?? 'pending') as 'pending' | 'in_progress' | 'completed' | 'cancelled',
        activeForm: t.activeForm ? String(t.activeForm) : undefined
      }));
      this.panel.post({
        type: 'taskList',
        toolCallId: update.toolCall.toolCallId,
        tasks
      });
    }
  }

  /** Build + post a `contextInjected` audit card describing every block
   * we're about to write to the agent's stdin on a regular prompt
   * turn. Sections appear in stdin order: primer first (if any), then
   * each resolved @-mention with its workspace path, then the user's
   * raw typed text, then any image attachments. The summary line in
   * the collapsed card names whichever sections were present — the
   * user gets a one-glance signal that "this turn included a 12K
   * primer + 2 file refs" without expanding.
   *
   * `originalBlocks` is what the webview sent (pre-mention-rewrite),
   * `enrichedBlocks` is post @-mention resolution (each @path is now
   * a resource_link), and `finalBlocks` includes the primer if one
   * was set. We diff between them so the mention/image sections list
   * resolved paths, not the literal `@token` text. */
  private emitContextInjectedForPrompt(args: {
    originalBlocks: ContentBlock[];
    enrichedBlocks: ContentBlock[];
    finalBlocks: ContentBlock[];
    primer: string | undefined;
  }): void {
    // Only surface the audit card when the host actually INJECTED
    // something — i.e., the first message after a backend switch where
    // the user chose to carry context. On a regular prompt we don't
    // rewrite anything beyond resolving @-mentions (which are visible
    // in the user's typed text anyway), so a card every turn was just
    // visual noise. The user explicitly asked for it to be scoped
    // here.
    if (!args.primer) return;
    const sections: Array<{
      label: string;
      body: string;
      chars: number;
      kind?: 'primer' | 'mention' | 'user_text' | 'image' | 'tool_result' | 'system';
    }> = [];

    sections.push({
      label: `Carry-over primer (${args.primer.length.toLocaleString()} chars)`,
      body: args.primer,
      chars: args.primer.length,
      kind: 'primer'
    });

    // Iterate the enriched block list (post-mention-rewrite). Group
    // text-runs that came from the user as one user_text section; emit
    // each resource_link / image as its own section with the
    // resolved target.
    let userTextBuf = '';
    const flushUserText = () => {
      if (!userTextBuf.trim()) {
        userTextBuf = '';
        return;
      }
      sections.push({
        label: `User text (${userTextBuf.length.toLocaleString()} chars)`,
        body: userTextBuf,
        chars: userTextBuf.length,
        kind: 'user_text'
      });
      userTextBuf = '';
    };
    for (const b of args.enrichedBlocks) {
      if (b.type === 'text') {
        userTextBuf += b.text;
      } else if (b.type === 'resource_link') {
        flushUserText();
        const path = b.uri.startsWith('file://') ? b.uri.slice('file://'.length) : b.uri;
        sections.push({
          label: `@-mention → ${b.name ?? path}`,
          body: `Resolved to: ${path}`,
          chars: path.length,
          kind: 'mention'
        });
      } else if (b.type === 'image') {
        flushUserText();
        const approxKb = Math.round((b.data.length * 3) / 4 / 1024);
        sections.push({
          label: `Image attachment (${b.mimeType}, ~${approxKb} KB)`,
          body: `data:${b.mimeType};base64,<${b.data.length.toLocaleString()} chars of base64 elided>`,
          chars: b.data.length,
          kind: 'image'
        });
      }
    }
    flushUserText();

    // No sections means the user sent literally nothing (defensive —
    // the prompt handler guards against empty sends, but if a future
    // path lands here with nothing to inject we just skip the card).
    if (sections.length === 0) return;

    const summary = this.summariseSections(sections);
    this.panel.post({
      type: 'contextInjected',
      origin: 'prompt',
      summary,
      sections
    });
  }

  /** One-line collapsed-card label naming the section kinds present so
   * the user can scan without expanding. */
  private summariseSections(sections: Array<{ kind?: string; chars: number }>): string {
    const counts = new Map<string, { count: number; chars: number }>();
    for (const s of sections) {
      const k = s.kind ?? 'other';
      const cur = counts.get(k) ?? { count: 0, chars: 0 };
      cur.count += 1;
      cur.chars += s.chars;
      counts.set(k, cur);
    }
    const pretty: Record<string, string> = {
      primer: 'primer',
      mention: '@-mention',
      user_text: 'user text',
      image: 'image',
      tool_result: 'tool result',
      system: 'system'
    };
    const parts: string[] = [];
    for (const [k, v] of counts) {
      const label = pretty[k] ?? k;
      const plural = v.count > 1 ? `${v.count} ${label}s` : `${v.count} ${label}`;
      const size = v.chars > 1000 ? ` (${Math.round(v.chars / 1000)}K chars)` : ` (${v.chars} chars)`;
      parts.push(plural + size);
    }
    return parts.join(' · ');
  }

  /** Accumulate streaming assistant text + fire the turn classifier on
   * end-of-turn. Called from every onEvent handler (openSession /
   * openExternalSession / loadExistingSession share this so the
   * behaviour is identical across spawn paths). Off by default —
   * gated by `codeBuild.classifyTurns`. */
  /** Build + arm the per-turn stall watchdog (D1). Rebuilt each prompt so the
   * thresholds (codeBuild.stallWarnSeconds / .stallAutoCancelSeconds) take
   * effect on the next turn without a reload. */
  private armWatchdog(): void {
    this.watchdog?.clear();
    this.openToolCalls.clear();
    this.nowLine.clear();
    this.awaitingPermission = false;
    this.armGovernor();
    const warnMs = Math.max(0, this.config.get<number>('stallWarnSeconds', 45)) * 1000;
    const autoCancelMs = Math.max(0, this.effectiveStallAutoCancelSeconds()) * 1000;
    const be = this.meta?.backend ?? 'agent';
    this.watchdog = new TurnWatchdog({
      warnMs,
      autoCancelMs,
      hasOpenTool: () => this.openToolCalls.size > 0,
      isAwaitingUser: () => this.pendingAskUserQuestions.size > 0 || this.awaitingPermission,
      onWarn: (silentMs) => {
        const secs = Math.round(silentMs / 1000);
        const running = this.openToolCalls.size > 0;
        this.panel.post({
          type: 'notice',
          key: 'turn-stall',
          text: running
            ? `**${be}** has been running a command with no output for ${secs}s. If it looks stuck, click **Stop** to cancel — the session is preserved and your next message resumes it.`
            : `**${be}** has produced no output for ${secs}s and may be stuck (a known intermittent CLI failure that burns no tokens). Click **Stop** to cancel now, or wait — CB will auto-recover the UI if the silence continues.`,
          detail:
            `No assistant output or tokens have arrived for ${secs}s.\n` +
            `• Stop — cancel this turn now (the agent process is killed; the session resumes on your next message).\n` +
            `• Wait — keep going if you expect a long reply or a long-running command.\n` +
            (autoCancelMs > warnMs && !running
              ? `CB will auto-stop the turn after ${Math.round(autoCancelMs / 1000)}s of total silence so the UI never stays frozen.`
              : `Auto-stop is off for this turn — use Stop to recover.`)
        });
      },
      onAutoCancel: (silentMs) => {
        const secs = Math.round(silentMs / 1000);
        // Hardened recovery: kill the wedged process (transport cancel now
        // escalates SIGINT→SIGKILL) AND force the UI out of "working…",
        // independent of whether the transport ever emits a result.
        this.session?.cancel();
        // Auto-cancel may never see result/error — clear tracker state so a
        // stale open-tool entry can't resurface on the next transition.
        this.nowLine.clear();
        this.panel.post({ type: 'busy', busy: false });
        this.panel.post({ type: 'dismissNotice', key: 'turn-stall' });
        this.panel.post({
          type: 'notice',
          text: `Auto-stopped **${be}** after ${secs}s of silence — it looked stuck (no output, no tokens). Nothing was lost; resend your message or keep typing and the session resumes.`
        });
      }
    });
    this.watchdog.arm();
  }

  /** Feed the stall watchdog from the live event stream (D1). Resets the
   * silence clock on REAL agent progress, tracks open tool calls so a
   * legitimately long command isn't auto-killed, and stops the watchdog when
   * the turn ends. system_init / available_commands_update / current_mode_update
   * are deliberately NOT treated as progress — claude emits them while idle. */
  private watchTurnLiveness(update: SessionUpdate): void {
    this.feedGovernor(update);
    this.nowLine.onUpdate(update, Date.now());
    if (!this.watchdog) return;
    switch (update.kind) {
      case 'tool_call':
        this.openToolCalls.add(update.toolCall.toolCallId);
        this.watchdog.progress();
        break;
      case 'tool_call_update':
        if (update.toolCall.status === 'completed' || update.toolCall.status === 'failed') {
          this.openToolCalls.delete(update.toolCall.toolCallId);
        }
        this.watchdog.progress();
        break;
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk':
      case 'usage':
      case 'usage_breakdown':
      case 'plan':
      case 'permission_request':
        // The agent is now blocked on a human decision — pause stall
        // escalation so we don't warn/auto-cancel before the user responds.
        this.awaitingPermission = true;
        this.watchdog.progress();
        break;
      case 'result':
      case 'error':
        this.openToolCalls.clear();
        // Keep the pause if permission prompts are still queued (a turn can
        // error out while an unanswered request is on screen).
        this.awaitingPermission = this.session?.hasPendingPermissions() ?? false;
        this.watchdog.clear();
        this.panel.post({ type: 'dismissNotice', key: 'turn-stall' });
        break;
      default:
        break;
    }
  }

  /** (Re)build the governor when the session changes, then open a turn span.
   * Config is re-read every prompt: a new session gets a fresh instance,
   * an ongoing one keeps its counters but picks up limit/mode edits. */
  private armGovernor(): void {
    const sid = this.meta?.id;
    if (!this.governor || this.governorSessionId !== sid) {
      this.governor = new StopGovernor(this.readGovernorConfig());
      this.governorSessionId = sid;
      // Rebuilds after a compact respawn (teardown drops the governor)
      // must not restart the spend counter at $0 — seed the compact cost
      // floor so maxEstUsd trips on the true session-cumulative total.
      this.governor.noteUsage(this.meta?.costBaseUsd);
    } else {
      this.governor.setConfig(this.readGovernorConfig());
    }
    this.governor.startTurn(Date.now());
    if (this.mediaTaxSessionId !== sid) {
      this.mediaTax = new MediaToolTaxTracker();
      this.mediaTaxSessionId = sid;
      this.mediaTaxLastPosted = undefined;
      this.preferDomHintArmed = false;
      this.panel.post({ type: 'mediaToolTax', chip: null });
    }
    this.mediaTax.startTurn();
  }

  private readGovernorConfig(): GovernorConfig {
    const mode = this.config.get<'off' | 'warn' | 'hard'>('governor.mode', 'warn');
    return {
      mode,
      maxToolCalls: Math.max(0, this.config.get<number>('governor.maxToolCalls', 400)),
      maxWallMs: Math.max(0, this.config.get<number>('governor.maxWallMinutes', 0)) * 60_000,
      maxEstUsd: Math.max(0, this.config.get<number>('governor.maxEstUsd', 0)),
      enableDupToolStop: this.config.get<boolean>('governor.dupToolStop', false),
      enableNoProgressStop: this.config.get<boolean>('governor.noProgressStop', false)
    };
  }

  /** Feed session-budget counters from the live event stream, then evaluate.
   * Runs on EVERY update (unlike the watchdog, which needs an armed turn). */
  private feedGovernor(update: SessionUpdate): void {
    this.feedMediaTax(update);
    const gov = this.governor;
    if (!gov) return;
    // A replacement session's startup events must never feed a governor
    // built for the previous session (teardown also clears it — belt+braces).
    if (this.meta && this.governorSessionId !== this.meta.id) return;
    switch (update.kind) {
      case 'tool_call':
        gov.noteToolCall(update.toolCall.title || 'tool');
        break;
      case 'usage':
        gov.noteUsage(update.usage.costUsd);
        break;
      case 'result':
        // Claude reports costUsd only on the final result usage — mid-turn
        // `usage` events carry tokens but no cost.
        gov.noteUsage(update.usage?.costUsd);
        gov.endTurn(Date.now());
        break;
      case 'error':
        gov.endTurn(Date.now());
        break;
      default:
        break;
    }
    const trip = gov.check(Date.now());
    if (trip) this.onGovernorTrip(trip);
  }

  private readMediaTaxConfig(): MediaToolTaxConfig {
    const mode = this.config.get<'off' | 'warn'>('mediaToolTax.mode', 'warn');
    return {
      mode,
      maxMediaResults: Math.max(
        0,
        this.config.get<number>(
          'mediaToolTax.maxMediaResults',
          DEFAULT_MEDIA_TOOL_TAX_CONFIG.maxMediaResults
        )
      ),
      maxMediaWindowPct: Math.max(
        0,
        this.config.get<number>(
          'mediaToolTax.maxMediaWindowPct',
          DEFAULT_MEDIA_TOOL_TAX_CONFIG.maxMediaWindowPct
        )
      )
    };
  }

  /**
   * Meter image/pixel tool_result payloads (runtime tax). Soft-gate only —
   * sticky notice + prefer-DOM hint; never rewrites or blocks tools in v1.
   */
  private feedMediaTax(update: SessionUpdate): void {
    const sid = this.meta?.id;
    if (sid && this.mediaTaxSessionId !== sid) {
      this.mediaTax = new MediaToolTaxTracker();
      this.mediaTaxSessionId = sid;
      this.mediaTaxLastPosted = undefined;
      this.preferDomHintArmed = false;
      this.panel.post({ type: 'mediaToolTax', chip: null });
    }
    const cfg = this.readMediaTaxConfig();
    if (cfg.mode === 'off') {
      this.postMediaTaxChip(null);
      return;
    }

    switch (update.kind) {
      case 'tool_call':
      case 'tool_call_update': {
        const tc = update.toolCall;
        if (!tc.content || !Array.isArray(tc.content) || tc.content.length === 0) break;
        this.mediaTax.noteToolContent(tc.content, {
          toolCallId: tc.toolCallId,
          toolTitle: 'title' in tc ? tc.title : undefined
        });
        break;
      }
      case 'result':
      case 'error':
        this.mediaTax.endTurn();
        break;
      default:
        break;
    }

    // Context window: reuse model family table via a local heuristic (200k/128k).
    const model = this.meta?.model ?? '';
    const windowTokens = /claude|opus|sonnet|haiku/i.test(model)
      ? 200_000
      : /grok|gpt-5|o3|o4|codex|gpt-4|o1/i.test(model)
        ? 128_000
        : undefined;

    const { chip, newlyPaused, pauseReasons } = this.mediaTax.check(cfg, windowTokens);
    const chipOut: MediaToolTaxChip = {
      ...chip,
      ...(this.preferDomHintArmed ? { preferDomArmed: true } : {})
    };
    // Header chip: show once there is tax, a pause, or Prefer-DOM is armed.
    if (
      chipOut.sessionMediaTokens > 0 ||
      chipOut.turnMediaTokens > 0 ||
      chipOut.pause ||
      this.preferDomHintArmed
    ) {
      this.postMediaTaxChip(chipOut);
    } else {
      this.postMediaTaxChip(null);
    }
    if (newlyPaused) {
      const detail =
        pauseReasons.join('; ') +
        `\nSession media tax: ~${chip.sessionMediaTokens} tok across ${chip.sessionMediaCount} media result(s).` +
        `\n${MEDIA_TAX_DOM_HINT}` +
        `\nClick Prefer DOM/CLI on this notice (or the media chip) to arm a session-sticky host hint.` +
        `\nAdjust with codeBuild.mediaToolTax.* (advisory only — tools are not blocked).`;
      this.panel.post({
        type: 'notice',
        key: 'media-tool-tax',
        text: `⚠️ Media tool-tax pause: screenshot/pixel MCP results are inflating tokens (${chip.label}). Prefer DOM/text snapshots.`,
        detail
      });
    }
  }

  /** Dedupe-post the media-tax header chip (or clear it). */
  private postMediaTaxChip(chip: MediaToolTaxChip | null): void {
    const sig = chip
      ? `${chip.label}|${chip.warn ? 1 : 0}|${chip.pause ? 1 : 0}|${chip.preferDomArmed ? 1 : 0}|${chip.sessionMediaCount}|${chip.sessionMediaTokens}|${chip.turnMediaTokens}`
      : 'null';
    if (sig === this.mediaTaxLastPosted) return;
    this.mediaTaxLastPosted = sig;
    this.panel.post({
      type: 'mediaToolTax',
      chip: chip
        ? {
            label: chip.label,
            turnMediaTokens: chip.turnMediaTokens,
            sessionMediaTokens: chip.sessionMediaTokens,
            sessionMediaCount: chip.sessionMediaCount,
            warn: chip.warn,
            pause: chip.pause,
            ...(chip.hint ? { hint: chip.hint } : {}),
            ...(chip.preferDomArmed ? { preferDomArmed: true } : {})
          }
        : null
    });
  }

  /**
   * One-click Prefer DOM/CLI: arm session-sticky prompt inject, dismiss the
   * pause notice, confirm in-chat. Never rewrites tools.
   */
  private armPreferDomHint(): void {
    this.preferDomHintArmed = true;
    this.panel.post({ type: 'dismissNotice', key: 'media-tool-tax' });
    this.panel.post({
      type: 'notice',
      key: 'media-tool-tax-prefer-dom',
      text:
        '✅ Prefer DOM/CLI armed — next prompts include a host hint to use text/DOM snapshots (browser-personal) instead of screenshot MCP loops.',
      detail:
        `${MEDIA_TAX_DOM_HINT}\n` +
        `Injected prefix: ${MEDIA_TAX_PREFER_DOM_INJECT}\n` +
        'Advisory only — tools are not blocked or rewritten. Cleared on new session.'
    });
    // Refresh chip so Prefer-DOM armed state shows immediately.
    const cfg = this.readMediaTaxConfig();
    const { chip } = this.mediaTax.check(cfg);
    this.mediaTaxLastPosted = undefined;
    this.postMediaTaxChip({
      ...chip,
      preferDomArmed: true,
      label: chip.sessionMediaTokens > 0 || chip.turnMediaTokens > 0 ? chip.label : 'media · prefer DOM',
      warn: true,
      hint: MEDIA_TAX_DOM_HINT
    });
  }

  /** A budget crossed its limit: record the stop event on SessionMeta (CSV
   * joins it later), surface a sticky banner, and — in hard mode — cancel the
   * stream. The session stays resumable either way. */
  private onGovernorTrip(trip: GovernorTrip): void {
    const be = this.meta?.backend ?? 'agent';
    if (this.meta) {
      const record: StopEventRecord = {
        at: Date.now(),
        budget: trip.budget,
        action: trip.action,
        limit: trip.limit,
        toolCalls: trip.toolCalls,
        activeMs: trip.activeMs,
        estUsd: trip.estUsd > 0 ? trip.estUsd : undefined,
        lastTools: trip.lastTools
      };
      this.meta.stopEvents = [...(this.meta.stopEvents ?? []), record];
      this.store.updateMeta(this.meta);
    }
    const label =
      trip.budget === 'toolCalls'
        ? `${trip.toolCalls} tool calls (limit ${trip.limit})`
        : trip.budget === 'wallClock'
          ? `${Math.round(trip.activeMs / 60_000)}m of active agent time (limit ${Math.round(trip.limit / 60_000)}m)`
          : `~$${trip.estUsd.toFixed(2)} estimated spend (limit $${trip.limit.toFixed(2)})`;
    const detail =
      (trip.lastTools.length > 0 ? `Recent tools: ${trip.lastTools.join(', ')}.\n` : '') +
      `Session counters: ${trip.toolCalls} tool calls, ${Math.round(trip.activeMs / 1000)}s active` +
      (trip.estUsd > 0 ? `, ~$${trip.estUsd.toFixed(2)} est.` : '') +
      `\nBudgets are per session — adjust with the codeBuild.governor.* settings.`;
    if (trip.action === 'stop') {
      this.session?.cancel();
      // Close turn accounting NOW: a soft ACP cancel may never yield a
      // result/error, which would leave the wall clock running through idle
      // time and let the stall watchdog fire against an already-stopped turn.
      this.governor?.endTurn(Date.now());
      this.watchdog?.clear();
      this.openToolCalls.clear();
      this.nowLine.clear();
      this.panel.post({ type: 'dismissNotice', key: 'turn-stall' });
      this.panel.post({ type: 'busy', busy: false });
      this.panel.post({
        type: 'notice',
        key: 'governor',
        text: `⛔ Stop governor cancelled **${be}**: ${label}. Nothing was lost — send a message to resume, or raise the limit in \`codeBuild.governor.*\`.`,
        detail
      });
    } else {
      this.panel.post({
        type: 'notice',
        key: 'governor',
        text: `⚠️ Stop governor: **${be}** crossed ${label} this session. Warn-only mode — nothing was stopped. Set \`codeBuild.governor.mode\` to \`hard\` to auto-cancel runaway sessions.`,
        detail
      });
    }
  }

  private onTurnEvent(update: SessionUpdate): void {
    if (update.kind === 'agent_message_chunk' && update.content?.type === 'text') {
      this.currentAssistantBuf += update.content.text ?? '';
      return;
    }
    if (update.kind === 'result') {
      // VIS close: snapshot assistant text BEFORE classifier clears the buffer.
      if (this.visAwaitingCloseResult) {
        const snap = this.currentAssistantBuf;
        void this.maybeWriteVisCloseFromAssistant(snap);
      }
    }
    if (update.kind !== 'result') return;
    if (!this.config.get<boolean>('classifyTurns', false)) return;
    if (!this.lastUserText) return;
    const userTurnIdx = this.userTurnsSent;
    this.userTurnsSent += 1;
    const userText = this.lastUserText;
    const assistantText = this.currentAssistantBuf;
    this.lastUserText = '';
    this.currentAssistantBuf = '';
    if (!this.meta) return;
    const be = this.meta.backend;
    if (be !== 'claude') return; // grok one-shot not wired yet
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const bin = overrides['claude'] || 'claude';
    // Fire-and-forget. Classification is decorative; failures are
    // swallowed and the chip just doesn't appear. Use Haiku for the
    // cheap tier; user can override with `codeBuild.classifyModel`.
    const model = this.config.get<string>('classifyModel', 'haiku');
    void classifyTurn(userText, assistantText, { backend: be, bin, model }).then((labels) => {
      if (labels.length > 0) {
        this.panel.post({ type: 'turnLabels', turnIndex: userTurnIdx, labels });
      }
    });
  }

  /** Persist the backend's native session id when the transport surfaces
   * it. Claude assigns its own session id at spawn (independent of our
   * local UUID) and writes its transcript under that id in
   * ~/.claude/projects — without persisting it, a later
   * loadExistingSession spawns claude with no --resume and the agent
   * has zero context ("I don't have prior conversation context to
   * continue from"). Re-inits with the SAME id are no-ops; a NEW id
   * (respawn, failed resume → fresh session) reassigns the field and
   * appends the transition to meta.backendSessionHistory so the old
   * native transcript stays joinable (see applyBackendSessionId). */
  private captureBackendSessionId(update: SessionUpdate): void {
    if (update.kind !== 'system_init') return;
    if (!this.meta) return;
    // An armed reason wins even when no id was captured yet: a failed
    // resume before first capture (external-open path) must not be
    // mislabeled 'initial'.
    const reason: BackendSessionTransitionReason =
      this.pendingBackendIdReason ?? (this.meta.backendSessionId ? 'respawn' : 'initial');
    this.pendingBackendIdReason = undefined;
    if (!applyBackendSessionId(this.meta, update.backendSessionId, reason, Date.now())) return;
    this.store.updateMeta(this.meta);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
  }

  /** Reason to stamp on the next backendSessionId rotation. Armed by
   * handleResumeFallback (the follow-up system_init carries the fresh id);
   * cleared on every system_init so a stale arm can't mislabel a later
   * unrelated respawn. */
  private pendingBackendIdReason?: BackendSessionTransitionReason;

  /** Native resume failed (grok session/load rejected — deleted session
   * dir, foreign id, schema drift after a grok update) and the transport
   * fell back to session/new. The fresh agent has zero memory even though
   * the UI shows the transcript, so promote the reserve primer (armed in
   * the resume paths whenever a native resume is attempted with records
   * on hand) and tell the user what happened. The follow-up system_init
   * overwrites meta.backendSessionId with the NEW id via
   * captureBackendSessionId, so the next reload doesn't retry the dead
   * one. */
  private handleResumeFallback(update: SessionUpdate): void {
    if (update.kind !== 'resume_fallback') return;
    this.pendingBackendIdReason = 'resume_fallback';
    const be = this.meta?.backend ?? 'agent';
    const hadPrimer = !!this.fallbackPrimer && !this.pendingPrimer;
    if (hadPrimer) {
      this.pendingPrimer = this.fallbackPrimer;
    }
    this.fallbackPrimer = undefined;
    this.panel.post({
      type: 'notice',
      text:
        `Native resume of \`${update.requestedSessionId.slice(0, 8)}\` failed — started a fresh ${be} session instead.` +
        (hadPrimer
          ? ` The last 10 turns will be prepended to your first message so the agent keeps context.`
          : ''),
      detail: `session/load rejected: ${update.reason}\n\nThe on-disk session may have been deleted, created on another machine, or written by an incompatible ${be} version. Code Build fell back to session/new${hadPrimer ? ' and armed the transcript primer (one-shot, fires on your FIRST message)' : ''}; the new native session id replaces the stale one so future reloads resume cleanly.`
    });
  }

  /** Translate a webview-side click on an AskUserQuestion option card into
   * the upstream tool_result the backend is waiting for.
   *
   * Anthropic's Messages API protocol requires a `tool_result` content
   * block (keyed by `tool_use_id`) to fulfil a pending tool call —
   * NOT a plain text user message. The prior implementation sent the
   * answer as a text block, which claude couldn't correlate with the
   * in-flight AskUserQuestion tool_use: it timed the tool call out
   * with status=failed (the red × in the chat) and then answered
   * conversationally ("No problem, tell me which thread to pick up
   * and I'll dive in"), exactly the symptom the user reported. We
   * now serialize the picks as JSON and send them inside a
   * `tool_result` block; claude's normaliser threads it back into the
   * built-in AskUserQuestion handler and the agent continues its
   * turn. Also flip busy=true so the working… indicator reappears
   * while claude processes the answer. */
  private effectiveStallAutoCancelSeconds(): number {
    if (this.stallAutoCancelOverride != null) return this.stallAutoCancelOverride;
    const remembered = this.context.globalState.get<number>('lastStallAutoCancelSeconds');
    if (typeof remembered === 'number' && Number.isFinite(remembered)) return Math.max(0, remembered);
    return Math.max(0, this.config.get<number>('stallAutoCancelSeconds', 0));
  }

  private setStallTimeout(seconds: number): void {
    const secs = Math.max(0, Math.round(seconds));
    this.stallAutoCancelOverride = secs;
    void this.context.globalState.update('lastStallAutoCancelSeconds', secs);
    this.panel.post({ type: 'stallTimeout', seconds: secs });
    if (this.watchdog?.active) this.armWatchdog();
  }

  private answerAskUserQuestion(toolCallId: string, answers: Record<string, string>): void {
    const pending = this.pendingAskUserQuestions.get(toolCallId);
    if (!pending) return;
    this.pendingAskUserQuestions.delete(toolCallId);
    // Grok ACP: the turn is blocked on the ext-method RPC, not a tool_result.
    if (this.session?.answerAskUserQuestion?.(toolCallId, answers)) {
      this.panel.post({ type: 'busy', busy: true });
      return;
    }
    const payload = JSON.stringify({ answers });
    const blocks: ContentBlock[] = [
      {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: payload
      }
    ];
    // Audit card so the user sees exactly what claude is about to
    // receive in response to its AskUserQuestion. Same transparency
    // story as a regular prompt: the answer JSON is normally invisible.
    this.panel.post({
      type: 'contextInjected',
      origin: 'tool_result',
      summary: `1 tool result (${payload.length} chars)`,
      sections: [
        {
          label: `tool_result for ${toolCallId.slice(0, 12)}…`,
          body: payload,
          chars: payload.length,
          kind: 'tool_result'
        }
      ]
    });
    this.panel.post({ type: 'busy', busy: true });
    void this.session?.prompt(blocks);
  }

  /** Keep host meta truthful when the agent reports its own mode (modes
   * ingested from session/new|load or a live current_mode_update). Without
   * this, persisted meta disagrees with the chip after a reload. Does NOT
   * touch globalState.lastMode — an agent-initiated mode change is not a
   * user selection. */
  private syncAgentMode(update: SessionUpdate): void {
    if (update.kind !== 'current_mode_update' || !update.mode || !this.meta) return;
    if (this.meta.mode === update.mode) return;
    this.meta.mode = update.mode;
    this.store.updateMeta(this.meta);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
  }

  private setMode(mode: PermissionMode, opts?: { systemDriven?: boolean }): void {
    // Optimistic: update meta + chip immediately, but persist lastMode only
    // after the transport accepts the change. On rejection (ACP
    // session/set_mode error, unsupported mode id) revert both — persisting
    // a refused mode would silently re-apply it on every future session.
    const prevMode = this.meta?.mode;
    const systemDriven = opts?.systemDriven === true;
    const applyMeta = (m: PermissionMode) => {
      if (!this.meta) return;
      this.meta.mode = m;
      this.panel.post({ type: 'sessionMeta', session: this.meta });
    };
    applyMeta(mode);
    const applied = this.session ? this.session.setMode(mode) : Promise.resolve();
    applied.then(
      () => {
        this.rememberConfig();
        this.maybeShowAutoEducateBanner(mode, systemDriven);
      },
      (err: unknown) => {
        if (prevMode !== undefined) applyMeta(prevMode);
        this.panel.post({
          type: 'notice',
          text: `Mode change to **${mode}** was rejected: ${
            err instanceof Error ? err.message : String(err)
          }`
        });
      }
    );
  }

  /**
   * P3 educate-on-select: once per workspace, the first time the user
   * successfully picks Claude Auto, surface a short notice + docs link.
   * Marks dismissed immediately so resume/reload cannot refire.
   */
  private maybeShowAutoEducateBanner(mode: PermissionMode, systemDriven: boolean): void {
    const dismissed = this.context.workspaceState.get<boolean>(AUTO_EDUCATE_DISMISSED_KEY) === true;
    if (
      !shouldShowAutoEducateBanner({
        selectedMode: mode,
        backendId: this.meta?.backend,
        pinnedMode: this.getPinnedMode(),
        dismissed,
        systemDriven
      })
    ) {
      return;
    }
    void this.context.workspaceState.update(AUTO_EDUCATE_DISMISSED_KEY, true);
    this.panel.post({
      type: 'notice',
      text:
        "**Auto mode** uses Claude's classifier to approve tool calls. " +
        'Pin a mode with 📍 if you want this sticky for the workspace.',
      detail: `Docs: ${AUTO_MODE_DOCS_URL}`
    });
    void vscode.window
      .showInformationMessage(
        'Code Build: Claude Auto mode uses a classifier to approve tools. Learn more in the permission-modes docs.',
        'Open docs',
        'Got it'
      )
      .then((choice) => {
        if (choice === 'Open docs') {
          void vscode.env.openExternal(vscode.Uri.parse(AUTO_MODE_DOCS_URL));
        }
      });
  }

  /** Apply a new model selection. Persists onto meta so the picker stays
   * sticky on reload; takes effect at the next process spawn (claude reads
   * --model only at spawn time). */
  private setModel(model: string): void {
    if (!this.meta) return;
    this.meta.model = model;
    this.store.updateMeta(this.meta);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    this.rememberConfig();
  }

  /** Apply a new effort/thinking-budget level. Same persistence + respawn
   * semantics as setModel. */
  private setEffort(effort: SessionMeta['effort']): void {
    if (!this.meta) return;
    this.meta.effort = effort;
    this.store.updateMeta(this.meta);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    this.rememberConfig();
  }

  /**
   * Queue a session to resume once the webview signals 'ready'. Used when opening
   * history into a brand-new panel whose React app hasn't mounted yet — posting
   * historyLoaded before mount would be dropped. If the webview is already ready
   * (e.g. resuming into the current panel), load immediately.
   */
  queueResume(id: string, opts?: { connect?: boolean }): void {
    const connect = opts?.connect ?? true;
    if (this.webviewReady) {
      void this.loadExistingSession(id, { connect });
    } else {
      this.pendingResumeId = id;
      this.pendingResumeConnect = connect;
    }
  }

  /** Same pattern as queueResume but for sessions imported from upstream CLIs
   * (claude / grok). Defers until the webview is mounted so the
   * sessionMeta + historyLoaded posts aren't dropped on the floor. */
  private pendingExternal?: { source: SessionSource; sessionId: string; cwd: string; title?: string };
  queueExternal(args: { source: SessionSource; sessionId: string; cwd: string; title?: string }): void {
    if (this.webviewReady) {
      void this.openExternalSession(args);
    } else {
      this.pendingExternal = args;
    }
  }

  /** Resume a session that originated in an upstream CLI (claude or grok):
   * spawn a fresh code-build session bound to the matching backend in the
   * session's cwd, and pass `resumeId` so the CLI's own resume flag wires
   * up the transcript (claude `--resume <id>`; grok currently doesn't expose
   * an external resume flag so this is a fresh chat in the right place).
   * Also write a local transcript header pointing at the external file so
   * subsequent UI actions (close/reopen, "View conversation" cross-link)
   * find their footing. */
  async openExternalSession(args: {
    source: SessionSource;
    sessionId: string;
    cwd: string;
    title?: string;
  }): Promise<void> {
    if (args.source !== 'claude' && args.source !== 'grok') return;

    // CB already owns this native session (it was started here, compacted
    // here, or a prior "Open in Code Build" grew content). Reuse that row:
    // creating a shell under the native id (meta + system_init, hasContent
    // false) — or rewriting the header of a contentful transcript with the
    // same id — is what left reloaded tabs with an empty history (#29).
    // Match current backendSessionId OR any prior id in backendSessionHistory
    // (post-/compact CSV "Open" on the OLD native id must still land here).
    const owned = this.store.findLocalSessionForNative(args.sessionId, args.cwd);
    if (owned && sessionMatchesWorkspace(owned.cwd, this.workspaceFolderPaths())) {
      await this.loadExistingSession(owned.id, { connect: true });
      return;
    }

    this.teardownSession();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';

    // Map source → backend. Default to claude when an unknown source slips
    // through (defensive — we already validated above).
    const be: BackendId = args.source === 'grok' ? 'grok' : 'claude';
    const mode = this.config.get<PermissionMode>('initialPermissionMode', 'default');
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    // Use the upstream session id as the local id. This makes
    // back-references unambiguous (the user sees the same UUID in
    // code-sessions, in the CLI, and in code-build) and means a second
    // "Open in Code Build" click on the same row doesn't pile up dupes.
    const id = args.sessionId;

    // External-session startup is where the slowness usually lives —
    // `claude --resume` on a multi-MB jsonl can sit silently for 30+ s
    // before the first event. postStartupNotice() gives the user both
    // a visible spawn line AND a hoverable tooltip with the actual
    // command/cwd/resume id + a 30s nudge if the agent stays silent.
    const spawnStart = Date.now();
    const cancelNudge = this.postStartupNotice({
      be,
      text: `Loading ${args.source} session \`${args.sessionId.slice(0, 8)}\`…`,
      cwd: args.cwd,
      resumeId: be === 'claude' ? args.sessionId : undefined,
      spawnStart
    });
    let firstEventAt = 0;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.perf.setSessionMeta({ sessionId: id, backend: be });
    this.unsubscribe = this.session.onEvent((update) => {
      this.routeAgentUpdate(id, update, {
        onFirstEvent: () => {
          if (firstEventAt) return;
          firstEventAt = Date.now();
          const ms = firstEventAt - spawnStart;
          cancelNudge();
          this.panel.post({
            type: 'notice',
            text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
          });
        }
      });
    });

    this.meta = {
      id,
      backend: be,
      title: args.title || `${be} · ${id.slice(0, 8)}`,
      mode,
      cwd: args.cwd,
      createdAt: Date.now(),
      source: args.source
    };
    this.titled = true; // upstream gave us the title

    this.store.createSession(this.meta);
    this.store.commitSession(this.meta);
    this.mirrorCreate(this.meta);
    this.rememberLast(this.meta.id);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });

    // Replay the upstream transcript into the webview before spawning the
    // backend so the user lands on the existing conversation rather than a
    // blank chat. For claude this is read from
    // ~/.claude/projects/<dash-encoded-cwd>/<id>.jsonl; for grok from
    // ~/.grok/sessions/<urlencoded-cwd>/<id>/chat_history.jsonl.
    // Both paths are deterministic given (cwd, sessionId).
    const replay =
      args.source === 'claude'
        ? loadClaudeHistory(claudeJsonlPathFor(args.cwd, args.sessionId))
        : args.source === 'grok'
          ? loadGrokHistory(grokChatPathFor(args.cwd, args.sessionId))
          : null;
    if (replay) {
      // Extract the dominant model from the imported transcript so the
      // header dropdown reflects what the session was actually using.
      // For claude, the highest-token-volume model in `byModel` wins (a
      // session that mostly used Opus shouldn't suddenly switch to
      // Sonnet on resume).
      // For claude, collapse the transcript's version-pinned model id to a family
      // alias so resuming on a differently-provisioned install (e.g. Bedrock that
      // only serves Opus 4.1) resolves it instead of rejecting "model identifier is
      // invalid". An unrecognizable id (opaque ARN) → undefined → keep the validated
      // default rather than forcing a bad `--model`.
      const rawDominant = pickDominantModel(replay.byModel ?? []);
      const dominantModel = args.source === 'claude' ? claudeFamilyAlias(rawDominant) : rawDominant;
      if (dominantModel && this.meta) {
        this.meta.model = dominantModel;
        this.store.updateMeta(this.meta);
        this.panel.post({ type: 'sessionMeta', session: this.meta });
      }
      this.panel.post({ type: 'historyLoaded', meta: this.meta, records: replay.records });
      this.postCheckpointIds();
    } else {
      // Best-effort: surface the missing-transcript condition in the chat so
      // the user understands why an external resume produced a blank panel.
      this.panel.post({
        type: 'sessionUpdate',
        sessionId: id,
        update: {
          kind: 'error',
          message: `Could not read ${args.source} transcript for session ${args.sessionId.slice(0, 8)}. Starting fresh.`
        }
      });
    }

    // Spawn the agent with the upstream session id. The claude transport
    // already threads resumeId → `--resume <id>` so the CLI picks up where
    // it left off. The grok ACP transport doesn't support resume yet (no
    // external CLI flag) — it'll just start a new ACP session in the right
    // cwd; the loaded transcript above still gives the user the context.
    //
    // Active-session guard for claude. Claude Code writes per-process
    // control files under ~/.claude/sessions/<pid>.json:
    //   { pid, sessionId, cwd, startedAt, procStart, version, entrypoint }
    // If any of those records name our target sessionId AND the recorded
    // pid is still alive, claude is actively running this session
    // elsewhere — `claude --resume <id>` will exit with code 1 because the
    // upstream CLI holds the jsonl (lsof reports no open fd because claude
    // opens / appends / closes per event, so file-lock detection alone is
    // unreliable — the .json control file is the canonical signal). Skip
    // --resume, spawn a fresh agent in the same cwd, and surface a soft
    // 'notice' (not 'error'). The transcript replay above already gives
    // the user context.
    let resumeId: string | undefined = args.sessionId;
    if (args.source === 'claude') {
      const holder = findActiveClaudeHolder(args.sessionId);
      if (holder) {
        resumeId = undefined;
        this.panel.post({
          type: 'notice',
          text:
            `This Claude session is actively running in another process (pid ${holder.pid}` +
            (holder.entrypoint ? `, entrypoint \`${holder.entrypoint}\`` : '') +
            (holder.cwd ? `, cwd \`${holder.cwd}\`` : '') +
            `). Claude refuses two simultaneous resumes of the same id, so Code Build is showing the prior ` +
            `transcript as read-only and starting a fresh agent in \`${args.cwd}\` instead. Close the other ` +
            `panel to release the session, then click "Open in Code Build" again to take it over.`
        });
      }
    }

    // Self-resume primer: when the agent CAN'T natively resume (grok
    // ACP, claude when the active-session guard tripped), the new
    // process has zero memory of the conversation even though the
    // user sees the transcript in the UI. Inject the last N turns
    // verbatim as a primer on the first prompt so the agent has
    // context. Without this, asking "what is the keyword" after a
    // grok-session resume produces "I don't know what keyword you
    // mean — let me search the files" because the agent literally
    // doesn't know.
    const nativeResume = BACKENDS[be].supportsResume && !!resumeId;
    if (replay && replay.records.length > 0) {
      const primer = serializeSelfResumePrimer({
        records: replay.records as any,
        lastNTurns: 10,
        backendLabel: backendLabel(be)
      });
      if (primer && !nativeResume) {
        this.pendingPrimer = primer;
        this.panel.post({
          type: 'notice',
          text: `Restored conversation context — the last 10 turns will be prepended to your first message so ${be} has memory of the prior chat.`,
          detail: `${be} doesn't support an external --resume flag, so the new agent process is a fresh spawn with no memory of the conversation. Code Build is injecting the recent transcript as a one-shot primer; the agent uses it to pick up where it left off, then forgets it (the primer fires only on the FIRST message after this resume). Hover the audit card that'll appear above your next user message to inspect the full primer text.`
        });
      } else if (primer) {
        // Native resume (grok session/load) is about to be attempted. Keep
        // the primer in reserve: if the transport reports resume_fallback,
        // handleResumeFallback promotes it so the fresh agent still gets
        // the conversation context.
        this.fallbackPrimer = primer;
      }
    }

    await this.session.start({
      cwd: args.cwd,
      mode,
      resumeId,
      model: this.meta?.model,
      effort: this.meta?.effort,
      allowBypass: this.allowBypass,
      additionalTrustedDirs: this.trustedDirs(mode),
      onFsPreWrite: (absPath) => this.captureFsPreWrite(absPath)
    });
  }

  /** On the first user prompt: index the session in history and derive a title from it. */
  private commitAndTitle(firstUserText: string): void {
    if (!this.meta || this.titled) return;
    this.titled = true;
    this.meta.title = deriveTitle(firstUserText);
    this.store.commitSession(this.meta);
    this.store.updateMeta(this.meta);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    this.rememberLast(this.meta.id);
    void daemonPatchMeta(this.meta.id, {
      title: this.meta.title,
      hasContent: true,
      backend: this.meta.backend,
      project_path: this.meta.cwd
    });
  }

  private workspaceFolderPaths(): string[] {
    return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  }

  private rememberLast(id: string): void {
    void this.context.workspaceState.update(LAST_SESSION_KEY, id);
  }

  private mirrorCreate(meta: SessionMeta): void {
    void daemonCreate({
      id: meta.id,
      backend: meta.backend,
      cwd: meta.cwd,
      title: meta.title,
      model: meta.model,
      mode: meta.mode,
      effort: meta.effort,
      kind: meta.sessionKind
    });
  }

  private teardownSession(): void {
    this.killReplayChild();
    this.historyOlderFrom = 0;
    this.historyOlderBusy = false;
    this.flushIpcImmediate();
    this.store.flushSync();
    // A reserve primer belongs to the resume attempt that armed it; never
    // let it leak into a later session's fallback.
    this.fallbackPrimer = undefined;
    // Same for an armed id-rotation reason: without this, session A's
    // resume_fallback could mislabel session B's first rotation.
    this.pendingBackendIdReason = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
    // Cancel any pending "still waiting" notice — we don't want it
    // firing after the user has already torn down or replaced the
    // session it described.
    this.startupNoticeCleanup?.();
    this.startupNoticeCleanup = undefined;
    // Stop the stall watchdog so its timer can't fire against a torn-down
    // or replaced session.
    this.watchdog?.clear();
    this.watchdog = undefined;
    this.openToolCalls.clear();
    this.nowLine.clear();
    // Drop the stop governor so a replacement session's startup events can't
    // feed the old counters (or trip against the wrong SessionMeta).
    this.governor = undefined;
    this.governorSessionId = undefined;
  }

  // ── Performance + hot-path coalesce ──────────────────────────────────

  private perfDebugMode(): PerfDebugMode {
    const v = this.config.get<string>('perfDebug', 'hud');
    if (v === 'full' || v === 'hud' || v === 'off') return v;
    return 'hud';
  }

  /** `codeBuild.progressiveActivity` gate, host-side (the webview cannot
   * read codeBuild.*). auto = on for quiet backends, off for Claude which
   * already streams verbose text. */
  private progressiveActivityEnabled(): boolean {
    const v = this.config.get<string>('progressiveActivity', 'auto');
    if (v === 'on') return true;
    if (v === 'off') return false;
    return (this.meta?.backend ?? 'claude') !== 'claude';
  }

  private ensurePerfHudTimer(): void {
    if (this.perfHudTimer) return;
    this.perf.setMode(this.perfDebugMode());
    this.perfHudTimer = setInterval(() => {
      // Pick up setting changes without reload.
      this.perf.setMode(this.perfDebugMode());
      if (this.perf.mode === 'off') return;
      this.pushPerfHud();
      if (this.perfPanelOpen) {
        this.panel.post({ type: 'perfSnapshot', snapshot: this.perf.snapshot() });
      }
    }, 500);
  }

  private pushPerfHud(): void {
    if (this.perf.mode === 'off') return;
    const hud = this.perf.getHud();
    this.panel.post({ type: 'perfHud', hud });
    const turn = this.perf.getCurrentTurn();
    if (turn) {
      const dur = Date.now() - turn.promptSentAt;
      this.panel.post({
        type: 'activityStrip',
        segments: turn.segments,
        turnDurationMs: Math.max(dur, 1)
      });
    }
  }

  /** Re-announce restorable checkpoint ids after a transcript replay so
   * ToolCards regain their restore action on reload/resume. Idempotent. */
  private postCheckpointIds(): void {
    const sessionId = this.meta?.id;
    const engine = sessionId ? this.ensureCheckpointEngine(sessionId) : undefined;
    if (engine) {
      this.panel.post({ type: 'checkpointAvailable', toolCallIds: engine.listCheckpointIds() });
    }
  }

  /** ACP fs/write_text_file bridge hook — stage the pre-image of a path
   * the moment before the host writes it, ahead of any tool_call naming it. */
  private captureFsPreWrite(absPath: string): void {
    const sessionId = this.meta?.id;
    if (sessionId) this.ensureCheckpointEngine(sessionId)?.onFsWrite(absPath);
  }

  /** Lazily (re)build the write-checkpoint engine for a session. Returns
   * undefined when there is no usable workspace root (fail closed — no
   * capture, no restore). Posts the current restorable-id list to the
   * webview on every rebuild so ToolCards can show the restore action
   * after a reload/resume. */
  private ensureCheckpointEngine(sessionId: string): WriteCheckpointEngine | undefined {
    if (this.checkpoints && this.checkpointsSessionId === sessionId) return this.checkpoints;
    const cwd = this.meta?.cwd || this.cwd;
    if (!cwd) return undefined;
    let confine: (p: string) => string;
    try {
      const guard = createPathGuard(cwd);
      confine = (p) => guard.confine(p);
    } catch {
      return undefined;
    }
    // NOTE: file-history/ is a sibling of the FLAT sessions/<uuid>.jsonl
    // store — a nested sessions/<id>/ dir would collide with it.
    this.checkpoints = new WriteCheckpointEngine({
      dir: path.join(os.homedir(), '.codebuild', 'file-history', sessionId),
      cwd,
      maxEntries: this.config.get<number>('writeCheckpoint.maxEntries', 50),
      // Codex normalizes full `changes[].old` into diff oldText — a real
      // pre-image source. Claude's synthesized diffs are fragments; never
      // trusted (the engine falls back to pre-write disk reads / degraded).
      trustDiffOldText: this.meta?.backend === 'codex',
      confine,
      onCheckpointsChanged: (toolCallIds) =>
        this.panel.post({ type: 'checkpointAvailable', toolCallIds })
    });
    this.checkpointsSessionId = sessionId;
    this.panel.post({
      type: 'checkpointAvailable',
      toolCallIds: this.checkpoints.listCheckpointIds()
    });
    return this.checkpoints;
  }

  /** "Restore code to here" from an edit ToolCard. Code-only: tracked files
   * revert to their pre-images before the picked tool; the conversation,
   * tool cards and agent context are untouched. Bash/external writes are
   * not tracked (universal gap — Claude's own /rewind shares it). */
  private async handleRestoreCheckpoint(toolCallId: string): Promise<void> {
    const sessionId = this.meta?.id;
    const engine = sessionId ? this.ensureCheckpointEngine(sessionId) : undefined;
    const paths = engine ? engine.planRestorePaths(toolCallId) : null;
    if (!engine || !paths || paths.length === 0) {
      this.panel.post({
        type: 'notice',
        text: 'No restorable checkpoint for that tool call — its pre-images were skipped or the checkpoint history was pruned.'
      });
      return;
    }
    const confirm = 'Restore code';
    const pick = await vscode.window.showWarningMessage(
      `Restore ${paths.length} file${paths.length === 1 ? '' : 's'} to the state before this tool call? Unsaved editor changes to those files will be overwritten. Bash/external file changes are not tracked.`,
      { modal: true, detail: paths.join('\n') },
      confirm
    );
    if (pick !== confirm) return;
    const result = engine.restore(toolCallId);
    if (!result) {
      this.panel.post({ type: 'notice', text: 'Checkpoint restore failed — entry no longer exists.' });
      return;
    }
    await this.reloadRestoredDocs(result.paths);
    this.panel.post({
      type: 'notice',
      text:
        `Checkpoint restored: ${result.written} file${result.written === 1 ? '' : 's'} rewritten` +
        (result.deleted ? `, ${result.deleted} deleted` : '') +
        (result.skipped ? `, ${result.skipped} skipped (degraded / out-of-root / non-regular)` : '') +
        '. Conversation unchanged.'
    });
  }

  /** Documented restore behavior for open editors: clean documents reload
   * from disk via the file watcher; DIRTY documents are overwritten with
   * the restored content and saved — the confirm modal warned about it. */
  private async reloadRestoredDocs(paths: string[]): Promise<void> {
    for (const p of paths) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === p);
      if (!doc || !doc.isDirty) continue;
      try {
        const restored = await fs.readFile(p, 'utf8');
        const edit = new vscode.WorkspaceEdit();
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(doc.uri, full, restored);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
      } catch {
        /* file was deleted by the restore or unreadable — watcher surfaces it */
      }
    }
  }

  private refreshDualStore(): void {
    if (!this.meta) return;
    const cb = this.store.statTranscript(this.meta.id);
    const dual: {
      codebuildPath?: string;
      codebuildBytes?: number;
      codebuildMtimeMs?: number;
      claudePath?: string;
      claudeBytes?: number;
      claudeMtimeMs?: number;
    } = {};
    if (cb) {
      dual.codebuildPath = cb.path;
      dual.codebuildBytes = cb.bytes;
      dual.codebuildMtimeMs = cb.mtimeMs;
    }
    if (this.meta.backend === 'claude' && this.meta.backendSessionId) {
      try {
        const p = claudeJsonlPathFor(this.meta.cwd || this.cwd, this.meta.backendSessionId);
        if (p && fsSync.existsSync(p)) {
          const st = fsSync.statSync(p);
          dual.claudePath = p;
          dual.claudeBytes = st.size;
          dual.claudeMtimeMs = st.mtimeMs;
        }
      } catch {
        /* optional */
      }
    }
    this.perf.setDualStore(dual);
  }

  /**
   * Shared agent-event path: async disk queue + IPC coalesce + perf + side effects.
   * Result/error/permission flush IPC immediately so the UI leaves "working…" promptly.
   */
  private routeAgentUpdate(
    sessionId: string,
    update: SessionUpdate,
    opts?: { onFirstEvent?: () => void }
  ): void {
    // Fold the /compact cost floor in FIRST: everything downstream — the
    // persisted record, the governor, the webview HUD — must see the
    // session-cumulative figure, never the raw (process-scoped) total that
    // restarts near $0 after a compact respawn.
    if (this.meta && sessionId === this.meta.id) {
      update = foldUsageCost(update, this.meta.costBaseUsd);
    }
    const t0 = performance.now();
    this.store.appendUpdate(sessionId, update);
    void daemonAppend(sessionId, update);
    // lastDiskMs is enqueue cost until flush; use wall for the hot path sample.
    const diskMs = Math.max(this.store.lastDiskMs, performance.now() - t0);
    this.perf.onUpdate(update, { diskMs });

    // Write-checkpoint capture observes the raw stream (edit-class tool_call /
    // tool_call_update merge + turn boundaries). Same host path for every
    // backend — claude stream-json included; no "claude has /rewind" carve-out.
    this.ensureCheckpointEngine(sessionId)?.observeUpdate(update);

    this.watchTurnLiveness(update);
    if (
      update.kind === 'agent_message_chunk' ||
      update.kind === 'agent_thought_chunk' ||
      update.kind === 'tool_call' ||
      update.kind === 'available_commands_update' ||
      update.kind === 'system_init'
    ) {
      opts?.onFirstEvent?.();
    }
    this.interceptToolCall(update);
    this.onTurnEvent(update);
    this.captureBackendSessionId(update);
    this.handleResumeFallback(update);
    this.syncAgentMode(update);
    if (update.kind === 'usage' && typeof update.usage.inputTokens === 'number') {
      this.lastInputTokens = update.usage.inputTokens;
    } else if (update.kind === 'result' && typeof update.usage?.inputTokens === 'number') {
      this.lastInputTokens = update.usage.inputTokens;
    }

    const immediate =
      update.kind === 'result' ||
      update.kind === 'error' ||
      update.kind === 'permission_request';
    this.enqueueIpc(sessionId, update, immediate);

    if (update.kind === 'result' || update.kind === 'error') {
      this.panel.post({ type: 'busy', busy: false });
      this.pushPerfHud();
      if (this.perf.mode === 'full' || this.perfPanelOpen) {
        getPerfOutput().appendLine(this.perf.formatFlightReport());
        getPerfOutput().appendLine('---');
      }
      if (this.perfPanelOpen) {
        this.refreshDualStore();
        this.panel.post({ type: 'perfSnapshot', snapshot: this.perf.snapshot() });
      }
    } else if (this.perf.mode !== 'off') {
      const ec = this.perf.getCurrentTurn()?.eventCount;
      if (ec != null && ec > 0 && ec % 20 === 0) this.pushPerfHud();
    }

    if (update.kind === 'error') {
      void this.maybeOfferFailover(update.errorClass, update.message);
    }
  }

  /**
   * On overload|unavailable only: post a confirm banner offering the next
   * healthy ACP peer. Quota/auth/other never offer (limit-aware switch /
   * Continuity Relay own quota walls). Debounced while an offer is pending.
   */
  private async maybeOfferFailover(
    errorClass: BackendErrorClass | undefined,
    message: string
  ): Promise<void> {
    if (this.pendingFailover) return;
    const fromBackend = this.meta?.backend;
    if (!fromBackend) return;
    const cls = errorClass ?? classifyBackendError(message);
    if (!isFailoverClass(cls)) return;

    // Fresh detect so a backend installed after hydrate still appears.
    let backends = cachedBackends;
    try {
      const overrides = this.config.get<Record<string, string>>('binPaths', {});
      backends = await detectAll(overrides);
      cachedBackends = backends;
    } catch {
      /* keep cached snapshot */
    }
    if (this.pendingFailover) return; // raced with another offer
    if (this.meta?.backend !== fromBackend) return; // session swapped meanwhile

    const offer = buildFailoverOffer({
      errorClass: cls,
      fromBackend,
      fromLabel: backendLabel(fromBackend),
      backends: backends.map((b) => ({
        id: b.id,
        available: b.available,
        label: b.label
      }))
    });
    if (!offer) return;

    this.pendingFailover = offer;
    this.panel.post({
      type: 'failoverOffer',
      errorClass: offer.errorClass,
      fromBackend: offer.fromBackend,
      fromLabel: offer.fromLabel,
      suggestedBackend: offer.suggestedBackend,
      suggestedLabel: offer.suggestedLabel,
      alternatives: offer.alternatives,
      message: offer.message
    });
  }

  /** Clear a pending failover confirm (dismiss / accept / new session). */
  private clearFailoverOffer(): void {
    if (!this.pendingFailover) return;
    this.pendingFailover = undefined;
    this.panel.post({ type: 'failoverOfferClear' });
  }

  /**
   * User answered the failover banner. Accept → spawn/resume target with a
   * last-N hybrid primer + stamp failover_* meta. Reject → dismiss only.
   * Does NOT go through switchBackend's primer picker (one-click path).
   */
  private async applyFailoverDecision(
    accept: boolean,
    backend?: BackendId
  ): Promise<void> {
    const offer = this.pendingFailover;
    this.clearFailoverOffer();
    if (!accept || !offer) return;

    const target = backend ?? offer.suggestedBackend;
    if (target === offer.fromBackend) return;

    const detectOverrides = this.config.get<Record<string, string>>('binPaths', {});
    const spec = BACKENDS[target];
    const available = spec ? await detectBackend(spec, detectOverrides) : false;
    if (!available) {
      this.panel.post({
        type: 'notice',
        text: `**${backendLabel(target)}** isn't installed — staying on **${offer.fromLabel}**.`,
        detail: `Failover aborted: no \`${spec ? resolveBin(spec, detectOverrides) : target}\` on PATH.`,
        key: `failover-unavailable-${target}`
      });
      return;
    }

    const prevBackend = this.meta?.backend ?? offer.fromBackend;
    const prevId = this.meta?.id;
    const fromLabel = backendLabel(prevBackend);

    // Capture transcript BEFORE tearing down so the hybrid primer has content.
    const records = prevId ? this.collectTranscriptRecords(prevId) : [];
    const summary =
      records.length > 0 ? clippedSummaryFallback(records, fromLabel) : '';
    const primer =
      records.length > 0 && summary
        ? serializeHybridConversation({
            records,
            summary,
            lastNTurns: FAILOVER_DEFAULT_LAST_N,
            fromBackend: fromLabel
          })
        : undefined;

    if (prevBackend && prevId && prevBackend !== target) {
      this.previousSessionByBackend.set(prevBackend, prevId);
      this.persistBackendMap();
    }

    // Drop any in-flight manual-switch primer latch — failover owns the primer.
    this.handoffRecords = undefined;
    this.primerPending = false;
    this.queuedPromptBlocks = undefined;
    this.pendingPrimer = primer;

    // Prefer restoring a prior native thread on the target when one exists
    // (same contract as switchBackend fast path) — native context needs no
    // hybrid primer. Else fresh spawn + last-N hybrid primer.
    const restoreId = this.previousSessionByBackend.get(target);
    let usedPrimer = false;
    if (restoreId && restoreId !== this.meta?.id) {
      this.pendingPrimer = undefined;
      await this.loadExistingSession(restoreId);
    } else {
      usedPrimer = Boolean(primer);
      await this.openSession(target, { skipPin: true });
    }
    this.persistBackendMap();

    if (this.meta) {
      this.meta.failoverFrom = prevBackend;
      this.meta.failoverReason = offer.errorClass;
      this.meta.failoverAt = Date.now();
      try {
        this.store.updateMeta(this.meta);
      } catch {
        /* best-effort */
      }
      this.panel.post({ type: 'sessionMeta', session: this.meta });
    }

    this.panel.post({
      type: 'notice',
      text: `Failed over from **${fromLabel}** → **${backendLabel(target)}** (${offer.errorClass}).${
        usedPrimer
          ? ` Last-${FAILOVER_DEFAULT_LAST_N} hybrid primer will prepend to your next message.`
          : restoreId
            ? ' Restored your earlier thread on that backend — no carry-over primer needed.'
            : ''
      }`,
      detail: `failover_from=${prevBackend}; failover_reason=${offer.errorClass}; failover_at=${this.meta?.failoverAt ?? ''}`,
      key: `failover-applied-${target}`
    });
  }

  private enqueueIpc(sessionId: string, update: SessionUpdate, immediate: boolean): void {
    // If the session id changes mid-queue (shouldn't), flush first.
    if (this.ipcSessionId && this.ipcSessionId !== sessionId) {
      this.flushIpcImmediate();
    }
    this.ipcSessionId = sessionId;
    this.ipcQueue.push(update);
    if (immediate) {
      this.flushIpcImmediate();
      return;
    }
    if (this.ipcTimer === undefined) {
      this.ipcTimer = setTimeout(() => this.flushIpcImmediate(), 24);
    }
  }

  private flushIpcImmediate(): void {
    if (this.ipcTimer !== undefined) {
      clearTimeout(this.ipcTimer);
      this.ipcTimer = undefined;
    }
    if (this.ipcQueue.length === 0) return;
    const sessionId = this.ipcSessionId ?? this.meta?.id ?? '';
    const batch = this.ipcQueue.splice(0, this.ipcQueue.length);
    this.perf.recordIpcFlush(batch.length);
    if (batch.length === 1) {
      this.panel.post({ type: 'sessionUpdate', sessionId, update: batch[0] });
    } else {
      this.panel.post({ type: 'sessionUpdates', sessionId, updates: batch });
    }
  }

  /** Emit a structured startup notice with diagnostic detail (resolved
   * spawn command, cwd, resume id) plumbed through the `detail` field so
   * the user can hover the notice bubble to see WHAT we're spawning when
   * the panel stalls during "Starting … agent". Also schedules a single
   * 30s follow-up "still waiting" notice — long --resume loads on multi-
   * MB jsonls can sit silent that long while claude warms its cache, so
   * the user gets an incremental progress signal instead of staring at
   * a frozen pill. Returns `onFirstEvent()` which the caller invokes
   * once the agent emits anything, to cancel the follow-up timer. */
  private postStartupNotice(opts: {
    be: BackendId;
    text: string;
    cwd: string;
    resumeId?: string;
    spawnStart: number;
    skipPin?: boolean;
  }): () => void {
    // Resolve the same spawn command the transport will use, so the
    // tooltip is the actual argv (not a generic description). Mirrors
    // StreamJsonTransport.spawnProcess() / ACPTransport spawn args. We
    // can't reach into the live transport (it hasn't fully started
    // yet), so re-derive from BACKENDS[be].buildArgs() with the same
    // inputs the transport will pass.
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const spec = BACKENDS[opts.be];
    const bin = resolveBin(spec, overrides);
    const remembered = this.rememberedConfig({ skipPin: opts.skipPin });
    const args = spec.buildArgs({
      cwd: opts.cwd,
      mode: remembered.mode,
      model: remembered.model,
      resumeId: opts.resumeId,
      effort: remembered.effort,
      allowBypass: this.allowBypass
    });
    const cmdLine = `${bin} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    const startedAt = new Date(opts.spawnStart).toLocaleTimeString();
    const detail = [
      `Command: ${cmdLine}`,
      `Cwd: ${opts.cwd}`,
      opts.resumeId ? `Resume: ${opts.resumeId}` : `Resume: (none — fresh session)`,
      `Mode: ${remembered.mode}` +
        (remembered.modeSource === 'pin' ? ' (pinned)' : '') +
        (remembered.model ? ` · model: ${remembered.model}` : '') +
        (remembered.effort && remembered.effort !== 'default' ? ` · effort: ${remembered.effort}` : ''),
      `Started: ${startedAt}`,
      `Phase: spawn + waiting for first event from agent`
    ].join('\n');
    this.panel.post({ type: 'notice', text: opts.text, detail });

    // The 30s "still waiting" nudge only makes sense when the agent
    // actually has work to do at startup — i.e., resuming a long
    // transcript (claude reads its multi-MB jsonl) or completing an
    // ACP handshake (grok). For FRESH claude sessions in `-p` mode
    // the process is alive sub-second but doesn't emit any events
    // until the user sends a prompt; the user saw the nudge fire
    // anyway and read it as "stuck" when nothing was actually wrong.
    // Skip the timer when no resume id is in play; the only signal
    // we wait for in that case is the system_init line (which we
    // now also accept as the first-event marker).
    if (!opts.resumeId) {
      this.startupNoticeCleanup = () => {};
      return this.startupNoticeCleanup;
    }

    // Tag the nudge with a unique key so it can be retroactively
    // dismissed once the agent actually wakes up. Without this, a
    // timer that fired at t=30s would leave a "still waiting" item
    // in the chat even after the agent's first event lands at
    // t=31s — exactly the stale-notice bug the user reported. The
    // key embeds spawnStart so reconnect cycles don't collide.
    const nudgeKey = `startup-nudge-${opts.spawnStart}`;
    const timer = setTimeout(() => {
      const elapsed = Math.round((Date.now() - opts.spawnStart) / 1000);
      this.panel.post({
        type: 'notice',
        text:
          `Still waiting on **${opts.be}** · ${elapsed}s elapsed. The agent may be loading a long transcript or warming a cache. Hover for the actual command.`,
        detail: `${detail}\nElapsed: ${elapsed}s\nIf this hangs much longer, cancel from the composer and start a fresh chat with /new.`,
        key: nudgeKey
      });
    }, 30_000);

    const cleanup = () => {
      clearTimeout(timer);
      // Retroactive dismiss: if the timer already fired (the agent
      // was slow but DID eventually emit), the notice is in the
      // webview's items list. Tell the webview to prune it so we
      // don't leave a stale "still waiting" hanging around forever.
      this.panel.post({ type: 'dismissNotice', key: nudgeKey });
    };
    this.startupNoticeCleanup = cleanup;
    return cleanup;
  }

  /** In-flight cancellation token for @-mention file searches. Every call
   * cancels the previous one — VS Code's `findFiles` honors the token by
   * killing the underlying ripgrep process. Without this, a quick burst of
   * keystrokes left dozens of ripgreps running in parallel against the
   * full workspace, pegging all cores on large repos like ~/docs. */
  private fileSuggestionAbort?: vscode.CancellationTokenSource;

  /** Workspace-relative paths of files currently open in editor tabs. Used as
   * a lightweight "recently used" signal to rank `@`-mention suggestions —
   * there is no public MRU API, but open tabs are a good proxy for "in use". */
  private openTabRelPaths(): Set<string> {
    const out = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        const uri = input?.uri;
        if (uri && uri.scheme === 'file') {
          out.add(vscode.workspace.asRelativePath(uri, false));
        }
      }
    }
    return out;
  }

  /** Workspace file search for @-mentions. Supports plain names (`foo.md`),
   * partial paths (`knowledge/tech/foo`), and folder queries (`classic/` →
   * everything under a `classic` folder). Globs via `buildSuggestGlob`, then
   * filters + ranks (open files first) via `rankFileSuggestions`. */
  private async getFileSuggestions(query: string): Promise<Array<{ path: string; label?: string }>> {
    // Cancel any previous in-flight search before issuing a new one. The
    // previous ripgrep subprocess gets killed promptly so it doesn't keep
    // burning CPU after the user has already typed a more specific query.
    this.fileSuggestionAbort?.cancel();
    this.fileSuggestionAbort?.dispose();
    const tokenSource = new vscode.CancellationTokenSource();
    this.fileSuggestionAbort = tokenSource;
    const token = tokenSource.token;

    const openPaths = this.openTabRelPaths();
    const q = query.trim();
    if (!q) {
      // Bare `@`: a full-workspace scan would just show 25 arbitrary files.
      // Instead surface the recently-used (open) files as defaults.
      return [...openPaths].slice(0, 25).map((rel) => ({ path: rel, label: path.basename(rel) }));
    }

    const max = 200;
    const pattern = buildSuggestGlob(q);

    try {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max, token);
      if (token.isCancellationRequested) return [];
      const candidates = uris.map((uri) => {
        const rel = vscode.workspace.asRelativePath(uri, false);
        return { path: rel, label: path.basename(rel) };
      });
      return rankFileSuggestions(q, candidates, openPaths).slice(0, 25);
    } catch {
      return [];
    }
  }

  /** Map dropped `file://` URIs to workspace-relative paths (rejecting any that
   * escape the workspace). Images are base64-encoded so the webview can show a
   * tile; other files are returned as `@path` insertions. */
  private async resolveDroppedUris(
    uris: string[]
  ): Promise<Array<{ path: string; isImage: boolean; mimeType?: string; data?: string; name?: string }>> {
    const out: Array<{ path: string; isImage: boolean; mimeType?: string; data?: string; name?: string }> = [];
    for (const raw of uris) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(raw, true);
      } catch {
        continue;
      }
      if (uri.scheme !== 'file') continue;
      const rel = vscode.workspace.asRelativePath(uri, false);
      // asRelativePath returns the original absolute path when the file is
      // outside every workspace folder — skip those (constrain to resources).
      if (path.isAbsolute(rel)) continue;
      try {
        const stat = await fs.stat(uri.fsPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const name = path.basename(rel);
      if (isImagePath(rel)) {
        try {
          const bytes = await fs.readFile(uri.fsPath);
          out.push({
            path: rel,
            isImage: true,
            mimeType: this.imageMimeFor(rel),
            data: bytes.toString('base64'),
            name
          });
          continue;
        } catch {
          // Fall through to a plain @path insertion if the read fails.
        }
      }
      out.push({ path: rel, isImage: false, name });
    }
    return out;
  }

  private imageMimeFor(p: string): string {
    const ext = path.extname(p).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.svg') return 'image/svg+xml';
    return `image/${ext.slice(1) || 'png'}`;
  }

  /** Resolve an @-mention token to an absolute file path: absolute > cwd-relative
   * > any workspace folder. Returns undefined if no existing file matches. */
  private async resolveMentionPath(token: string, cwd: string): Promise<string | undefined> {
    const candidates: string[] = [];
    if (path.isAbsolute(token)) candidates.push(token);
    else {
      candidates.push(path.resolve(cwd, token));
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(path.resolve(folder.uri.fsPath, token));
      }
    }
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        /* try next */
      }
    }
    return undefined;
  }

  /**
   * Convert user text containing @path or @browser mentions into mixed ContentBlock[]
   * with resource_link entries. Falls back to original text blocks when no mentions.
   * This enables @-file (and @-browser) references to flow to all backends via the
   * existing resource_link support in ACP + Claude stream-json.
   */
  private async enrichBlocksWithFileMentions(
    blocks: ContentBlock[],
    cwd: string
  ): Promise<ContentBlock[]> {
    const textBlock = blocks.find((b) => b.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;
    if (!textBlock) return blocks;

    const text = textBlock.text;
    // Match @token (paths or 'browser')
    const mentionRe = /@([^\s"'`<>|]+)/g;
    const matches: Array<{ index: number; len: number; token: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = mentionRe.exec(text)) !== null) {
      matches.push({ index: m.index, len: m[0].length, token: m[1] });
    }
    if (matches.length === 0) return blocks;

    const out: ContentBlock[] = [];
    let last = 0;
    for (const match of matches) {
      if (match.index > last) {
        out.push({ type: 'text', text: text.slice(last, match.index) });
      }
      const token = match.token;
      if (token.toLowerCase() === 'browser' || token.toLowerCase() === 'web') {
        out.push({
          type: 'resource_link',
          uri: 'browser://current',
          name: 'Current browser / web context'
        });
        last = match.index + match.len;
        continue;
      }
      // Resolve as a file: absolute, then cwd-relative, then any workspace folder.
      const resolved = await this.resolveMentionPath(token, cwd);
      if (resolved) {
        out.push({ type: 'resource_link', uri: `file://${resolved}`, name: path.basename(resolved) });
        last = match.index + match.len;
        continue;
      }
      // Not resolved: keep the literal @token text
      out.push({ type: 'text', text: text.slice(match.index, match.index + match.len) });
      last = match.index + match.len;
    }
    if (last < text.length) {
      out.push({ type: 'text', text: text.slice(last) });
    }
    return out.length ? out : blocks;
  }

  dispose(): void {
    if (this.perfHudTimer) {
      clearInterval(this.perfHudTimer);
      this.perfHudTimer = undefined;
    }
    this.hostSttStop();
    stopSay();
    this.teardownSession();
    this.store.dispose();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';
  }

  private killReplayChild(): void {
    const child = this.replayChild;
    this.replayChild = undefined;
    if (!child || child.killed) return;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /**
   * Parse JSONL in a child process (or yielding in-process fallback).
   * Host only forwards batches — never readFileSync of the body.
   */
  private startTranscriptReplay(
    filePath: string,
    meta: SessionMeta,
    be: BackendId,
    connect: boolean,
    skipReplay: boolean
  ): void {
    this.killReplayChild();
    const worker = this.context.asAbsolutePath('dist/transcriptWorker.js');
    if (!fsSync.existsSync(worker)) {
      void this.replayInProcess(filePath, meta, be, connect, skipReplay);
      return;
    }
    const child = fork(worker, [filePath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.replayChild = child;
    child.on('message', (raw: ReplayEvent) => {
      if (this.replayChild !== child) return;
      this.onReplayEvent(raw, meta, be, connect, skipReplay, () => {
        if (this.replayChild === child && child.connected) child.send({ type: 'more' });
      });
    });
    child.on('error', (err) => {
      if (this.replayChild !== child) return;
      this.panel.post({
        type: 'historyProgress',
        phase: 'error',
        bytesRead: 0,
        bytesTotal: 0,
        records: 0,
        error: err.message
      });
      this.killReplayChild();
    });
    child.on('exit', (code) => {
      if (this.replayChild !== child) return;
      this.replayChild = undefined;
      if (code && code !== 0) {
        this.panel.post({
          type: 'historyProgress',
          phase: 'error',
          bytesRead: 0,
          bytesTotal: 0,
          records: 0,
          error: `transcript worker exited ${code}`
        });
      }
    });
  }

  private async replayInProcess(
    filePath: string,
    meta: SessionMeta,
    be: BackendId,
    connect: boolean,
    skipReplay: boolean
  ): Promise<void> {
    await replayTranscriptFile(filePath, async (ev) => {
      await new Promise<void>((r) => setImmediate(r));
      this.onReplayEvent(ev, meta, be, connect, skipReplay, () => {
        /* in-process: emit already awaited a tick */
      });
    });
  }

  private onReplayEvent(
    ev: ReplayEvent,
    meta: SessionMeta,
    be: BackendId,
    connect: boolean,
    skipReplay: boolean,
    requestMore: () => void
  ): void {
    if (ev.type === 'progress') {
      this.panel.post({
        type: 'historyProgress',
        phase: 'loading',
        bytesRead: ev.bytesRead,
        bytesTotal: ev.bytesTotal,
        records: ev.recordCount
      });
      return;
    }
    if (ev.type === 'batch') {
      this.panel.post({
        type: 'historyBatch',
        meta,
        records: ev.records as never,
        bytesRead: ev.bytesRead,
        bytesTotal: ev.bytesTotal,
        recordsSoFar: ev.recordCount
      });
      // Yield so the webview can paint; worker waits for `more`.
      setImmediate(requestMore);
      return;
    }
    if (ev.type === 'error') {
      this.panel.post({
        type: 'historyProgress',
        phase: 'error',
        bytesRead: 0,
        bytesTotal: 0,
        records: 0,
        error: ev.message
      });
      this.killReplayChild();
      return;
    }
    if (ev.type === 'done') {
      this.killReplayChild();
      this.panel.post({
        type: 'historyProgress',
        phase: 'done',
        bytesRead: ev.bytesTotal,
        bytesTotal: ev.bytesTotal,
        records: ev.recordCount
      });
      this.openSpan?.mark('resume.replay');
      this.applyReplayPrimer(ev.lastRecords, be, connect, skipReplay);
    }
  }

  private applyReplayPrimer(
    lastRecords: ReplayRecord[],
    be: BackendId,
    connect: boolean,
    skipReplay: boolean
  ): void {
    const nativeResume =
      BACKENDS[be].supportsResume &&
      !!(this.meta?.backendSessionId ??
        (this.meta?.source === 'claude' || this.meta?.source === 'grok' ? this.meta.id : undefined));
    if (lastRecords.length === 0) return;
    const primer = serializeSelfResumePrimer({
      records: lastRecords as never,
      lastNTurns: 10,
      backendLabel: backendLabel(be)
    });
    if (primer && !nativeResume) {
      this.pendingPrimer = primer;
      if (connect && !skipReplay) {
        this.panel.post({
          type: 'notice',
          text: `Restored conversation context — the last 10 turns will be prepended to your first message so ${be} has memory of the prior chat.`,
          detail: `${be} doesn't support an external --resume flag, so the new agent process is a fresh spawn with no memory of the conversation. Code Build is injecting the recent transcript as a one-shot primer; the agent uses it to pick up where it left off, then forgets it (the primer fires only on the FIRST message after this resume). Hover the audit card that'll appear above your next user message to inspect the full primer text.`
        });
      } else if (!connect) {
        this.fallbackPrimer = primer;
      }
    } else if (primer) {
      this.fallbackPrimer = primer;
    }
  }

  /**
   * Local JSONL may be an empty shell (meta + system_init) when the session
   * was opened from Claude/Grok. Prefer a contentful local row with the same
   * native id, then the upstream CLI transcript.
   */
  private resolveRestoreRecords(
    id: string,
    meta: SessionMeta
  ): { records: Array<{ type: string; [k: string]: unknown }>; olderFromByte: number } {
    const local = this.store.loadTail(id);
    if (hasVisibleReplayRecords(local.records)) {
      return { records: local.records, olderFromByte: local.olderFromByte };
    }
    const nativeId = meta.backendSessionId || id;
    // Prefer the store's native-id join (includes backendSessionHistory so a
    // post-/compact shell keyed on the NEW id still finds the contentful row
    // that recorded the OLD id). Fall back to a same-cwd sibling scan.
    const owned = this.store.findLocalSessionForNative(nativeId, meta.cwd);
    const siblings = (
      owned && owned.id !== id
        ? [owned]
        : this.store.list().filter(
            (m) =>
              m.id !== id &&
              (m.id === nativeId ||
                m.backendSessionId === nativeId ||
                (m.backendSessionHistory ?? []).some((h) => h.id === nativeId))
          )
    ).slice();
    siblings.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const sib of siblings) {
      const tail = this.store.loadTail(sib.id);
      if (!hasVisibleReplayRecords(tail.records)) continue;
      this.meta = { ...meta, ...sib, title: meta.title || sib.title };
      this.panel.setTitle?.(this.meta.title);
      this.rememberLast(sib.id);
      return { records: tail.records, olderFromByte: tail.olderFromByte };
    }
    const cwd = meta.cwd || this.cwd;
    if (meta.source === 'claude' || meta.backend === 'claude') {
      const replay = loadClaudeHistory(claudeJsonlPathFor(cwd, nativeId));
      if (replay && replay.records.length > 0) {
        return { records: replay.records as never, olderFromByte: 0 };
      }
    }
    if (meta.source === 'grok' || meta.backend === 'grok') {
      const grokPath = grokChatPathFor(cwd, nativeId);
      const replay =
        loadGrokHistory(grokPath) ??
        (locateGrokChatHistory(nativeId)
          ? loadGrokHistory(locateGrokChatHistory(nativeId) as string)
          : null);
      if (replay && replay.records.length > 0) {
        return { records: replay.records as never, olderFromByte: 0 };
      }
    }
    return { records: local.records, olderFromByte: local.olderFromByte };
  }

  /** Scroll-up: one JSONL window before the records already in the webview. */
  private loadOlderHistory(): void {
    const id = this.meta?.id;
    if (!id || this.historyOlderBusy) return;
    if (this.historyOlderFrom <= 0) {
      this.panel.post({
        type: 'historyOlder',
        meta: this.meta!,
        records: [],
        hasOlder: false
      });
      return;
    }
    this.historyOlderBusy = true;
    try {
      const page = this.store.loadBefore(id, this.historyOlderFrom);
      this.historyOlderFrom = page.olderFromByte;
      this.panel.post({
        type: 'historyOlder',
        meta: page.meta ?? this.meta!,
        records: page.records as never,
        hasOlder: page.olderFromByte > 0
      });
    } finally {
      this.historyOlderBusy = false;
    }
  }

  /**
   * Load a previous persisted session.
   * - `connect: true` (default) — spawn the agent (Open Previous / first prompt).
   * - `connect: false` — replay transcript only. VS Code remount / sidebar
   *   restore uses this so we don't auto-start an agent and stamp "Starting…"
   *   as if work just began.
   * - `skipReplay: true` — connect a session whose transcript is already on
   *   screen (idle-resume → first prompt).
   */
  async loadExistingSession(
    id: string,
    opts?: {
      connect?: boolean;
      skipReplay?: boolean;
      /** Post-/compact respawn: spawn fresh at the same CB session id —
       * never resume the pre-compact native thread — and stamp the new
       * system_init's id rotation with reason 'compact'. */
      compactRespawn?: boolean;
    }
  ): Promise<void> {
    const meta = this.store.loadMeta(id);
    if (!meta) {
      this.panel.post({
        type: 'sessionUpdate',
        sessionId: id,
        update: { kind: 'error', message: `Could not load session ${id}` }
      });
      return;
    }
    if (!sessionMatchesWorkspace(meta.cwd, this.workspaceFolderPaths())) {
      this.panel.post({
        type: 'notice',
        text: `Not restoring session from another workspace (${meta.cwd || 'unknown cwd'}).`,
        detail: 'codeBuild.lastSessionId is workspace-scoped. Open the original folder to continue that chat.'
      });
      return;
    }

    const connect = opts?.connect ?? true;
    const skipReplay = opts?.skipReplay === true;

    // teardownSession zeroes the older-history cursor; on a skipReplay
    // reconnect the webview keeps its painted page, so losing the cursor
    // would break "load older" until a full reopen.
    const preservedOlderFrom = this.historyOlderFrom;
    this.teardownSession();
    if (skipReplay) this.historyOlderFrom = preservedOlderFrom;
    // Arm AFTER teardown (teardown clears the field): the respawned
    // backend's first system_init must be labeled 'compact', not 'respawn'.
    if (opts?.compactRespawn) this.pendingBackendIdReason = 'compact';
    if (!skipReplay) {
      this.userTurnsSent = 0;
      this.lastUserText = '';
      this.currentAssistantBuf = '';
    }

    const be = meta.backend;
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    const earlyResumeId = resolveRespawnResumeId(meta, opts?.compactRespawn === true);
    this.meta = meta;
    if (this.meta.backendSessions) {
      for (const [b, sid] of Object.entries(this.meta.backendSessions)) {
        if (sid) this.previousSessionByBackend.set(b as BackendId, sid);
      }
    }
    this.titled = true;
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    this.rememberLast(this.meta.id);

    if (!skipReplay) {
      const painted = this.resolveRestoreRecords(id, meta);
      this.historyOlderFrom = painted.olderFromByte;
      this.panel.post({
        type: 'historyLoaded',
        meta: this.meta ?? meta,
        records: painted.records as never,
        hasOlder: painted.olderFromByte > 0
      });
      this.postCheckpointIds();
      this.applyReplayPrimer(painted.records, be, connect, skipReplay);
    }

    if (!connect) {
      this.idleResume = true;
      this.panel.post({
        type: 'notice',
        key: 'idle-restore',
        text: `Transcript restored — agent is idle. Send a message to reconnect. Nothing is running.`,
        detail: `VS Code remounted this chat (window reload or sidebar restore). Code Build is showing the on-disk transcript and is not spawning ${be}. Previously every restore auto-started the CLI, which made "Starting … agent" / "first event in 0.8s" look like work had just begun.`
      });
      return;
    }

    this.idleResume = false;
    this.panel.post({ type: 'dismissNotice', key: 'idle-restore' });

    const spawnStart = Date.now();
    // Open Previous still shows "Resuming uuid…". skipReplay is the
    // first prompt after an idle restore — the user already sent a
    // message; chat notices here stole the last-item slot, hid the
    // working pill, and scrolled the You-bubble off screen.
    const cancelNudge = skipReplay
      ? () => {}
      : this.postStartupNotice({
          be,
          text: `Resuming \`${id.slice(0, 8)}\` (${be})…`,
          cwd: meta.cwd,
          resumeId: earlyResumeId,
          spawnStart
        });
    let firstEventAt = 0;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.perf.setSessionMeta({
      sessionId: id,
      backend: meta.backend,
      model: meta.model,
      modePerm: meta.mode
    });
    this.unsubscribe = this.session.onEvent((update) => {
      this.routeAgentUpdate(id, update, {
        onFirstEvent: () => {
          if (firstEventAt) return;
          firstEventAt = Date.now();
          const ms = firstEventAt - spawnStart;
          cancelNudge();
          if (skipReplay) return;
          this.panel.post({
            type: 'notice',
            text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
          });
        }
      });
    });

    // Resume the agent with its NATIVE session id when we have one.
    // Two paths reach a resumable id:
    //   1. The session was opened in code-build originally — we captured
    //      claude's `session_id` from the `system` init line into
    //      `meta.backendSessionId` (see captureBackendSessionId).
    //   2. The session was imported via openExternalSession — the local
    //      id IS claude's session id (set as `id = args.sessionId`).
    // Pre-fix, loadExistingSession spawned claude without `--resume` at
    // all, so the user reload landed on a fresh agent with no memory
    // of the prior conversation. The auto-fallback in
    // StreamJsonTransport still kicks in if --resume fails (e.g. the
    // jsonl was deleted), so a stale id can't get us stuck.
    const mode = this.meta.mode ?? this.config.get<PermissionMode>('initialPermissionMode', 'default');
    await this.session.start({
      cwd: this.meta.cwd,
      mode,
      resumeId: earlyResumeId,
      model: this.meta.model,
      effort: this.meta.effort,
      allowBypass: this.allowBypass,
      additionalTrustedDirs: this.trustedDirs(mode),
      onFsPreWrite: (absPath) => this.captureFsPreWrite(absPath)
    });
  }
}

/** Pick the most "used" model from a per-model UsageInfo breakdown:
 * highest output token count wins (output tokens are the strongest
 * predictor of which model did the actual generation, vs cache reads
 * which can be lopsided). Falls back to the first entry, then null. */
/** Look up whether a Claude session id is currently held by a live claude
 * process. Claude Code writes `~/.claude/sessions/<pid>.json` while a
 * session is running and removes it on clean exit; the file records the
 * pid + sessionId + cwd + entrypoint. We iterate those files, match on
 * sessionId, and verify the pid is alive via `process.kill(pid, 0)`
 * (POSIX signal-0 probe — throws if the pid is dead, returns silently if
 * alive). Returns the holder info or undefined when nothing claims it. */
interface ClaudeSessionHolder {
  pid: number;
  cwd?: string;
  entrypoint?: string;
}
function findActiveClaudeHolder(sessionId: string): ClaudeSessionHolder | undefined {
  // require() rather than top-level import: the helper is host-only (uses
  // fs / os) and we want a self-contained pluck so changing the guard
  // doesn't ripple into other call sites.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const obj = JSON.parse(raw) as { pid?: number; sessionId?: string; cwd?: string; entrypoint?: string };
      if (obj.sessionId !== sessionId || typeof obj.pid !== 'number') continue;
      // Signal-0 probe: throws ESRCH if the pid is dead. Anything else
      // (EPERM, success) means the process exists.
      try { process.kill(obj.pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') continue;
      }
      return { pid: obj.pid, cwd: obj.cwd, entrypoint: obj.entrypoint };
    } catch {
      /* skip malformed control files */
    }
  }
  return undefined;
}

function pickDominantModel(byModel: Array<{ model?: string; outputTokens?: number }>): string | undefined {
  if (byModel.length === 0) return undefined;
  let best: { model?: string; outputTokens?: number } | undefined;
  for (const m of byModel) {
    if (!m.model) continue;
    if (!best || (m.outputTokens ?? 0) > (best.outputTokens ?? 0)) best = m;
  }
  return best?.model;
}

/** Mechanical summary used when the source backend doesn't support the
 * one-shot LLM fork (today: anything other than claude). Returns just
 * the summary string — the caller wraps it into the hybrid primer. */
function clippedSummaryFallback(
  records: { type: string; text?: string; update?: any }[],
  fromBackend: string
): string {
  const full = serializeConversation(records, 'summary', fromBackend);
  // Strip the outer <conversation-context> wrapper; the hybrid
  // serializer adds its own. We just want the inner turns text.
  return full.replace(/<\/?conversation-context[^>]*>/g, '').trim();
}

/** Human label for a backend id (used in the carry-over banner copy). */
function backendLabel(id: BackendId): string {
  const map: Record<string, string> = {
    claude: 'Claude Code',
    grok: 'Grok',
    codex: 'Codex',
    opencode: 'opencode',
    cline: 'Cline'
  };
  return map[id] ?? id;
}

/** Make a short, human-readable session title from the first user message. */
function deriveTitle(text: string): string {
  const base = cleanCommandText(text);
  const firstLine = base.trim().split('\n').find((l) => l.trim().length > 0) ?? base.trim();
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  const max = 60;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + '…' : cleaned || 'New chat';
}
