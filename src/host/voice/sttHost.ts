// Host-side speech-to-text. Preferred over webview Web Speech because VS Code
// sandboxes webview iframes without a microphone Permissions-Policy, so
// webkitSpeechRecognition typically fails with `not-allowed` even when the
// OS grants mic access to the VS Code process.
//
// Strategy (in order):
// 1) **VS Code Speech bridge** — if `ms-vscode.vscode-speech` is installed,
//    open a scratch editor and run `workbench.action.editorDictation.start`.
//    That path uses the official Speech extension (Azure embedded models +
//    host mic permissions). We stream document text into the webview.
// 2) Otherwise report unsupported with clear guidance (install Speech
//    extension, or OS dictation Fn Fn, or webview fallback).
//
// Note: a standalone Apple SFSpeechRecognizer helper was prototyped but
// macOS TCC aborts ad-hoc / unsigned helpers for Speech Recognition even
// with NSSpeechRecognitionUsageDescription. VS Code’s own Info.plist has
// mic usage but not speech-recognition usage, so in-process Apple Speech
// would crash the extension host too. The Speech marketplace extension is
// the supported host path.

import * as vscode from 'vscode';
import { hostSttUnavailableDetail } from './sttResolve';

export type { SttEnginePref } from './sttResolve';
export { resolveSttEngine, hostSttUnavailableDetail } from './sttResolve';

export type HostSttStatus = 'idle' | 'listening' | 'error' | 'unsupported' | 'starting';

export interface HostSttResult {
  transcript: string;
  isFinal: boolean;
}

export interface HostSttHandlers {
  onResult: (r: HostSttResult) => void;
  onStatus: (status: HostSttStatus, detail?: string) => void;
}

const SPEECH_EXT_ID = 'ms-vscode.vscode-speech';

/** Host STT is available when VS Code Speech is installed (any OS it supports). */
export function isHostSttSupported(): boolean {
  return !!vscode.extensions.getExtension(SPEECH_EXT_ID);
}

/**
 * Host STT session via editor dictation + VS Code Speech.
 * Opens a small scratch document, starts workbench dictation, and mirrors text.
 */
export class HostSttSession {
  private handlers: HostSttHandlers;
  private lang: string;
  private context: vscode.ExtensionContext;
  private wantListen = false;
  private doc: vscode.TextDocument | undefined;
  private editor: vscode.TextEditor | undefined;
  private changeSub: vscode.Disposable | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastEmitted = '';
  private lastFull = '';
  private closing = false;

  constructor(
    opts: {
      lang: string;
      context: vscode.ExtensionContext;
    },
    handlers: HostSttHandlers
  ) {
    this.lang = opts.lang || 'en-US';
    this.context = opts.context;
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    this.wantListen = true;
    this.closing = false;
    this.lastEmitted = '';
    this.lastFull = '';
    this.handlers.onStatus('starting');

    const ext = vscode.extensions.getExtension(SPEECH_EXT_ID);
    if (!ext) {
      this.wantListen = false;
      this.handlers.onStatus('unsupported', hostSttUnavailableDetail());
      return;
    }
    try {
      if (!ext.isActive) {
        await ext.activate();
      }
    } catch (e) {
      this.wantListen = false;
      this.handlers.onStatus(
        'error',
        `Could not activate VS Code Speech: ${String(e)}. ${hostSttUnavailableDetail()}`
      );
      return;
    }

    // Align speech language with CB setting when possible.
    try {
      const speechCfg = vscode.workspace.getConfiguration('accessibility.voice');
      if (this.lang && speechCfg.get<string>('speechLanguage') !== this.lang) {
        // Best-effort; may require a language pack for non en-US.
        await speechCfg.update('speechLanguage', this.lang, vscode.ConfigurationTarget.Global);
      }
    } catch {
      /* ignore */
    }

    try {
      await this.openScratchAndDictate();
    } catch (e) {
      this.wantListen = false;
      this.handlers.onStatus(
        'error',
        `Host STT failed to start: ${String(e)}. Ensure Microphone is allowed for VS Code, and try editor dictation (Cmd+Alt+V) once.`
      );
      await this.cleanupUi();
    }
  }

  stop(): void {
    this.wantListen = false;
    void this.stopAsync();
  }

