// Web Speech API wrappers for STT (dictation) and TTS (read-aloud).
// Fallback path when host STT is unavailable — VS Code sandboxes the chat
// webview iframe without a microphone Permissions-Policy, so this often
// fails with `not-allowed` even when System Settings grants mic to VS Code.

import { textForSpeech } from '../../../src/shared/voiceIdeation';

export type SttStatus = 'idle' | 'listening' | 'unsupported' | 'error' | 'starting';

export interface SttResult {
  transcript: string;
  isFinal: boolean;
}

/** User-facing copy when the webview cannot access the mic / speech stack. */
export const WEBVIEW_STT_DENIED_MSG =
  'Webview microphone blocked (VS Code sandboxes the chat iframe). Prefer host STT (macOS, default) or use OS dictation: focus the composer and press Fn twice. System Settings → Microphone for VS Code does not unlock webview SpeechRecognition.';

export const WEBVIEW_STT_UNSUPPORTED_MSG =
  'Speech recognition is not available in this webview. On macOS, Code Build uses host STT by default. Otherwise use OS dictation (Fn Fn) into the composer.';

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: Event & { error?: string }) => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
    length: number;
  }> & { length: number };
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSttSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function isTtsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export interface SttSessionOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onResult: (r: SttResult) => void;
  onStatus?: (s: SttStatus, detail?: string) => void;
  /** Fired when recognition ends (browser stop / silence / error). */
  onEnd?: () => void;
  /**
   * When true (default), call getUserMedia({audio:true}) before start() to
   * surface a clearer permission failure and (on some hosts) trigger the
   * browser permission prompt. Does not fix the VS Code iframe sandbox.
   */
  mediaPreflight?: boolean;
}

/** Managed STT session with restart helpers for continuous interactive mode. */
export class SttSession {
  private rec: SpeechRecognitionLike | null = null;
  private wantListen = false;
  private opts: SttSessionOptions;
  private restartTimer: number | null = null;
  private mediaStream: MediaStream | null = null;
  private starting = false;

  constructor(opts: SttSessionOptions) {
    this.opts = opts;
  }

  get supported(): boolean {
    return isSttSupported();
  }

  start(): void {
    void this.startAsync();
  }

  private async startAsync(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) {
        this.opts.onStatus?.('unsupported', WEBVIEW_STT_UNSUPPORTED_MSG);
        return;
      }
      this.wantListen = true;
      this.clearRestart();
      this.stopInternal(false);
      this.opts.onStatus?.('starting');

      // (b) getUserMedia preflight — clearer failure + possible permission prompt.
      if (this.opts.mediaPreflight !== false) {
        const pre = await this.preflightMic();
        if (!pre.ok) {
          this.wantListen = false;
          this.opts.onStatus?.('error', pre.detail);
          return;
        }
      }

      if (!this.wantListen) return;

      const rec = new Ctor();
      rec.continuous = this.opts.continuous ?? true;
      rec.interimResults = this.opts.interimResults ?? true;
      rec.lang = this.opts.lang ?? 'en-US';
      rec.maxAlternatives = 1;

      rec.onstart = () => this.opts.onStatus?.('listening');
      rec.onerror = (ev) => {
        const err = (ev as { error?: string }).error ?? 'error';
        // 'no-speech' / 'aborted' are benign in continuous mode
        if (err === 'no-speech' || err === 'aborted') return;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.wantListen = false;
          this.releaseMedia();
          this.opts.onStatus?.('error', WEBVIEW_STT_DENIED_MSG);
          return;
        }
        if (err === 'network') {
          this.opts.onStatus?.(
            'error',
            'Web Speech network error — VS Code’s Chromium build often lacks Google’s cloud speech endpoint. Use host STT (macOS) or OS dictation (Fn Fn).'
          );
          return;
        }
        this.opts.onStatus?.('error', `Web Speech error: ${err}`);
      };
      rec.onresult = (ev) => {
        let interim = '';
        let final = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = r[0]?.transcript ?? '';
          if (r.isFinal) final += t;
          else interim += t;
        }
        if (final) this.opts.onResult({ transcript: final, isFinal: true });
        else if (interim) this.opts.onResult({ transcript: interim, isFinal: false });
      };
      rec.onend = () => {
        this.opts.onEnd?.();
        // Auto-restart while we still want to listen (continuous hands-free).
        if (this.wantListen) {
          this.restartTimer = window.setTimeout(() => {
            if (this.wantListen) this.start();
          }, 250);
        } else {
          this.opts.onStatus?.('idle');
          this.releaseMedia();
        }
      };

      this.rec = rec;
      try {
        rec.start();
      } catch (e) {
        this.opts.onStatus?.('error', String(e));
      }
    } finally {
      this.starting = false;
    }
  }

  /**
   * Request mic briefly so failure modes are explicit. Keeps the stream open
   * while listening so the permission grant (if any) stays warm.
   */
  private async preflightMic(): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      // No getUserMedia — still try SpeechRecognition; may work or fail later.
      return { ok: true };
    }
    try {
      this.releaseMedia();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { ok: true };
    } catch (e) {
      const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: string }).name) : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        return { ok: false, detail: WEBVIEW_STT_DENIED_MSG };
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return {
          ok: false,
          detail: 'No microphone found. Connect a mic or use OS dictation if available.'
        };
      }
      return {
        ok: false,
        detail: `Microphone preflight failed: ${name || String(e)}. ${WEBVIEW_STT_DENIED_MSG}`
      };
    }
  }

  stop(): void {
    this.wantListen = false;
    this.clearRestart();
    this.stopInternal(true);
    this.releaseMedia();
    this.opts.onStatus?.('idle');
  }

  private releaseMedia(): void {
    if (!this.mediaStream) return;
    for (const t of this.mediaStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    this.mediaStream = null;
  }

  private stopInternal(abort: boolean): void {
    if (!this.rec) return;
    try {
      if (abort) this.rec.abort();
      else this.rec.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }

  private clearRestart(): void {
    if (this.restartTimer != null) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}

export interface TtsOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  voiceURI?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (msg: string) => void;
}

/** Speak with the browser speechSynthesis API. */
export function speakWeb(text: string, opts: TtsOptions = {}): void {
  if (!isTtsSupported()) {
    opts.onError?.('speechSynthesis not available');
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const clean = textForSpeech(text);
  if (!clean) {
    opts.onEnd?.();
    return;
  }
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = opts.lang ?? 'en-US';
  u.rate = opts.rate ?? 1.05;
  u.pitch = opts.pitch ?? 1;
  if (opts.voiceURI) {
    const voices = synth.getVoices();
    const v = voices.find((x) => x.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  }
  u.onstart = () => opts.onStart?.();
  u.onend = () => opts.onEnd?.();
  u.onerror = (e) => opts.onError?.(String((e as { error?: string }).error ?? 'tts error'));
  synth.speak(u);
}

export function stopWebSpeech(): void {
  if (isTtsSupported()) {
    window.speechSynthesis.cancel();
  }
}
