import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { BackendId, ContentBlock, PermissionMode, SessionUpdate } from '../shared/acpTypes';
import type { HydrateState, SessionMeta, SessionSource, WebviewToHost } from '../shared/protocol';
import type { ChatSurface } from './webviewHtml';
import { detectAll, BACKENDS } from './backendRegistry';
import type { AgentSession } from './agentSession';
import { createSession } from './transports/factory';
import { EditorTools } from './editorBridge/editorTools';
import { SessionStore } from './persistence/store';
import {
  claudeJsonlPathFor,
  grokChatPathFor,
  loadClaudeHistory,
  loadGrokHistory
} from './persistence/externalReplay';
import { listAllSessions } from './persistence/externalSources';
import { serializeConversation, countUserTurns, type PrimerMode } from './persistence/conversationSerializer';

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
   * held until the user answers the carry-over prompt. */
  private handoffRecords?: { records: { type: string; text?: string; update?: any }[]; fromBackend: string };
  /** Text primer to prepend to the user's NEXT prompt (one-shot). Set when
   * the user chooses Full/Summary in the carry-over banner. */
  private pendingPrimer?: string;

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
      case 'newSession':
        await this.openSession(msg.backend);
        break;
      case 'pickBackend':
        await this.switchBackend(msg.backend);
        break;
      case 'primerDecision':
        this.applyPrimerDecision(msg.choice);
        break;
      case 'askUserAnswer':
        this.answerAskUserQuestion(msg.toolCallId, msg.answers);
        break;
      case 'prompt': {
        await this.ensureSession();
        this.panel.post({ type: 'busy', busy: true });
        const originalText = msg.blocks.find((b) => b.type === 'text')?.text ?? '';
        if (originalText) {
          // First real prompt: promote to history + derive a title from it.
          this.commitAndTitle(originalText);
          this.store.appendUserText(this.meta!.id, originalText);
        }
        let blocks = await this.enrichBlocksWithFileMentions(msg.blocks, this.cwd);
        // One-shot context handoff: if the user switched backend and chose to
        // carry context, prepend the serialized prior conversation as a
        // leading text block, then clear it so it's only sent once.
        if (this.pendingPrimer) {
          blocks = [{ type: 'text', text: this.pendingPrimer }, ...blocks];
          this.pendingPrimer = undefined;
        }
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
        this.session?.respondPermission(msg.requestId, msg.outcome);
        break;
      case 'openDiff':
        await this.editor.openDiff(msg.path, msg.oldText, msg.newText);
        break;
      case 'revealLocation':
        await this.editor.revealLocation(msg.path, msg.line);
        break;
      case 'openInCoderSessions':
        if (this.meta) {
          await vscode.commands.executeCommand('codeBuild.openInCoderSessions', this.meta.id);
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
    const state: HydrateState = {
      session: this.meta ?? null,
      backends,
      allowBypass,
      sessions: this.store.list().slice(0, 100),
      defaultBackend
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
    // Snapshot the prior transcript BEFORE we tear the session down.
    let captured: { records: { type: string; text?: string; update?: any }[]; fromBackend: string } | undefined;
    if (prevId && prevBackend && prevBackend !== backend) {
      const loaded = this.store.load(prevId);
      if (loaded.records.length > 0 && countUserTurns(loaded.records) > 0) {
        captured = { records: loaded.records, fromBackend: backendLabel(prevBackend) };
      }
    }

    await this.openSession(backend);

    // After the new session is live, offer the carry-over choice. We hold the
    // captured records until the user answers (applyPrimerDecision).
    if (captured) {
      this.handoffRecords = captured;
      this.panel.post({
        type: 'primerPrompt',
        turnCount: countUserTurns(captured.records),
        fromBackend: captured.fromBackend,
        toBackend: backendLabel(backend)
      });
    }
  }

  /** Resolve the carry-over banner: serialize the held transcript per the
   * chosen fidelity and stash it as the one-shot primer (or discard). */
  private applyPrimerDecision(choice: 'full' | 'summary' | 'none'): void {
    const held = this.handoffRecords;
    this.handoffRecords = undefined;
    if (!held || choice === 'none') {
      this.pendingPrimer = undefined;
      return;
    }
    const primer = serializeConversation(held.records, choice as PrimerMode, held.fromBackend);
    this.pendingPrimer = primer || undefined;
  }

  /** Whether the user opted into the skip-permissions escape hatch. */
  private get allowBypass(): boolean {
    return this.config.get<boolean>('allowDangerouslySkipPermissions', false);
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
    const id = crypto.randomUUID();
    const be = backend ?? this.defaultBackend();
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      // Side-channel: intercept structured tool calls (AskUserQuestion,
      // TodoWrite) so the webview can render purpose-built UI instead of
      // a generic tool card.
      this.interceptToolCall(update);
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
      allowBypass: this.allowBypass
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

  /** Translate a webview-side click on an AskUserQuestion option card into
   * the upstream tool_result the backend is waiting for. Claude expects a
   * JSON string in the tool_result content; grok-build also accepts plain
   * text. We send a JSON object so claude can parse it deterministically. */
  private answerAskUserQuestion(toolCallId: string, answers: Record<string, string>): void {
    const pending = this.pendingAskUserQuestions.get(toolCallId);
    if (!pending) return;
    this.pendingAskUserQuestions.delete(toolCallId);
    // Send back as a user message of the form claude expects from the
    // built-in AskUserQuestion tool. The CLI normalises this into a
    // tool_result automatically on next prompt.
    const text = JSON.stringify({
      tool_use_id: toolCallId,
      answers
    });
    const blocks: ContentBlock[] = [{ type: 'text', text }];
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

    // Map source → backend. Default to claude when an unknown source slips
    // through (defensive — we already validated above).
    const be: BackendId = args.source === 'grok' ? 'grok' : 'claude';
    const mode = this.config.get<PermissionMode>('initialPermissionMode', 'default');
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    // Use the upstream session id as the local id. This makes
    // back-references unambiguous (the user sees the same UUID in
    // coder-sessions, in the CLI, and in code-build) and means a second
    // "Open in Code Build" click on the same row doesn't pile up dupes.
    const id = args.sessionId;

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      this.interceptToolCall(update);
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
      const dominantModel = pickDominantModel(replay.byModel ?? []);
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
    // Active-session guard for claude: when the imported jsonl was touched
    // within the last 60s the upstream CLI is presumably writing to it
    // (the session is open in another window / panel right now), and
    // `claude --resume <id>` will exit with code 1 ("session already in
    // use"). Detect this case BEFORE spawning, drop the resume flag, and
    // surface a clear warning instead. The replay above already shows the
    // transcript so the user has the conversation context either way.
    let resumeId: string | undefined = args.sessionId;
    if (args.source === 'claude') {
      try {
        const jsonl = claudeJsonlPathFor(args.cwd, args.sessionId);
        const st = require('node:fs').statSync(jsonl);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < 60_000) {
          resumeId = undefined;
          this.panel.post({
            type: 'sessionUpdate',
            sessionId: id,
            update: {
              kind: 'error',
              message:
                `This Claude session is still active in another panel (jsonl modified ${Math.round(ageMs / 1000)}s ago). ` +
                `Opening here would conflict with the running CLI, so Code Build is showing the read-only transcript ` +
                `and starting a fresh agent in \`${args.cwd}\` instead. Close the other panel and click "Open in Code Build" again to resume.`
            }
          });
        }
      } catch {
        /* if stat fails, fall through and let the transport surface any error */
      }
    }
    await this.session.start({
      cwd: args.cwd,
      mode,
      resumeId,
      model: this.meta?.model,
      effort: this.meta?.effort,
      allowBypass: this.allowBypass
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
  }

  /** Workspace file search for @-mentions. Supports paths with slashes (e.g. knowledge/tech/foo.md).
   * Strategy: glob on the last path segment (filename), then JS-filter by full relative path containing the query.
   */
  private async getFileSuggestions(query: string): Promise<Array<{ path: string; label?: string }>> {
    const q = query.trim();
    if (!q) {
      // Broad recent-ish search when just "@"
      try {
        const uris = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 50);
        return uris.slice(0, 25).map((uri) => {
          const rel = vscode.workspace.asRelativePath(uri, false);
          return { path: rel, label: path.basename(rel) };
        });
      } catch {
        return [];
      }
    }

    const lastSegment = q.includes('/') ? (q.split('/').pop() || q) : q;
    const max = 60;
    const pattern = `**/*${this.globEscape(lastSegment)}*`;

    try {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', max);
      const results = uris.map((uri) => {
        const rel = vscode.workspace.asRelativePath(uri, false);
        return { path: rel, label: path.basename(rel) };
      });

      const qLower = q.toLowerCase();
      // Keep only those whose full path matches the typed query (supports folders + partial filenames)
      const filtered = results.filter((r) => r.path.toLowerCase().includes(qLower));

      // If the typed query looks like a full path that exists exactly, make sure it surfaces even if filter was strict
      if (filtered.length === 0) {
        // Fallback: return the ones whose basename matches the last segment
        return results.filter((r) => r.path.toLowerCase().endsWith(qLower) || r.label?.toLowerCase().includes(lastSegment.toLowerCase()));
      }
      return filtered.slice(0, 25);
    } catch {
      return [];
    }
  }

  private globEscape(s: string): string {
    // Very light escaping for common specials in a **/*...* glob fragment
    return s.replace(/[?*{}[\]()!]/g, (ch) => `\\${ch}`);
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

    const be = loaded.meta.backend;
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      this.interceptToolCall(update);
      if (update.kind === 'result' || update.kind === 'error') {
        this.panel.post({ type: 'busy', busy: false });
      }
    });

    this.meta = loaded.meta;
    this.titled = true; // existing session already has its title
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });

    // Replay the stored transcript so the UI shows the full conversation history
    this.panel.post({ type: 'historyLoaded', meta: this.meta, records: loaded.records as any });

    // Start a live agent session (fresh process for now; resume tokens can be added later)
    const mode = this.meta.mode ?? this.config.get<PermissionMode>('initialPermissionMode', 'default');
    await this.session.start({
      cwd: this.meta.cwd,
      mode,
      model: this.meta.model,
      effort: this.meta.effort,
      allowBypass: this.allowBypass
    });
  }
}

/** Pick the most "used" model from a per-model UsageInfo breakdown:
 * highest output token count wins (output tokens are the strongest
 * predictor of which model did the actual generation, vs cache reads
 * which can be lopsided). Falls back to the first entry, then null. */
function pickDominantModel(byModel: Array<{ model?: string; outputTokens?: number }>): string | undefined {
  if (byModel.length === 0) return undefined;
  let best: { model?: string; outputTokens?: number } | undefined;
  for (const m of byModel) {
    if (!m.model) continue;
    if (!best || (m.outputTokens ?? 0) > (best.outputTokens ?? 0)) best = m;
  }
  return best?.model;
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
  const firstLine = text.trim().split('\n').find((l) => l.trim().length > 0) ?? text.trim();
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  const max = 60;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + '…' : cleaned || 'New chat';
}
