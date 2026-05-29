import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { BackendId, PermissionMode } from '../shared/acpTypes';
import type { HydrateState, SessionMeta, WebviewToHost } from '../shared/protocol';
import { ChatPanel } from './panel';
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
  private readonly editor = new EditorTools();
  private readonly store = new SessionStore();

  constructor(
    private readonly panel: ChatPanel,
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
      case 'newSession':
        await this.openSession(msg.backend);
        break;
      case 'pickBackend':
        await this.openSession(msg.backend);
        break;
      case 'prompt':
        await this.ensureSession();
        this.panel.post({ type: 'busy', busy: true });
        for (const b of msg.blocks) {
          if (b.type === 'text') this.store.appendUserText(this.meta!.id, b.text);
        }
        try {
          await this.session!.prompt(msg.blocks);
        } catch (err) {
          this.panel.post({
            type: 'sessionUpdate',
            sessionId: this.meta!.id,
            update: { kind: 'error', message: String(err) }
          });
        }
        break;
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
    }
  }

  private async hydrate(): Promise<void> {
    const overrides = this.config.get<Record<string, string>>('binPaths', {});
    const backends = await detectAll(overrides);
    const allowBypass = this.config.get<boolean>('allowDangerouslySkipPermissions', false);
    const state: HydrateState = {
      session: this.meta ?? null,
      backends,
      allowBypass
    };
    this.panel.post({ type: 'hydrate', state });
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
      title: `Code Build · ${be}`,
      mode,
      cwd: this.cwd,
      createdAt: Date.now()
    };
    this.store.createSession(this.meta);
    this.panel.setTitle(this.meta.title);
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

  private teardownSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  dispose(): void {
    this.teardownSession();
  }
}
