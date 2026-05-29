import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { HostToWebview, WebviewToHost } from '../shared/protocol';
import { isWebviewToHost } from '../shared/protocol';

/** What SessionManager needs from a webview host, be it an editor panel or sidebar view. */
export interface ChatSurface {
  onMessage(cb: (msg: WebviewToHost) => void): void;
  post(msg: HostToWebview): void;
  setTitle?(title: string): void;
}

/** Render the CSP'd HTML shell that loads the built React bundle. */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
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

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')]
  };
}

export { isWebviewToHost };
