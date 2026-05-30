import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { ChatSurface, isWebviewToHost, renderWebviewHtml, webviewOptions } from './webviewHtml';

export const CHAT_VIEW_TYPE = 'codeBuild.chat';
export const CHAT_SIDEBAR_ID = 'codeBuild.sidebar';

/** A chat WebviewPanel (an editor tab). Implements the ChatSurface SessionManager uses. */
export class ChatPanel implements ChatSurface {
  private disposables: vscode.Disposable[] = [];
  private onMessageCb?: (msg: WebviewToHost) => void;

  constructor(
    public readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel.webview.options = webviewOptions(this.extensionUri);
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, this.extensionUri);
    this.panel.webview.onDidReceiveMessage(
      (raw) => {
        if (isWebviewToHost(raw)) this.onMessageCb?.(raw);
      },
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static create(extensionUri: vscode.Uri, column?: vscode.ViewColumn): ChatPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_VIEW_TYPE,
      'Code Build',
      // Open as a tab in the active editor group by default (not a split/Beside).
      column ?? vscode.ViewColumn.Active,
      { ...webviewOptions(extensionUri), retainContextWhenHidden: true }
    );
    return new ChatPanel(panel, extensionUri);
  }

  onMessage(cb: (msg: WebviewToHost) => void): void {
    this.onMessageCb = cb;
  }

  post(msg: HostToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column);
  }

  setTitle(title: string): void {
    this.panel.title = title;
  }

  dispose(): void {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
