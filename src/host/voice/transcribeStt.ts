// Host STT session against Amazon Transcribe streaming — the engine for
// machines where the only model access is AWS (e.g. Claude on Bedrock at
// work). Anthropic has no STT API and Bedrock hosts no streaming STT model,
// so the Quill move — reuse the credential you already have — means pointing
// the same AWS credential chain Bedrock uses at Transcribe.

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  AudioStream
} from '@aws-sdk/client-transcribe-streaming';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { HostSttHandlers } from './sttHost';
import { ensureMicHelper, startMicCapture, MicSession } from './micCapture';

export interface TranscribeSttOptions {
  lang: string;
  region: string;
  profile?: string;
  helperSource: string;
  storageDir: string;
  onDiag?: (line: string) => void;
}

export function isTranscribeCredsLikely(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE) return true;
  try {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const dir = `${os.homedir()}/.aws`;
    return fs.existsSync(`${dir}/credentials`) || fs.existsSync(`${dir}/config`);
  } catch {
    return false;
  }
}

export class TranscribeSttSession {
  private mic: MicSession | undefined;
  private client: TranscribeStreamingClient | undefined;
  private queue: Buffer[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;
  private stopping = false;
  private lastInterim = '';

  constructor(
    private opts: TranscribeSttOptions,
    private handlers: HostSttHandlers
  ) {}

  async start(): Promise<void> {
    this.handlers.onStatus('starting');

    let binPath: string;
    try {
      binPath = ensureMicHelper(this.opts.helperSource, this.opts.storageDir);
    } catch (e) {
      this.handlers.onStatus('unsupported', e instanceof Error ? e.message : String(e));
      this.closed = true;
      return;
    }

    this.client = new TranscribeStreamingClient({
      region: this.opts.region,
      credentials: fromNodeProviderChain(
        this.opts.profile ? { profile: this.opts.profile } : {}
      )
    });

    this.mic = startMicCapture(binPath, {
      onPCM: (chunk) => {
        if (this.closed || this.stopping) return;
        this.queue.push(chunk);
        this.waiter?.();
      },
      onError: (message) => this.fail(message),
      onDiag: this.opts.onDiag
    });

    const audio = this.audioStream();
    try {
      const res = await this.client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: normalizeTranscribeLang(this.opts.lang) as never,
          MediaSampleRateHertz: 16_000,
          MediaEncoding: 'pcm',
          AudioStream: audio
        })
      );
      this.handlers.onStatus('listening');
      for await (const event of res.TranscriptResultStream ?? []) {
        if (this.closed) break;
        const results = event.TranscriptEvent?.Transcript?.Results ?? [];
        for (const r of results) {
          const text = r.Alternatives?.[0]?.Transcript?.trim();
          if (!text) continue;
          if (r.IsPartial) {
            this.lastInterim = text;
            this.handlers.onResult({ transcript: text, isFinal: false });
          } else {
            this.lastInterim = '';
            this.handlers.onResult({ transcript: text, isFinal: true });
          }
        }
      }
      this.finish();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/credential|token|expired|denied|unauthorized/i.test(msg)) {
        this.fail(
          `AWS Transcribe auth failed (${msg}). Refresh your AWS session (e.g. aws sso login) — ` +
            'the same credentials Bedrock uses — or set codeBuild.voice.awsProfile/awsRegion.'
        );
      } else {
        this.fail(`AWS Transcribe failed: ${msg}`);
      }
    }
  }

  stop(): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    this.mic?.stop();
    this.mic = undefined;
    // Wake the generator so it ends the audio stream; Transcribe then flushes
    // the final result and closes the result stream.
    this.waiter?.();
  }

  private async *audioStream(): AsyncGenerator<AudioStream> {
    while (!this.closed) {
      while (this.queue.length) {
        const chunk = this.queue.shift()!;
        yield { AudioEvent: { AudioChunk: chunk } };
      }
      if (this.stopping) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }

  private finish(): void {
    if (this.closed) return;
    if (this.lastInterim) {
      // Stream ended with an unflushed partial — don't lose the tail.
      this.handlers.onResult({ transcript: this.lastInterim, isFinal: true });
      this.lastInterim = '';
    }
    this.closed = true;
    this.teardown();
    this.handlers.onStatus('idle');
  }

  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    this.handlers.onStatus('error', message);
  }

  private teardown(): void {
    this.mic?.stop();
    this.mic = undefined;
    this.waiter?.();
    try {
      this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.client = undefined;
  }
}

/** Transcribe wants a full locale (en-US, ru-RU…); pass through, defaulting region-less codes. */
export function normalizeTranscribeLang(lang: string): string {
  const l = (lang || '').trim();
  if (!l || l.toLowerCase() === 'auto') return 'en-US';
  if (l.includes('-')) return l;
  const map: Record<string, string> = {
    en: 'en-US',
    ru: 'ru-RU',
    de: 'de-DE',
    fr: 'fr-FR',
    es: 'es-US',
    ja: 'ja-JP',
    zh: 'zh-CN',
    pt: 'pt-BR',
    it: 'it-IT',
    ko: 'ko-KR'
  };
  return map[l.toLowerCase()] ?? 'en-US';
}
