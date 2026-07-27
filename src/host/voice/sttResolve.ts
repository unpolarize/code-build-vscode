// Pure STT engine resolution (no vscode import — unit-testable).

export type SttEnginePref = 'auto' | 'webview' | 'host' | 'off';

/**
 * Resolve which STT path the webview should use.
 * - host: host STT available and preferred
 * - webview: use in-webview Web Speech (may fail in sandboxed iframe)
 * - off: voice STT disabled
 */
export function resolveSttEngine(
  configured: SttEnginePref | undefined,
  hostAvailable: boolean
): 'host' | 'webview' | 'off' {
  const c = configured ?? 'auto';
  if (c === 'off') return 'off';
  if (c === 'webview') return 'webview';
  if (c === 'host') return hostAvailable ? 'host' : 'off';
  // auto: prefer host when available
  if (hostAvailable) return 'host';
  return 'webview';
}

export function hostSttUnavailableDetail(): string {
  return (
    'Host STT needs the “VS Code Speech” extension (ms-vscode.vscode-speech). ' +
    'Install it from the marketplace, reload, then try again. ' +
    'Meanwhile: focus the composer and use OS dictation (Fn Fn on macOS), ' +
    'or set codeBuild.voice.sttEngine to “webview” (often blocked by the chat iframe sandbox).'
  );
}
