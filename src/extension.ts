import * as vscode from 'vscode';
import { ChatPanel, CHAT_VIEW_TYPE } from './host/panel';
import { SessionManager } from './host/sessionManager';

export function activate(context: vscode.ExtensionContext): void {
  const managers = new Set<SessionManager>();

  function attach(panel: ChatPanel): SessionManager {
    const mgr = new SessionManager(panel, context);
    managers.add(mgr);
    panel.panel.onDidDispose(() => {
      mgr.dispose();
      managers.delete(mgr);
    });
    return mgr;
  }

  function openChat(column?: vscode.ViewColumn): void {
    const panel = ChatPanel.create(context.extensionUri, column);
    attach(panel);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codeBuild.newConversation', () => openChat()),
    vscode.commands.registerCommand('codeBuild.openInNewTab', () =>
      openChat(vscode.ViewColumn.Beside)
    ),
    vscode.commands.registerCommand('codeBuild.openInNewWindow', async () => {
      openChat(vscode.ViewColumn.Active);
      // No programmatic move-to-window API exists; trigger the built-in gesture.
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }),
    vscode.commands.registerCommand('codeBuild.focusInput', () => {
      // The active webview handles focus internally on this signal.
      // (Reveal keeps the panel active; the webview focuses its input on visibility.)
    }),
    vscode.commands.registerCommand('codeBuild.openInCoderSessions', async (sessionId?: string) => {
      await openInCoderSessions(sessionId);
    })
  );

  // Restore chat panels after reload / window-move (webview is re-created on move).
  vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
    async deserializeWebviewPanel(panel) {
      attach(new ChatPanel(panel, context.extensionUri));
    }
  });

  // URI handler: vscode://zhirafovod.code-build/open?prompt=&session=
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (uri.path === '/open') {
          openChat();
        }
      }
    })
  );
}

async function openInCoderSessions(sessionId?: string): Promise<void> {
  // Best-effort cross-link: prefer the official command, fall back to a notice.
  const commands = await vscode.commands.getCommands(true);
  if (sessionId && commands.includes('coderSessions.viewConversation')) {
    await vscode.commands.executeCommand('coderSessions.viewConversation', sessionId);
  } else {
    void vscode.window.showInformationMessage(
      'Coder Sessions integration: sessions are exported as JSONL and will appear in the Coder Sessions view once persistence (P4) is enabled.'
    );
  }
}

export function deactivate(): void {
  /* sessions are disposed via panel onDidDispose */
}
