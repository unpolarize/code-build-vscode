import * as vscode from 'vscode';

/**
 * Editor-side capabilities the agent/UI can drive: open a native diff, reveal a
 * file location, read the current selection, gather diagnostics. (P3 command
 * surface; the localhost MCP `ide` server that exposes these to a CLI lands later.)
 */
export class EditorTools {
  /** Open a side-by-side diff between proposed old/new text for a path. */
  async openDiff(path: string, oldText: string, newText: string): Promise<void> {
    const name = path.split('/').pop() ?? 'file';
    const left = await vscode.workspace.openTextDocument({ content: oldText, language: langOf(path) });
    const right = await vscode.workspace.openTextDocument({ content: newText, language: langOf(path) });
    await vscode.commands.executeCommand(
      'vscode.diff',
      left.uri,
      right.uri,
      `${name} (proposed change)`,
      { preview: true }
    );
  }

  /** Open a file and reveal a line. */
  async revealLocation(path: string, line?: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line != null) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      void vscode.window.showWarningMessage(`Could not open ${path}: ${String(err)}`);
    }
  }

  /** Current editor selection as text, for @-mention / context insertion. */
  readSelection(): { path: string; text: string } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return null;
    return { path: editor.document.uri.fsPath, text: editor.document.getText(editor.selection) };
  }

  /** Diagnostics across the workspace, flattened. */
  diagnostics(): { path: string; line: number; severity: string; message: string }[] {
    const out: { path: string; line: number; severity: string; message: string }[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        out.push({
          path: uri.fsPath,
          line: d.range.start.line + 1,
          severity: vscode.DiagnosticSeverity[d.severity],
          message: d.message
        });
      }
    }
    return out;
  }
}

function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html'
  };
  return map[ext] ?? 'plaintext';
}