  private async stopAsync(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.clearPoll();
    this.changeSub?.dispose();
    this.changeSub = undefined;

    // Prefer stop command; fall back to cancel-style if needed.
    try {
      await vscode.commands.executeCommand('workbench.action.editorDictation.stop');
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.action.editorDictation.stopAndKeep');
      } catch {
        /* ignore */
      }
    }

    // Emit any trailing text as final.
    const full = (this.doc?.getText() ?? this.lastFull).trim();
    if (full && full !== this.lastEmitted) {
      const delta = this.deltaFrom(full);
      if (delta) {
        this.handlers.onResult({ transcript: delta, isFinal: true });
        this.lastEmitted = full;
      }
    }

    await this.cleanupUi();
    this.handlers.onStatus('idle');
    this.closing = false;
  }

  private async openScratchAndDictate(): Promise<void> {
    const dir = this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, 'voice-dictation-scratch.txt');
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());

    this.doc = await vscode.workspace.openTextDocument(uri);
    // Beside keeps chat visible; user sees a thin “listening” buffer.
    this.editor = await vscode.window.showTextDocument(this.doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false
    });

    // Clear any residual content from a previous run.
    await this.editor.edit((b) => {
      const full = new vscode.Range(
        this.doc!.lineAt(0).range.start,
        this.doc!.lineAt(this.doc!.lineCount - 1).range.end
      );
      b.replace(full, '');
    });

    this.changeSub = vscode.workspace.onDidChangeTextDocument((ev) => {
      if (!this.wantListen || ev.document.uri.toString() !== this.doc?.uri.toString()) return;
      this.handleDocText(ev.document.getText(), false);
    });

    // Poll as a backup (some dictation paths batch updates).
    this.pollTimer = setInterval(() => {
      if (!this.wantListen || !this.doc) return;
      this.handleDocText(this.doc.getText(), false);
    }, 350);

    try {
      await vscode.commands.executeCommand('workbench.action.editorDictation.start');
    } catch (e) {
      throw new Error(
        `editorDictation.start failed (${String(e)}). Is VS Code Speech installed and is a text editor focused?`
      );
    }

    if (!this.wantListen) {
      await this.stopAsync();
      return;
    }

    this.handlers.onStatus(
      'listening',
      'Host STT via VS Code Speech (scratch editor). Speak freely; Stop returns focus to chat.'
    );
    void vscode.window.setStatusBarMessage('$(mic) Code Build host STT listening…', 5000);
  }

  private handleDocText(text: string, forceFinal: boolean): void {
    const full = text.replace(/\r\n/g, '\n');
    this.lastFull = full;
    if (!full.trim()) return;

    if (forceFinal) {
      const delta = this.deltaFrom(full);
      if (delta) {
        this.handlers.onResult({ transcript: delta, isFinal: true });
        this.lastEmitted = full.trimEnd();
      }
      return;
    }

    // Interim: show full buffer as interim (Apple/Azure both rewrite the buffer).
    // Emit finals on sentence-ending punctuation or double newline.
    const trimmed = full.trimEnd();
    const sentenceEnd = /[.!?]\s*$/.test(trimmed) || trimmed.endsWith('\n\n');
    if (sentenceEnd && trimmed !== this.lastEmitted) {
      const delta = this.deltaFrom(full);
      if (delta) {
        this.handlers.onResult({ transcript: delta.trim(), isFinal: true });
        this.lastEmitted = trimmed;
        return;
      }
    }

    // Otherwise interim snapshot of uncommitted tail.
    const interim = full.slice(this.lastEmitted.length).trim();
    if (interim) {
      this.handlers.onResult({ transcript: interim, isFinal: false });
    }
  }

  private deltaFrom(full: string): string {
    const a = this.lastEmitted;
    if (!a) return full.trim();
    if (full.startsWith(a)) return full.slice(a.length).trim();
    // Dictation rewrote earlier text — send whole buffer as one final.
    return full.trim();
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async cleanupUi(): Promise<void> {
    this.clearPoll();
    this.changeSub?.dispose();
    this.changeSub = undefined;
    const uri = this.doc?.uri;
    this.doc = undefined;
    this.editor = undefined;
    if (!uri) return;
    // Close the scratch tab without prompting.
    try {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    } catch {
      try {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      } catch {
        /* ignore */
      }
    }
  }
}

