// Host-side TTS helpers. Webview speechSynthesis is primary; macOS `say`
// is an optional higher-quality fallback when codeBuild.voice.ttsEngine
// is "system" or "auto" on darwin.

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

let active: ChildProcess | undefined;

export type TtsEngine = 'webview' | 'system' | 'auto' | 'off';

export function resolveTtsEngine(configured: TtsEngine | undefined): 'webview' | 'system' | 'off' {
  const c = configured ?? 'auto';
  if (c === 'off') return 'off';
  if (c === 'webview') return 'webview';
  if (c === 'system') return os.platform() === 'darwin' ? 'system' : 'webview';
  // auto
  return os.platform() === 'darwin' ? 'system' : 'webview';
}

/** Speak text via macOS `say`. Returns a promise that resolves when done. */
export function speakWithSay(text: string, voice?: string): Promise<void> {
  stopSay();
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (voice && voice.trim()) {
      args.push('-v', voice.trim());
    }
    args.push(cleaned);
    const child = spawn('say', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    active = child;
    let err = '';
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      if (active === child) active = undefined;
      reject(e);
    });
    child.on('close', (code) => {
      if (active === child) active = undefined;
      if (code === 0 || code === null) resolve();
      else reject(new Error(err.trim() || `say exited ${code}`));
    });
  });
}

export function stopSay(): void {
  if (!active) return;
  try {
    active.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  active = undefined;
}
