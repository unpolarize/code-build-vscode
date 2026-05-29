import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { ChatSurface, isWebviewToHost, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { SessionManager } from './sessionManager';

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
      this.manager = new SessionManager(this, this.context);
    }
  }

  onMessage(cb: (msg: WebviewToHost) => void): void {
    this.onMessageCb = cb;
  }

  post(msg: HostToWebview): void {
    void this.view?.webview.postMessage(msg);
  }
}
