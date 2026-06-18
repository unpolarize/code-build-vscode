// Live Memory tree view — the daily-driver surface for the memory map.
//
// Lists every MemoryEntry the active workspace exposes (Claude / Codex /
// Grok / auto-memory / Codex memories / MCP if configured). Right-click a
// node to pin / unpin / hide / unhide / edit / delete. Pin/hide go through
// the SidecarMetadataStore so they survive across sessions and don't
// touch the agents' own files.
//
// This view is the consumer demo for @unpolarize/agent-memory-core. The
// 2D atlas (Phase 5+) is a separate webview view that uses the same data.

import * as vscode from 'vscode';
import {
  MemoryEntry,
  MemoryProvider,
  MarkdownMemoryAdapter,
  AutoMemoryAdapter,
  CodexMemoriesAdapter,
  WriteBackDispatcher,
  AuditLog,
  SidecarMetadataStore,
  MemoryAdapter,
} from '@unpolarize/agent-memory-core';

export const MEMORY_VIEW_ID = 'codeBuild.liveMemory';

type Node = ProviderNode | EntryNode;

interface ProviderNode {
  kind: 'provider';
  provider: MemoryProvider;
  count: number;
}

interface EntryNode {
  kind: 'entry';
  entry: MemoryEntry;
}

export class MemoryTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onChanged = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onChanged.event;

  private adapters: MemoryAdapter[] = [];
  private workspaceRoot: string | undefined;
  private dispatcher: WriteBackDispatcher | undefined;
  private sidecar: SidecarMetadataStore | undefined;
  private audit: AuditLog | undefined;
  private cached: MemoryEntry[] = [];

  constructor() {
    this.bootstrap();
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.bootstrap());
  }

  /** Re-derive adapters + dispatcher for the current workspace. */
  bootstrap(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.workspaceRoot = folder?.uri.fsPath;
    if (!this.workspaceRoot) {
      this.adapters = [];
      this.dispatcher = undefined;
      this.cached = [];
      this._onChanged.fire(undefined);
      return;
    }

    const markdownAdapters = [
      new MarkdownMemoryAdapter({ provider: 'claude' }),
      new MarkdownMemoryAdapter({ provider: 'codex' }),
      new MarkdownMemoryAdapter({ provider: 'grok' }),
    ];
    const autoAdapter = new AutoMemoryAdapter();
    const codexAdapter = new CodexMemoriesAdapter();
    this.adapters = [...markdownAdapters, autoAdapter, codexAdapter];

    this.sidecar = new SidecarMetadataStore(this.workspaceRoot);
    this.audit = new AuditLog(this.workspaceRoot);
    this.dispatcher = new WriteBackDispatcher({
      adapters: {
        claude: markdownAdapters[0],
        codex: markdownAdapters[1],
        grok: markdownAdapters[2],
      },
      audit: this.audit,
      sidecar: this.sidecar,
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.workspaceRoot || !this.sidecar) {
      this.cached = [];
      this._onChanged.fire(undefined);
      return;
    }
    const ws = this.workspaceRoot;
    const lists = await Promise.all(
      this.adapters.map((a) => a.list({ workspaceRoot: ws }).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.warn(`[code-build/memoryView] ${a.provider} list failed: ${err.message}`);
        return [] as MemoryEntry[];
      })),
    );
    const merged = lists.flat();
    this.cached = await this.sidecar.applyTo(merged);
    this._onChanged.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'provider') {
      const item = new vscode.TreeItem(
        `${labelForProvider(node.provider)} (${node.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'memoryProvider';
      item.iconPath = new vscode.ThemeIcon(iconForProvider(node.provider));
      return item;
    }
    const e = node.entry;
    const item = new vscode.TreeItem(
      formatEntryLabel(e),
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = formatEntryDescription(e);
    item.tooltip = e.text.slice(0, 500);
    item.contextValue = `memoryEntry${e.pinned ? '.pinned' : ''}${e.hidden ? '.hidden' : ''}`;
    item.iconPath = new vscode.ThemeIcon(
      e.pinned ? 'pinned' : e.hidden ? 'eye-closed' : 'circle-small',
    );
    if (e.source.file && e.source.fileRange) {
      const fileUri = vscode.Uri.file(e.source.file);
      item.command = {
        command: 'vscode.open',
        title: 'Open source',
        arguments: [
          fileUri,
          {
            selection: new vscode.Range(
              e.source.fileRange.startLine - 1, 0,
              e.source.fileRange.endLine - 1, 0,
            ),
          },
        ],
      };
    }
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const visible = this.cached.filter((e) => !e.hidden);
      const grouped = groupBy(visible, (e) => e.source.provider);
      return Array.from(grouped.entries()).map(([provider, list]) => ({
        kind: 'provider' as const,
        provider,
        count: list.length,
      }));
    }
    if (node.kind === 'provider') {
      return this.cached
        .filter((e) => e.source.provider === node.provider && !e.hidden)
        .map((entry) => ({ kind: 'entry' as const, entry }));
    }
    return [];
  }

  /** Lookup helpers for command handlers. */
  findEntry(id: string): MemoryEntry | undefined {
    return this.cached.find((e) => e.id === id);
  }
  get writeDispatcher(): WriteBackDispatcher | undefined {
    return this.dispatcher;
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export function registerMemoryCommands(context: vscode.ExtensionContext, view: MemoryTreeProvider): void {
  const togglePin = async (node: Node | undefined, pin: boolean) => {
    const entry = nodeEntry(node, view);
    if (!entry) return;
    await dispatch(view, entry, pin ? 'pin' : 'unpin');
  };

  const toggleHide = async (node: Node | undefined, hide: boolean) => {
    const entry = nodeEntry(node, view);
    if (!entry) return;
    await dispatch(view, entry, hide ? 'hide' : 'unhide');
  };

  const editEntry = async (node: Node | undefined) => {
    const entry = nodeEntry(node, view);
    if (!entry || !entry.source.file) return;
    const doc = await vscode.workspace.openTextDocument(entry.source.file);
    const editor = await vscode.window.showTextDocument(doc);
    if (entry.source.fileRange) {
      const startLine = entry.source.fileRange.startLine - 1;
      const endLine = entry.source.fileRange.endLine - 1;
      editor.revealRange(new vscode.Range(startLine, 0, endLine, 0));
      editor.selection = new vscode.Selection(startLine, 0, endLine, 0);
    }
  };

  const deleteEntry = async (node: Node | undefined) => {
    const entry = nodeEntry(node, view);
    if (!entry) return;
    const yes = await vscode.window.showWarningMessage(
      `Delete memory entry "${formatEntryLabel(entry)}"? This rewrites the source file.`,
      { modal: true },
      'Delete',
    );
    if (yes !== 'Delete') return;
    await dispatch(view, entry, 'delete');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeBuild.memory.refresh', () => view.refresh()),
    vscode.commands.registerCommand('codeBuild.memory.pin', (node?: Node) => togglePin(node, true)),
    vscode.commands.registerCommand('codeBuild.memory.unpin', (node?: Node) => togglePin(node, false)),
    vscode.commands.registerCommand('codeBuild.memory.hide', (node?: Node) => toggleHide(node, true)),
    vscode.commands.registerCommand('codeBuild.memory.unhide', (node?: Node) => toggleHide(node, false)),
    vscode.commands.registerCommand('codeBuild.memory.edit', editEntry),
    vscode.commands.registerCommand('codeBuild.memory.delete', deleteEntry),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dispatch(
  view: MemoryTreeProvider,
  entry: MemoryEntry,
  verb: 'pin' | 'unpin' | 'hide' | 'unhide' | 'delete',
): Promise<void> {
  const dispatcher = view.writeDispatcher;
  if (!dispatcher) {
    void vscode.window.showWarningMessage('Live Memory: no workspace open.');
    return;
  }
  try {
    await dispatcher.apply(
      { verb, entryId: entry.id, opTimestamp: Date.now() },
      entry,
    );
    await view.refresh();
  } catch (err: unknown) {
    void vscode.window.showErrorMessage(`Live Memory: ${verb} failed — ${(err as Error).message}`);
  }
}

function nodeEntry(node: Node | undefined, view: MemoryTreeProvider): MemoryEntry | undefined {
  if (!node || node.kind !== 'entry') return undefined;
  // Re-fetch from the cache so we have the latest sourceSnapshot, even if
  // the tree item is stale.
  return view.findEntry(node.entry.id) ?? node.entry;
}

function formatEntryLabel(e: MemoryEntry): string {
  const text = e.text.replace(/^#+\s+/, '').split('\n')[0].slice(0, 60);
  return text || `<${e.kind}>`;
}

function formatEntryDescription(e: MemoryEntry): string {
  const bits: string[] = [];
  if (e.source.fileRange) bits.push(`L${e.source.fileRange.startLine}`);
  if (e.scope !== 'project') bits.push(e.scope);
  if (e.kind !== 'rule' && e.kind !== 'fact') bits.push(e.kind);
  return bits.join(' · ');
}

function labelForProvider(p: MemoryProvider): string {
  switch (p) {
    case 'claude': return 'Claude (CLAUDE.md)';
    case 'claude-auto': return 'Claude auto-memory';
    case 'codex': return 'Codex (AGENTS.md)';
    case 'codex-memories': return 'Codex memories';
    case 'grok': return 'Grok (AGENTS.md)';
    case 'mcp-memory': return 'MCP memory server';
    case 'code-build': return 'Code Build primer';
  }
}

function iconForProvider(p: MemoryProvider): string {
  switch (p) {
    case 'claude':
    case 'claude-auto':
      return 'beaker';
    case 'codex':
    case 'codex-memories':
      return 'octoface';
    case 'grok':
      return 'rocket';
    case 'mcp-memory':
      return 'plug';
    case 'code-build':
      return 'sparkle';
  }
}

function groupBy<T, K>(arr: T[], keyFn: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of arr) {
    const k = keyFn(it);
    const cur = out.get(k) ?? [];
    cur.push(it);
    out.set(k, cur);
  }
  return out;
}
