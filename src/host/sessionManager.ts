import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { BackendId, ContentBlock, PermissionMode, SessionUpdate } from '../shared/acpTypes';
import type { HydrateState, SessionMeta, SessionSource, WebviewToHost } from '../shared/protocol';
import { cleanCommandText } from '../shared/cleanCommandText';
import type { ChatSurface } from './webviewHtml';
import { detectAll, BACKENDS, resolveBin, claudeFamilyAlias } from './backendRegistry';
import type { AgentSession } from './agentSession';
import { createSession } from './transports/factory';
import { EditorTools } from './editorBridge/editorTools';
import { buildSuggestGlob, rankFileSuggestions, isImagePath } from './fileSuggest';
import { SessionStore } from './persistence/store';
import {
  claudeJsonlPathFor,
  grokChatPathFor,
  loadClaudeHistory,
  loadGrokHistory
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
import { spawn } from 'node:child_process';
import { classifyTurn } from './classifier';
import { scanMemorySources, summariseSources } from './memoryScan';
import { TurnWatchdog } from './turnWatchdog';

/**
 * Owns one chat panel + its live AgentSession. (P5 will generalize to N panels.)
 * Routes webview commands to the session and session events back to the webview.
 */
export class SessionManager {
  private session?: AgentSession;
  private meta?: SessionMeta;
  private unsubscribe?: () => void;
  private titled = false;
  private pendingResumeId?: string;
  private webviewReady = false;
  private readonly editor = new EditorTools();
  private readonly store = new SessionStore();

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
  /** Tool-call ids the agent has opened but not yet finished this turn. A
   * turn with an open tool is doing a (possibly long, silent) command, so
   * the watchdog warns but does NOT auto-cancel it. */
  private readonly openToolCalls = new Set<string>();
  /** True while a permission_request is outstanding (the agent is blocked on a
   * human decision). Combined with pending AskUserQuestions, this tells the
   * stall watchdog the turn is legitimately paused on the user, not stuck. */
  private awaitingPermission = false;

  constructor(
    private readonly panel: ChatSurface,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.onMessage((msg) => void this.handle(msg));
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
        await this.hydrate();
        // If a resume was queued before the webview mounted, run it now so the
        // historyLoaded message isn't dropped (the React app only listens after mount).
        if (this.pendingResumeId) {
          const id = this.pendingResumeId;
          this.pendingResumeId = undefined;
          await this.loadExistingSession(id);
        } else if (this.pendingExternal) {
          const ext = this.pendingExternal;
          this.pendingExternal = undefined;
          await this.openExternalSession(ext);
        }
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
      case 'newSession':
        // Fresh slate — clear the per-backend restore memory so the
        // new chat doesn't accidentally inherit any prior thread.
        this.previousSessionByBackend.clear();
        await this.openSession(msg.backend);
        break;
      case 'pickBackend':
        await this.switchBackend(msg.backend);
        break;
      case 'primerDecision':
        void this.applyPrimerDecision(msg.choice, msg.lastNTurns);
        break;
      case 'askUserAnswer':
        this.answerAskUserQuestion(msg.toolCallId, msg.answers);
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
        await this.ensureSession();
        this.panel.post({ type: 'busy', busy: true });
        // Arm the stall watchdog for this turn (D1). The silence clock starts
        // now, at submission, so a turn that produces NO output at all (the
        // claude `error_during_execution`/0-token stall) is still caught.
        this.armWatchdog();
        const originalText = msg.blocks.find((b) => b.type === 'text')?.text ?? '';
        if (originalText) {
          // First real prompt: promote to history + derive a title from it.
          this.commitAndTitle(originalText);
          this.store.appendUserText(this.meta!.id, originalText);
        }
        // Stash for the classifier (paired with the upcoming
        // assistant text on the next `result`). Bumps turnIndex AFTER
        // assignment so the count matches the webview's 0-based
        // user-bubble index in the items list.
        this.lastUserText = originalText;
        this.currentAssistantBuf = '';
        const enriched = await this.enrichBlocksWithFileMentions(msg.blocks, this.cwd);
        let blocks = enriched;
        const usedPrimer = this.pendingPrimer;
        // One-shot context handoff: if the user switched backend and chose to
        // carry context, prepend the serialized prior conversation as a
        // leading text block, then clear it so it's only sent once.
        if (this.pendingPrimer) {
          blocks = [{ type: 'text', text: this.pendingPrimer }, ...blocks];
          this.pendingPrimer = undefined;
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
          this.panel.post({
            type: 'sessionUpdate',
            sessionId: this.meta!.id,
            update: { kind: 'error', message: String(err) }
          });
        });
        break;
      }
      case 'cancel':
        this.session?.cancel();
        this.panel.post({ type: 'busy', busy: false });
        break;
      case 'setMode':
        this.setMode(msg.mode);
        break;
      case 'setModel':
        this.setModel(msg.model);
        break;
      case 'setEffort':
        this.setEffort(msg.effort);
        break;
      case 'respondPermission':
        // User decided — resume normal stall watching for the continuation.
        this.awaitingPermission = false;
        this.session?.respondPermission(msg.requestId, msg.outcome);
        break;
      case 'openDiff':
        await this.editor.openDiff(msg.path, msg.oldText, msg.newText);
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
    }
  }

  private async hydrate(): Promise<void> {
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const backends = await detectAll(overrides);
    const allowBypass = this.config.get<boolean>('allowDangerouslySkipPermissions', false);
    const defaultBackend = this.defaultBackend();
    // Memory inventory snapshot for the Header chip. Cheap scan
    // (handful of stat()+readFile()s); rerun on every hydrate so a
    // panel reload or session swap picks up CLAUDE.md edits.
    const wsRoots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    const memSources = scanMemorySources(wsRoots);
    const memTotals = summariseSources(memSources);
    const state: HydrateState = {
      session: this.meta ?? null,
      backends,
      allowBypass,
      sessions: this.store.list().slice(0, 100),
      defaultBackend,
      memoryEntries: memTotals.totalEntries,
      memoryFiles: memTotals.totalFiles,
      memoryByProvider: memTotals.byProvider,
      showActiveQuestionBanner: this.config.get<boolean>('showActiveQuestionBanner', true)
    };
    this.panel.post({ type: 'hydrate', state });

    // Eager-start the default backend session (like Claude Code connects on open) so
    // the agent's slash commands surface immediately — but only if it's installed and
    // we don't already have a live session.
    const autoStart = this.config.get<boolean>('autoStartSession', true);
    const defaultAvailable = backends.find((b) => b.id === defaultBackend)?.available;
    // Don't auto-start a blank session if we're about to resume a previous one.
    if (autoStart && !this.session && defaultAvailable && !this.pendingResumeId && !this.pendingExternal) {
      await this.openSession(defaultBackend);
    }
  }

  private defaultBackend(): BackendId {
    return this.config.get<BackendId>('defaultBackend', 'claude');
  }

  private async ensureSession(): Promise<void> {
    if (!this.session) {
      await this.openSession(this.defaultBackend());
    }
  }

  /** Handle the backend dropdown. If the current chat already has content
   * AND the backend actually changes, capture the prior transcript and ask
   * the user whether to carry it over before spinning up the new backend. */
  private async switchBackend(backend: BackendId): Promise<void> {
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
      let records: { type: string; text?: string; update?: any }[] = [];
      const source = this.meta?.source;
      if ((source === 'claude' || source === 'grok') && this.meta?.cwd) {
        try {
          const replay =
            source === 'claude'
              ? loadClaudeHistory(claudeJsonlPathFor(this.meta.cwd, this.meta.id))
              : loadGrokHistory(grokChatPathFor(this.meta.cwd, this.meta.id));
          if (replay) records.push(...(replay.records as any));
        } catch {
          /* missing file / parse error — fall through to local store */
        }
      }
      const loaded = this.store.load(prevId);
      records.push(...loaded.records.filter((r) => r.type !== 'meta'));

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

    await this.openSession(backend);
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
          ? await this.summarizeViaClaude(held.records, held.sourceModel)
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
    model?: string
  ): Promise<string> {
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const bin = overrides['claude'] || 'claude';
    const transcript = buildTranscriptForSummary(records);
    const prompt =
      `You are summarising a conversation between a user and an AI coding ` +
      `assistant for handoff to a DIFFERENT AI assistant. The new assistant ` +
      `has zero prior context. Write a concise summary (200–400 words) ` +
      `covering: the user's goal, key findings/decisions, current task ` +
      `state, files involved, and any outstanding questions. Don't include ` +
      `verbatim turns (those will be appended separately). Just the summary text.\n\n` +
      `=== CONVERSATION ===\n${transcript}\n=== END ===\n\nSUMMARY:`;

    const args = ['-p', '--output-format', 'json'];
    if (model && model !== 'default') args.push('--model', model);

    return new Promise<string>((resolve, reject) => {
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
          const obj = JSON.parse(stdout) as { result?: string; text?: string };
          const text = (obj.result || obj.text || '').trim();
          if (!text) return reject(new Error('claude returned an empty summary'));
          resolve(text);
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

  /** Sticky config remembered across sessions in globalState. The user's
   * last mode / model / effort selection is restored on every new session
   * so they don't have to re-pick bypass + model each time. Bypass is only
   * restored when the escape hatch is still enabled in settings. */
  private rememberedConfig(): { mode: PermissionMode; model?: string; effort: SessionMeta['effort'] } {
    const g = this.context.globalState;
    let mode = g.get<PermissionMode>('lastMode')
      ?? this.config.get<PermissionMode>('initialPermissionMode', 'default');
    if (mode === 'bypass' && !this.allowBypass) mode = 'default';
    const model =
      g.get<string>('lastModel')
      ?? (this.config.get<string>('defaultModel', '') || undefined);
    const effort =
      g.get<SessionMeta['effort']>('lastEffort')
      ?? this.config.get<SessionMeta['effort']>('defaultEffort', 'default')
      ?? 'default';
    return { mode, model: model || undefined, effort };
  }

  /** Persist the current selection so the next session restores it. */
  private rememberConfig(): void {
    if (!this.meta) return;
    void this.context.globalState.update('lastMode', this.meta.mode);
    void this.context.globalState.update('lastModel', this.meta.model ?? '');
    void this.context.globalState.update('lastEffort', this.meta.effort ?? 'default');
  }

  private async openSession(backend?: BackendId): Promise<void> {
    this.teardownSession();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';
    const id = crypto.randomUUID();
    const be = backend ?? this.defaultBackend();
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

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
      spawnStart
    });
    let firstEventAt = 0;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      this.watchTurnLiveness(update);
      // First time we see anything from the agent — surface the spawn
      // time so the user knows whether the slowness is in our spawn (a
      // few hundred ms) or in the agent's first-event latency (often
      // seconds, especially with --resume on a long history). Also
      // cancels the "still waiting" follow-up nudge so it doesn't fire
      // after we've already become responsive.
      if (!firstEventAt && (update.kind === 'agent_message_chunk' || update.kind === 'agent_thought_chunk' || update.kind === 'tool_call' || update.kind === 'available_commands_update' || update.kind === 'system_init')) {
        firstEventAt = Date.now();
        const ms = firstEventAt - spawnStart;
        cancelNudge();
        this.panel.post({
          type: 'notice',
          text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
        });
      }
      // Side-channel: intercept structured tool calls (AskUserQuestion,
      // TodoWrite) so the webview can render purpose-built UI instead of
      // a generic tool card.
      this.interceptToolCall(update);
      this.onTurnEvent(update);
      this.captureBackendSessionId(update);
      if (update.kind === 'result' || update.kind === 'error') {
        this.panel.post({ type: 'busy', busy: false });
      }
    });

    // Restore the user's last-used mode / model / effort so a fresh session
    // picks up where they left off (bypass stays sticky when still enabled).
    const remembered = this.rememberedConfig();
    // A model remembered from a different backend (e.g. 'opus' carried into
    // grok) won't be valid — drop to the backend's default in that case.
    const validModels = BACKENDS[be].models ?? [];
    const model =
      remembered.model && validModels.includes(remembered.model) ? remembered.model : undefined;

    this.meta = {
      id,
      backend: be,
      title: `New chat · ${be}`,
      mode: remembered.mode,
      cwd: this.cwd,
      createdAt: Date.now(),
      model,
      effort: remembered.effort
    };
    this.titled = false;
    // Write the transcript header but do NOT index yet (lazy: see commitAndTitle).
    this.store.createSession(this.meta);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    await this.session.start({
      cwd: this.cwd,
      mode: remembered.mode,
      model: this.meta.model,
      effort: this.meta.effort,
      allowBypass: this.allowBypass,
      additionalTrustedDirs: this.trustedDirs(remembered.mode)
    });
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

    if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
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
    this.awaitingPermission = false;
    const warnMs = Math.max(0, this.config.get<number>('stallWarnSeconds', 45)) * 1000;
    const autoCancelMs = Math.max(0, this.config.get<number>('stallAutoCancelSeconds', 120)) * 1000;
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
        this.awaitingPermission = false;
        this.watchdog.clear();
        this.panel.post({ type: 'dismissNotice', key: 'turn-stall' });
        break;
      default:
        break;
    }
  }

  private onTurnEvent(update: SessionUpdate): void {
    if (update.kind === 'agent_message_chunk' && update.content?.type === 'text') {
      this.currentAssistantBuf += update.content.text ?? '';
      return;
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
   * continue from"). Only writes once per session — the field is
   * permanent for the conversation. */
  private captureBackendSessionId(update: SessionUpdate): void {
    if (update.kind !== 'system_init') return;
    if (!this.meta) return;
    if (this.meta.backendSessionId === update.backendSessionId) return;
    this.meta.backendSessionId = update.backendSessionId;
    this.store.updateMeta(this.meta);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
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
  private answerAskUserQuestion(toolCallId: string, answers: Record<string, string>): void {
    const pending = this.pendingAskUserQuestions.get(toolCallId);
    if (!pending) return;
    this.pendingAskUserQuestions.delete(toolCallId);
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

  private setMode(mode: PermissionMode): void {
    if (this.meta) {
      this.meta.mode = mode;
      this.panel.post({ type: 'sessionMeta', session: this.meta });
    }
    this.session?.setMode(mode);
    this.rememberConfig();
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
  queueResume(id: string): void {
    if (this.webviewReady) {
      void this.loadExistingSession(id);
    } else {
      this.pendingResumeId = id;
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
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      this.watchTurnLiveness(update);
      if (!firstEventAt && (update.kind === 'agent_message_chunk' || update.kind === 'agent_thought_chunk' || update.kind === 'tool_call' || update.kind === 'available_commands_update' || update.kind === 'system_init')) {
        firstEventAt = Date.now();
        const ms = firstEventAt - spawnStart;
        cancelNudge();
        this.panel.post({
          type: 'notice',
          text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
        });
      }
      this.interceptToolCall(update);
      this.onTurnEvent(update);
      if (update.kind === 'result' || update.kind === 'error') {
        this.panel.post({ type: 'busy', busy: false });
      }
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
    if (!nativeResume && replay && replay.records.length > 0) {
      const primer = serializeSelfResumePrimer({
        records: replay.records as any,
        lastNTurns: 10,
        backendLabel: backendLabel(be)
      });
      if (primer) {
        this.pendingPrimer = primer;
        this.panel.post({
          type: 'notice',
          text: `Restored conversation context — the last 10 turns will be prepended to your first message so ${be} has memory of the prior chat.`,
          detail: `${be} doesn't support an external --resume flag, so the new agent process is a fresh spawn with no memory of the conversation. Code Build is injecting the recent transcript as a one-shot primer; the agent uses it to pick up where it left off, then forgets it (the primer fires only on the FIRST message after this resume). Hover the audit card that'll appear above your next user message to inspect the full primer text.`
        });
      }
    }

    await this.session.start({
      cwd: args.cwd,
      mode,
      resumeId,
      model: this.meta?.model,
      effort: this.meta?.effort,
      allowBypass: this.allowBypass,
      additionalTrustedDirs: this.trustedDirs(mode)
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
  }

  private teardownSession(): void {
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
    const remembered = this.rememberedConfig();
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
      `Mode: ${remembered.mode}` + (remembered.model ? ` · model: ${remembered.model}` : '') +
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
    this.teardownSession();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';
  }

  /** Load a previous persisted session (history + live continuation). Called from the "Open Previous" command. */
  async loadExistingSession(id: string): Promise<void> {
    const loaded = this.store.load(id);
    if (!loaded.meta) {
      this.panel.post({
        type: 'sessionUpdate',
        sessionId: id,
        update: { kind: 'error', message: `Could not load session ${id}` }
      });
      return;
    }

    this.teardownSession();
    // Reset per-session classifier state so a fresh chat starts the
    // turn counter at 0.
    this.userTurnsSent = 0;
    this.lastUserText = '';
    this.currentAssistantBuf = '';

    const be = loaded.meta.backend;
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    // Same resume-id resolution we'll pass to session.start() below —
    // hoisted so the startup notice's hover tooltip shows the actual
    // --resume <id> we're about to use (or "(none)" when we have
    // nothing to resume with).
    const earlyResumeId =
      loaded.meta.backendSessionId ?? (loaded.meta.source === 'claude' ? loaded.meta.id : undefined);
    const spawnStart = Date.now();
    const cancelNudge = this.postStartupNotice({
      be,
      text: `Resuming \`${id.slice(0, 8)}\` (${be})…`,
      cwd: loaded.meta.cwd,
      resumeId: earlyResumeId,
      spawnStart
    });
    let firstEventAt = 0;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      this.watchTurnLiveness(update);
      if (!firstEventAt && (update.kind === 'agent_message_chunk' || update.kind === 'agent_thought_chunk' || update.kind === 'tool_call' || update.kind === 'available_commands_update' || update.kind === 'system_init')) {
        firstEventAt = Date.now();
        const ms = firstEventAt - spawnStart;
        cancelNudge();
        this.panel.post({
          type: 'notice',
          text: `${be} ready · first event in ${(ms / 1000).toFixed(1)}s`
        });
      }
      this.interceptToolCall(update);
      this.onTurnEvent(update);
      if (update.kind === 'result' || update.kind === 'error') {
        this.panel.post({ type: 'busy', busy: false });
      }
    });

    this.meta = loaded.meta;
    // Re-hydrate the per-backend native-session memory so a panel reopened on
    // this conversation knows which backends already have a native thread — and
    // resumes them natively instead of re-summarizing on switch.
    if (this.meta.backendSessions) {
      for (const [b, id] of Object.entries(this.meta.backendSessions)) {
        if (id) this.previousSessionByBackend.set(b as BackendId, id);
      }
    }
    this.titled = true; // existing session already has its title
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });

    // Replay the stored transcript so the UI shows the full conversation history
    this.panel.post({ type: 'historyLoaded', meta: this.meta, records: loaded.records as any });

    // Self-resume primer for backends without native --resume (grok ACP
    // today). The new agent process has zero memory of the conversation
    // even though the user sees the history in the UI. Inject the last
    // N turns verbatim as a one-shot primer on the first prompt so the
    // agent picks up where it left off. claude with a valid resume id
    // skips this — its own `--resume` already feeds the jsonl back to
    // the model. See [[serializeSelfResumePrimer]].
    const nativeResume = BACKENDS[be].supportsResume && !!earlyResumeId;
    if (!nativeResume && loaded.records.length > 0) {
      const primer = serializeSelfResumePrimer({
        records: loaded.records as any,
        lastNTurns: 10,
        backendLabel: backendLabel(be)
      });
      if (primer) {
        this.pendingPrimer = primer;
        this.panel.post({
          type: 'notice',
          text: `Restored conversation context — the last 10 turns will be prepended to your first message so ${be} has memory of the prior chat.`,
          detail: `${be} doesn't support an external --resume flag, so the new agent process is a fresh spawn with no memory of the conversation. Code Build is injecting the recent transcript as a one-shot primer; the agent uses it to pick up where it left off, then forgets it (the primer fires only on the FIRST message after this resume). Hover the audit card that'll appear above your next user message to inspect the full primer text.`
        });
      }
    }

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
      additionalTrustedDirs: this.trustedDirs(mode)
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
