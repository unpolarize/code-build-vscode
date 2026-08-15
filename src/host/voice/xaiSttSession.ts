// Host STT session against xAI streaming STT (wss://api.x.ai/v1/stt), the
// Quill approach: mic helper PCM16 → WebSocket, grok CLI creds or an xAI key.
// Matches HostSttSession's shape so sessionManager can swap engines freely.

import WebSocket from 'ws';
import type { HostSttHandlers } from './sttHost';
import { XaiTranscriptAccumulator, xaiSttUrl } from './xaiStt';
import { GrokCreds, isExpired } from './grokAuth';
import { ensureMicHelper, startMicCapture, MicSession } from './micCapture';

export interface XaiSttOptions {
  lang: string;
  creds: GrokCreds;
  /** resources/mic/MicCap.swift, resolved by the caller from extensionUri. */
  helperSource: string;
  /** globalStorage dir for the compiled helper cache. */
  storageDir: string;
  onDiag?: (line: string) => void;
}

export class XaiSttSession {
  private ws: WebSocket | undefined;
  private mic: MicSession | undefined;
  private acc: XaiTranscriptAccumulator;
  private pending: Buffer[] = [];
  private open = false;
  private closed = false;
  private stopping = false;
  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private opts: XaiSttOptions,
    private handlers: HostSttHandlers
  ) {
    this.acc = new XaiTranscriptAccumulator({
      onInterim: (text) => {
        if (!this.closed && text) this.handlers.onResult({ transcript: text, isFinal: false });
      },
      onFinal: (text) => {
        if (!this.closed) this.handlers.onResult({ transcript: text, isFinal: true });
      },
      onError: (message) => this.fail(message),
      onDone: () => this.finish()
    });
  }

  async start(): Promise<void> {
    this.handlers.onStatus('starting');

    if (isExpired(this.opts.creds)) {
      this.fail('Grok session expired — open Grok once to refresh, or set codeBuild.voice.xaiApiKey.');
      return;
    }

    let binPath: string;
    try {
      binPath = ensureMicHelper(this.opts.helperSource, this.opts.storageDir);
    } catch (e) {
      this.handlers.onStatus('unsupported', e instanceof Error ? e.message : String(e));
      this.closed = true;
      return;
    }

    const ws = new WebSocket(xaiSttUrl(this.opts.lang), {
      headers: { Authorization: `Bearer ${this.opts.creds.token}` },
      handshakeTimeout: 20_000
    });
    this.ws = ws;

    ws.on('open', () => {
      if (this.closed) return;
      this.open = true;
      for (const chunk of this.pending) ws.send(chunk);
      this.pending = [];
      this.handlers.onStatus('listening');
      // stop() may have been requested while the TLS handshake was in flight —
      // the buffered audio has now been sent, so the done marker can follow.
      if (this.stopping) this.sendDone();
    });
    ws.on('message', (data) => {
      if (!this.closed) this.acc.handleMessage(data.toString());
    });
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.fail('Grok session expired — open Grok once to refresh, or set codeBuild.voice.xaiApiKey.');
      } else {
        this.fail(`xAI STT refused the connection (HTTP ${res.statusCode}).`);
      }
    });
    ws.on('error', (e) => {
      // A normal server-side close after audio.done can surface as an error.
      if (this.stopping || this.acc.transcript) this.finish();
      else this.fail(`xAI STT connection failed: ${e.message}`);
    });
    ws.on('close', (code) => {
      if (this.closed) return;
      if (this.stopping || this.acc.transcript) this.finish();
      else this.fail(`xAI STT connection closed (code ${code}).`);
    });

    this.mic = startMicCapture(binPath, {
      onPCM: (chunk) => {
        if (this.closed || this.stopping) return;
        if (this.open) this.ws?.send(chunk);
        else this.pending.push(chunk);
      },
      onError: (message) => this.fail(message),
      onDiag: this.opts.onDiag
    });
  }

  /** Stop the mic, tell the server we're done, wait briefly for the tail. */
  stop(): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    this.mic?.stop();
    this.mic = undefined;
    if (this.open) this.sendDone();
    // If the socket never opened, the open handler sends the done marker so
    // buffered audio still gets transcribed; this timer bounds the wait.
    this.doneTimer = setTimeout(() => this.finish(), 4_000);
  }

  private sendDone(): void {
    try {
      this.ws?.send('{"type":"audio.done"}');
    } catch {
      this.finish();
    }
  }

  private finish(): void {
    if (this.closed) return;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.acc.flushOpen(); // before closed=true so the final still reaches the webview
    this.closed = true;
    this.teardown();
    this.handlers.onStatus('idle');
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.teardown();
    this.handlers.onStatus('error', message);
  }

  private teardown(): void {
    this.mic?.stop();
    this.mic = undefined;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.pending = [];
  }
}
