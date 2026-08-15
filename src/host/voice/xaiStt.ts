// Streaming speech-to-text over the same socket Grok Build's /voice uses —
// a port of Quill's STT.swift (xfreeze2/quill, MIT), verified live against
// the endpoint by its author:
//   → binary PCM16 frames (16 kHz mono), then {"type":"audio.done"}
//   ← {"type":"transcript.created", id}
//   ← {"type":"transcript.partial", text, start, is_final, speech_final}
//   ← {"type":"transcript.done"}  (text usually empty; the real text is the
//                                  accumulation of the partials)
//
// The server segments an utterance by `start` time. Within one segment the
// partials are cumulative (each carries the whole segment so far), and the
// segment closes with is_final=true — emitted TWICE with identical text. So
// the only correct model is last-write-wins per `start`, never append.

export interface XaiSttCallbacks {
  /** Cumulative text of segments still open — interim display. */
  onInterim: (text: string) => void;
  /** A segment closed — emit its text once, as an utterance chunk. */
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  /** transcript.done processed (tail flushed via onFinal first). */
  onDone: () => void;
}

export class XaiTranscriptAccumulator {
  private segmentOrder: number[] = [];
  private segments = new Map<number, string>();
  private finalized = new Set<number>();
  private emittedAny = false;
  private done = false;

  constructor(private cb: XaiSttCallbacks) {}

  /** Full transcript so far, finalized or not. */
  get transcript(): string {
    return this.segmentOrder
      .map((s) => this.segments.get(s))
      .filter((t): t is string => !!t)
      .join(' ');
  }

  get isDone(): boolean {
    return this.done;
  }

  handleMessage(json: string): void {
    if (this.done) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'transcript.partial': {
        const start = typeof msg.start === 'number' ? msg.start : 0;
        this.record(start, typeof msg.text === 'string' ? msg.text : '');
        if (msg.is_final === true) this.finalize(start);
        this.emitInterim();
        break;
      }
      case 'transcript.done': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (text && !this.emittedAny && this.openText() === '') {
          // Server sent a consolidated transcript and we streamed nothing —
          // prefer it wholesale.
          this.cb.onFinal(text);
          this.emittedAny = true;
        } else {
          this.flushOpen();
        }
        this.done = true;
        this.cb.onDone();
        break;
      }
      case 'error': {
        const message =
          (typeof msg.message === 'string' && msg.message) ||
          (typeof msg.error === 'string' && msg.error) ||
          'Transcription error';
        this.cb.onError(message);
        break;
      }
      default:
        break;
    }
  }

  /** Emit any still-open segments as a final chunk (used on stop/close). */
  flushOpen(): void {
    const open = this.openText();
    if (open) {
      for (const s of this.segmentOrder) this.finalized.add(s);
      this.emittedAny = true;
      this.cb.onFinal(open);
      this.cb.onInterim('');
    }
  }

  private record(start: number, text: string): void {
    const trimmed = text.trim();
    // Interim empties are the server clearing its buffer between segments —
    // they must never wipe text we already have.
    if (!trimmed) return;
    if (!this.segments.has(start)) this.segmentOrder.push(start);
    this.segments.set(start, trimmed);
  }

  private finalize(start: number): void {
    if (this.finalized.has(start)) return; // is_final arrives twice
    const text = this.segments.get(start);
    if (!text) return;
    this.finalized.add(start);
    this.emittedAny = true;
    this.cb.onFinal(text);
  }

  private openText(): string {
    return this.segmentOrder
      .filter((s) => !this.finalized.has(s))
      .map((s) => this.segments.get(s))
      .filter((t): t is string => !!t)
      .join(' ');
  }

  private emitInterim(): void {
    this.cb.onInterim(this.openText());
  }
}

/** wss://api.x.ai/v1/stt URL with Quill's query parameters. */
export function xaiSttUrl(lang?: string): string {
  const params = new URLSearchParams({
    sample_rate: '16000',
    encoding: 'pcm',
    interim_results: 'true'
  });
  const primary = (lang ?? '').split('-')[0].trim().toLowerCase();
  if (primary && primary !== 'auto') params.set('language', primary);
  return `wss://api.x.ai/v1/stt?${params.toString()}`;
}
