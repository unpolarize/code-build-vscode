import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { BackendId, ContentBlock, PermissionMode } from '../shared/acpTypes';
import type { HydrateState, SessionMeta, WebviewToHost } from '../shared/protocol';
import type { ChatSurface } from './webviewHtml';
import { detectAll } from './backendRegistry';
import type { AgentSession } from './agentSession';
import { createSession } from './transports/factory';
import { EditorTools } from './editorBridge/editorTools';
import { SessionStore } from './persistence/store';

/**
 * Owns one chat panel + its live AgentSession. (P5 will generalize to N panels.)
 * Routes webview commands to the session and session events back to the webview.
 */
export class SessionManager {
  private session?: AgentSession;
  private meta?: SessionMeta;
  private unsubscribe?: () => void;
  private titled = false;
  private readonly editor = new EditorTools();
  private readonly store = new SessionStore();

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
        await this.hydrate();
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
        await this.openSession(msg.backend);
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
        const blocks = await this.enrichBlocksWithFileMentions(msg.blocks, this.cwd);
        try {
          await this.session!.prompt(blocks);
        } catch (err) {
          this.panel.post({
            type: 'sessionUpdate',
            sessionId: this.meta!.id,
            update: { kind: 'error', message: String(err) }
          });
        }
        break;
      }
      case 'cancel':
        this.session?.cancel();
        this.panel.post({ type: 'busy', busy: false });
        break;
      case 'setMode':
        this.setMode(msg.mode);
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
      case 'listSessions':
        this.panel.post({ type: 'sessionsList', sessions: this.store.list().slice(0, 100) });
        break;
      case 'resumeSession':
        await this.loadExistingSession(msg.id);
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
    if (autoStart && !this.session && defaultAvailable) {
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

  private async openSession(backend?: BackendId): Promise<void> {
    this.teardownSession();
    const id = crypto.randomUUID();
    const be = backend ?? this.defaultBackend();
    const mode = this.config.get<PermissionMode>('initialPermissionMode', 'default');
    const overrides = this.config.get<Record<string, string>>('binPaths', {});

    this.session = createSession({ id, backend: be, binOverrides: overrides });
    this.unsubscribe = this.session.onEvent((update) => {
      this.store.appendUpdate(id, update);
      this.panel.post({ type: 'sessionUpdate', sessionId: id, update });
      if (update.kind === 'result' || update.kind === 'error') {
        this.panel.post({ type: 'busy', busy: false });
      }
    });

    this.meta = {
      id,
      backend: be,
      title: `New chat · ${be}`,
      mode,
      cwd: this.cwd,
      createdAt: Date.now()
    };
    this.titled = false;
    // Write the transcript header but do NOT index yet (lazy: see commitAndTitle).
    this.store.createSession(this.meta);
    this.panel.setTitle?.(this.meta.title);
    this.panel.post({ type: 'sessionMeta', session: this.meta });
    await this.session.start({ cwd: this.cwd, mode });
  }

  private setMode(mode: PermissionMode): void {
    if (this.meta) {
      this.meta.mode = mode;
      this.panel.post({ type: 'sessionMeta', session: this.meta });
    }
    this.session?.setMode(mode);
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
    await this.session.start({ cwd: this.meta.cwd, mode });
  }
}

/** Make a short, human-readable session title from the first user message. */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n').find((l) => l.trim().length > 0) ?? text.trim();
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  const max = 60;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + '…' : cleaned || 'New chat';
}
