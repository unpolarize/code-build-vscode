import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { ChatSurface, isWebviewToHost, renderWebviewHtml, webviewOptions } from './webviewHtml';

export const CHAT_VIEW_TYPE = 'codeBuild.chat';
export const CHAT_SIDEBAR_ID = 'codeBuild.sidebar';

/** Pick a sensible editor column for a new webview panel.
 *
 * VS Code's `ViewColumn.Active` is unreliable when the user invokes a
 * command from the sidebar tree (e.g. "Resume session", "+ New
 * conversation"): `vscode.window.activeTextEditor` is undefined,
 * `ViewColumn.Active` falls through to "create a new split", and
 * the user sees their carefully-arranged editor area get a new
 * column — the exact annoyance reported in notes.md.
 *
 * `vscode.window.tabGroups.activeTabGroup` returns the focused
 * editor tab group regardless of where the focus actually sits
 * (sidebar, panel, terminal). Using its `viewColumn` reuses the
 * existing editor area instead of splitting. Falls back to
 * `activeTextEditor?.viewColumn` and finally `ViewColumn.One` for
 * the no-editors-open case.
 */
export function preferredEditorColumn(): vscode.ViewColumn {
  const group = vscode.window.tabGroups?.activeTabGroup;
  if (group?.viewColumn != null && group.viewColumn !== vscode.ViewColumn.Active) {
    return group.viewColumn;
  }
  return vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
}

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
      column ?? preferredEditorColumn(),
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
