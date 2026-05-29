import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { isWebviewToHost } from '../shared/protocol';

export const CHAT_VIEW_TYPE = 'codeBuild.chat';

/**
 * Wraps a single chat WebviewPanel (an editor tab). The same HTML/React bundle can
 * later back a sidebar WebviewView; this class owns the editor-tab surface.
 */
export class ChatPanel {
  private disposables: vscode.Disposable[] = [];
  private onMessageCb?: (msg: WebviewToHost) => void;

  constructor(
    public readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')]
    };
    this.panel.webview.html = this.render();
    this.panel.webview.onDidReceiveMessage(
      (raw) => {
        if (isWebviewToHost(raw)) {
          this.onMessageCb?.(raw);
        }
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
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
      }
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

  private render(): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Code Build</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
