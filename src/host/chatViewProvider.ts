import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { ChatSurface, isWebviewToHost, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { SessionManager } from './sessionManager';
import { LAST_SESSION_KEY, sessionMatchesWorkspace } from './lastSession';
import { SessionStore } from './persistence/store';
import { startSpan } from './hostTrace';

/**
 * Sidebar chat surface. Uses the SAME built React bundle as the editor-tab panel;
 * only the host wiring differs. Hosts one SessionManager bound to the sidebar view.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, ChatSurface {
  private view?: vscode.WebviewView;
  private onMessageCb?: (msg: WebviewToHost) => void;
  private manager?: SessionManager;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((raw) => {
      if (isWebviewToHost(raw)) this.onMessageCb?.(raw);
    });
    // Bind a fresh SessionManager the first time the sidebar resolves.
    if (!this.manager) {
      const span = startSpan('cb.sidebar.resolve');
      span.mark('html');
      this.manager = new SessionManager(this, this.context, span);
      // Sidebar is not a serialized webview panel — without this, every
      // VS Code start auto-spawns a blank agent. Restore the last chat
      // as transcript-only; the first prompt reconnects.
      const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
      if (last) {
        const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
        const meta = new SessionStore().loadMeta(last);
        if (meta && sessionMatchesWorkspace(meta.cwd, folders)) {
          this.manager.queueResume(last, { connect: false });
        }
      }
    }
  }

  onMessage(cb: (msg: WebviewToHost) => void): void {
    this.onMessageCb = cb;
  }

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }
}
