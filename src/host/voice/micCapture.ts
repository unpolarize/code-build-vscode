// Spawns the MicCap.swift helper (16 kHz mono PCM16 on stdout), compiling it
// on demand with `xcrun swiftc` into globalStorage, cached by source hash.
// Pure Node (no vscode import) — the caller passes the storage + resource dirs.

import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface MicSession {
  stop: () => void;
}

export interface MicHandlers {
  onPCM: (chunk: Buffer) => void;
  /** Helper exited unexpectedly or could not start. */
  onError: (message: string) => void;
  /** stderr diagnostics (peak levels etc.), for the output channel. */
  onDiag?: (line: string) => void;
}

export function isMicCaptureSupported(): boolean {
  return process.platform === 'darwin';
}

export function micUnavailableDetail(): string {
  return (
    'Streaming STT needs the bundled mic helper, which requires macOS with the ' +
    'Xcode Command Line Tools (`xcode-select --install`) for a one-time compile. ' +
    'Alternatively set codeBuild.voice.sttEngine to "host" (VS Code Speech) or use ' +
    'OS dictation (Fn Fn) into the composer.'
  );
}

/**
 * Compile (once per source revision) and return the helper binary path.
 * Throws with a user-facing message on failure.
 */
export function ensureMicHelper(sourcePath: string, storageDir: string): string {
  if (process.platform !== 'darwin') throw new Error(micUnavailableDetail());
  const source = fs.readFileSync(sourcePath, 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binPath = path.join(storageDir, `miccap-${hash}`);
  if (fs.existsSync(binPath)) return binPath;

  fs.mkdirSync(storageDir, { recursive: true });
  const res = spawnSync(
    'xcrun',
    ['-sdk', 'macosx', 'swiftc', '-O', sourcePath, '-o', binPath],
    { encoding: 'utf8', timeout: 60_000 }
  );
  if (res.error || res.status !== 0) {
    const detail = (res.stderr || res.error?.message || '').trim().slice(0, 400);
    throw new Error(`Mic helper compile failed. ${micUnavailableDetail()}\n${detail}`);
  }
  return binPath;
}

export function startMicCapture(binPath: string, handlers: MicHandlers): MicSession {
  let child: ChildProcess;
  try {
    child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    handlers.onError(`Mic helper failed to start: ${String(e)}`);
    return { stop: () => undefined };
  }
  let stopped = false;

  child.stdout?.on('data', (chunk: Buffer) => handlers.onPCM(chunk));
  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx).trim();
      stderrBuf = stderrBuf.slice(idx + 1);
      if (line) handlers.onDiag?.(line);
    }
  });
  child.on('error', (e) => {
    if (!stopped) handlers.onError(`Mic helper error: ${e.message}`);
  });
  child.on('exit', (code) => {
    if (!stopped && code !== 0 && code !== null) {
      handlers.onError(`Mic helper exited with code ${code} (mic permission for VS Code?)`);
    }
  });

  return {
    stop: () => {
      stopped = true;
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      // Belt and braces if the stdin-close exit doesn't fire.
      setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, 300);
    }
  };
}
