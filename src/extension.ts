import * as vscode from 'vscode';
import { ChatPanel, CHAT_VIEW_TYPE, CHAT_SIDEBAR_ID, preferredEditorColumn } from './host/panel';
import { SessionManager } from './host/sessionManager';
import { ChatViewProvider } from './host/chatViewProvider';
import { SessionStore } from './host/persistence/store';
import { listAllSessions } from './host/persistence/externalSources';
import { MemoryTreeProvider, MEMORY_VIEW_ID, registerMemoryCommands } from './host/memoryView';
import type { SessionMeta, SessionSource } from './shared/protocol';

export function activate(context: vscode.ExtensionContext): void {
  const managers = new Set<SessionManager>();
  /** Most recently created manager — used by global perf commands. */
  let latestMgr: SessionManager | undefined;

  function attach(panel: ChatPanel): SessionManager {
    const mgr = new SessionManager(panel, context);
    managers.add(mgr);
    latestMgr = mgr;
    panel.panel.onDidDispose(() => {
      mgr.dispose();
      managers.delete(mgr);
      if (latestMgr === mgr) latestMgr = [...managers].at(-1);
    });
    return mgr;
  }

  function lastManager(set: Set<SessionManager>): SessionManager | undefined {
    return latestMgr ?? [...set].at(-1);
  }

  function openChat(column?: vscode.ViewColumn): void {
    const panel = ChatPanel.create(context.extensionUri, column);
    attach(panel);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codeBuild.newConversation', () => openChat()),
    vscode.commands.registerCommand('codeBuild.openInNewTab', () =>
      openChat(preferredEditorColumn())
    ),
    vscode.commands.registerCommand('codeBuild.openInNewWindow', async () => {
      openChat(preferredEditorColumn());
      // No programmatic move-to-window API exists; trigger the built-in gesture.
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }),
    vscode.commands.registerCommand('codeBuild.focusInput', () => {
      // The active webview handles focus internally on this signal.
      // (Reveal keeps the panel active; the webview focuses its input on visibility.)
    }),
    vscode.commands.registerCommand('codeBuild.openInCodeSessions', async (sessionId?: string) => {
      await openInCodeSessions(sessionId);
    }),
    vscode.commands.registerCommand('codeBuild.openPreviousSession', async () => {
      await doOpenPreviousSession();
    }),
    // Programmatic entry point for cross-extension session import — code-sessions
    // calls this when the user clicks "Open in Code Build" on a claude or grok
    // session row. We spawn a fresh code-build session bound to the matching
    // backend in the right cwd, and pass the upstream session id as `resumeId`
    // so the CLI's own `--resume` flag does the heavy lifting (claude) or so
    // the chat just opens cleanly (grok — no resume flag exists yet).
    vscode.commands.registerCommand(
      'codeBuild.openExternalSession',
      async (args: { source: SessionSource; sessionId: string; cwd: string; title?: string }) => {
        if (!args || !args.source || !args.sessionId || !args.cwd) {
          void vscode.window.showWarningMessage('Code Build: openExternalSession needs {source, sessionId, cwd}.');
          return;
        }
        const panel = ChatPanel.create(context.extensionUri, preferredEditorColumn());
        const mgr = attach(panel);
        mgr.queueExternal(args);
      }
    ),
    // Perf debug commands operate on the most recently attached live manager.
    vscode.commands.registerCommand('codeBuild.togglePerfPanel', () => {
      const mgr = lastManager(managers);
      mgr?.postWebviewCommand({ type: 'togglePerfPanel' });
      mgr?.postWebviewCommand({ type: 'requestPerfSnapshot' });
    }),
    vscode.commands.registerCommand('codeBuild.copyPerfReport', () => {
      lastManager(managers)?.postWebviewCommand({ type: 'copyPerfReport' });
    }),
    vscode.commands.registerCommand('codeBuild.exportPerf', () => {
      lastManager(managers)?.postWebviewCommand({ type: 'exportPerf' });
    }),
    vscode.commands.registerCommand('codeBuild.showFlightRecorder', () => {
      vscode.window.createOutputChannel('Code Build: Flight Recorder').show(true);
    })
  );

  // Sidebar surface: same React bundle, hosted in the activity-bar view.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_SIDEBAR_ID,
      new ChatViewProvider(context.extensionUri, context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Live Memory tree view — explicit-memory-management surface backed by
  // @unpolarize/agent-memory-core. Lists every MemoryEntry the active
  // workspace exposes across Claude / Codex / Grok / auto-memory / Codex
  // memories. Right-click to pin / unpin / hide / unhide / edit / delete.
  const memoryView = new MemoryTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(MEMORY_VIEW_ID, memoryView),
  );
  registerMemoryCommands(context, memoryView);

  // Restore chat panels after reload / window-move. VS Code stores the
  // panel's `state` blob and hands it back on deserialize — we stash the
  // last live session id in there so the new SessionManager picks up
  // where the user left off instead of opening a fresh chat. The state
  // is written from the host whenever a session is committed (first
  // prompt) and read here.
  vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
    async deserializeWebviewPanel(panel, state: unknown) {
      const mgr = attach(new ChatPanel(panel, context.extensionUri));
      const stored = state as { lastSessionId?: string } | undefined;
      if (stored && typeof stored.lastSessionId === 'string' && stored.lastSessionId) {
        mgr.queueResume(stored.lastSessionId);
      }
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

  // Inner function with closure over attach() so it can create panels + managers for history.
  // Merges code-build's own sessions (~/.codebuild) with claude (~/.claude/projects) and
  // grok (~/.grok/sessions) — each tagged with a source so the picker shows where the row
  // came from and dispatch knows whether to re-load locally or re-spawn upstream.
  async function doOpenPreviousSession(): Promise<void> {
    const store = new SessionStore();
    const local = store.list();
    const all = listAllSessions(local);

    if (all.length === 0) {
      void vscode.window.showInformationMessage(
        'No previous conversations found in ~/.codebuild, ~/.claude/projects, or ~/.grok/sessions.'
      );
      return;
    }

    // Cap to keep the picker responsive on machines with thousands of claude
    // sessions; sorted newest-first by listAllSessions so this truncates the
    // long tail rather than recent activity.
    const items = all.slice(0, 500).map((m: SessionMeta) => {
      const src = m.source ?? 'codebuild';
      const tag = src === 'claude' ? '[CC]' : src === 'grok' ? '[GR]' : '[CB]';
      return {
        label: `${tag}  ${m.title || `${m.backend} session`}`,
        description: `${m.backend}  •  ${new Date(m.createdAt).toLocaleString()}`,
        detail: m.cwd,
        meta: m
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a previous conversation (${all.length} total: ~/.codebuild, ~/.claude, ~/.grok)`,
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!picked) return;

    const ext = vscode.extensions.getExtension('zhirafovod.code-build-vscode');
    if (!ext) return;

    const panel = ChatPanel.create(ext.extensionUri, preferredEditorColumn());
    const mgr = attach(panel);
    const src = picked.meta.source ?? 'codebuild';
    if (src === 'codebuild') {
      // Defer load until the webview is mounted (avoids dropping historyLoaded).
      mgr.queueResume(picked.meta.id);
    } else {
      mgr.queueExternal({
        source: src,
        sessionId: picked.meta.id,
        cwd: picked.meta.cwd,
        title: picked.meta.title
      });
    }
  }
}

async function openInCodeSessions(sessionId?: string): Promise<void> {
  // Best-effort cross-link: prefer the official command, fall back to a notice.
  const commands = await vscode.commands.getCommands(true);
  if (sessionId && commands.includes('codeSessions.viewConversation')) {
    await vscode.commands.executeCommand('codeSessions.viewConversation', sessionId);
  } else {
    void vscode.window.showInformationMessage(
      'Code Sessions integration: sessions are exported as JSONL and will appear in the Code Sessions view once persistence (P4) is enabled.'
    );
  }
}

export function deactivate(): void {
  /* sessions are disposed via panel onDidDispose */
}
