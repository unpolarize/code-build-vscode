// Pure STT engine resolution (no vscode import — unit-testable).

export type SttEnginePref = 'auto' | 'xai' | 'transcribe' | 'host' | 'webview' | 'off';

/**
 * Host-side engine actually used:
 * - xai: Quill-style streaming STT against wss://api.x.ai/v1/stt (grok CLI
 *   creds or xAI key) — best quality, darwin-only (mic helper)
 * - transcribe: Amazon Transcribe streaming (AWS credential chain — the same
 *   creds Claude-on-Bedrock uses on the work machine), darwin-only
 * - host: VS Code Speech extension bridge (scratch editor + editorDictation)
 * - webview: in-webview Web Speech (may fail in sandboxed iframe)
 * - off: voice STT disabled
 */
export type ResolvedSttEngine = 'xai' | 'transcribe' | 'host' | 'webview' | 'off';

export interface SttAvailability {
  /** darwin + grok auth.json or an xAI key */
  xai: boolean;
  /** darwin + AWS credentials discoverable */
  transcribe: boolean;
  /** ms-vscode.vscode-speech installed */
  speechExt: boolean;
}

export function resolveSttEngine(
  configured: SttEnginePref | undefined,
  avail: SttAvailability
): ResolvedSttEngine {
  const c = configured ?? 'auto';
  if (c === 'off') return 'off';
  if (c === 'webview') return 'webview';
  if (c === 'xai') return avail.xai ? 'xai' : 'off';
  if (c === 'transcribe') return avail.transcribe ? 'transcribe' : 'off';
  if (c === 'host') return avail.speechExt ? 'host' : 'off';
  // auto: best streaming engine first, then the Speech-extension bridge.
  if (avail.xai) return 'xai';
  if (avail.transcribe) return 'transcribe';
  if (avail.speechExt) return 'host';
  return 'webview';
}

/** What the webview needs to know — it treats every host engine the same. */
export function webviewSttEngine(resolved: ResolvedSttEngine): 'host' | 'webview' | 'off' {
  if (resolved === 'webview' || resolved === 'off') return resolved;
  return 'host';
}

export function hostSttUnavailableDetail(): string {
  return (
    'Host STT needs the “VS Code Speech” extension (ms-vscode.vscode-speech). ' +
    'Install it from the marketplace, reload, then try again. ' +
    'Meanwhile: focus the composer and use OS dictation (Fn Fn on macOS), ' +
    'or set codeBuild.voice.sttEngine to “webview” (often blocked by the chat iframe sandbox).'
  );
}

export function engineUnavailableDetail(pref: SttEnginePref): string {
  switch (pref) {
    case 'xai':
      return (
        'xAI STT needs a credential: log into the grok CLI once (writes ~/.grok/auth.json), ' +
        'or set codeBuild.voice.xaiApiKey / XAI_API_KEY. macOS only (mic helper).'
      );
    case 'transcribe':
      return (
        'AWS Transcribe STT needs AWS credentials (env, ~/.aws, or codeBuild.voice.awsProfile) ' +
        'and transcribe:StartStreamTranscription permission. macOS only (mic helper).'
      );
    case 'host':
      return hostSttUnavailableDetail();
    default:
      return 'Voice STT is disabled (codeBuild.voice.sttEngine: off).';
  }
}
