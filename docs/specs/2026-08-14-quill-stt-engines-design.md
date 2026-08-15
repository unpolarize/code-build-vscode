# Quill-style streaming STT engines for Code Build voice

**Date:** 2026-08-14 · **Target version:** 0.14.0 · **Status:** approved (autonomous session, user asked "plan and implement")

## Why

CB's voice bar (dictation / hands-free / VIS) already has UI, protocol, and TTS, but both
STT engines are workarounds:

- **host** — bridges through the `ms-vscode.vscode-speech` extension by opening a scratch
  editor and mirroring `editorDictation` text. Requires a marketplace extension, flashes an
  editor, and quality is Azure-embedded-model tier.
- **webview** — `webkitSpeechRecognition` in the chat iframe, usually blocked (`not-allowed`)
  because VS Code sandboxes webviews without a microphone Permissions-Policy.

[xfreeze2/quill](https://github.com/xfreeze2/quill) (MIT) proves a better path on exactly our
stack: stream 16 kHz mono PCM16 over a WebSocket to **`wss://api.x.ai/v1/stt`**, authenticated
with the **grok CLI's stored OIDC token** (`~/.grok/auth.json`) — the same subscription-backed
token Grok Build's `/voice` uses. No API key, nothing metered, live partials.

## What we build

Two new **host-side** STT engines behind the existing `sttStart`/`sttResult`/`sttStatus`
protocol (webview contract unchanged), plus a shared mic-capture helper:

1. **`xai`** — reimplementation of Quill's verified protocol in the extension host:
   - Auth: `codeBuild.voice.xaiApiKey` setting → `XAI_API_KEY` env → newest entry with a
     `key` in `~/.grok/auth.json` (Quill's Auth.swift ported; explicit key wins, expiry
     surfaced as "open Grok once to refresh").
   - Socket: `wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true`
     (+`language` when `voice.lang` isn't auto; primary subtag, e.g. `en-US` → `en`),
     `Authorization: Bearer`, binary PCM16 frames up, JSON down.
   - Transcript model (Quill's, verified live by its author): partials are cumulative per
     segment keyed by `start`; segments close with `is_final` **emitted twice**; interim
     empties must never wipe recorded text; `transcript.done` may carry a consolidated text
     that replaces everything. **Last-write-wins per `start`, never append.**
   - CB mapping: open segment text → `sttResult{isFinal:false}` (interim display); first
     `is_final` per segment → `sttResult{isFinal:true}` with that segment's text (webview
     appends finals as utterance chunks — matches existing host-bridge semantics).
2. **`transcribe`** — same mic pipeline into **Amazon Transcribe streaming**
   (`@aws-sdk/client-transcribe-streaming`, default Node credential chain +
   `codeBuild.voice.awsRegion` / `voice.awsProfile`). This is the work-MacBook answer, where
   models are Bedrock-only: **Anthropic/Claude has no STT API and Bedrock hosts no streaming
   STT model**, so the analogous move to Quill's credential reuse is reusing the *same AWS
   credential chain Claude-on-Bedrock uses* against Transcribe. `IsPartial:true` → interim,
   `IsPartial:false` → final chunk.

### Mic capture

The extension host (Node) has no microphone, and the webview iframe is sandboxed. Quill's
Recorder.swift is ported to a ~60-line helper, `resources/mic/MicCap.swift`: AVAudioEngine
tap → AVAudioConverter → 16 kHz mono PCM16 on **stdout**, peak-level diagnostics on stderr,
exits when stdin closes. Compiled on demand with `xcrun swiftc -O` into `globalStorage`,
cached by source hash. macOS mic TCC attributes child processes to the responsible process
(VS Code), whose Info.plist has `NSMicrophoneUsageDescription` — unlike the Speech-Recognition
TCC class that killed the earlier SFSpeechRecognizer helper prototype (see sttHost.ts header).
Both new engines are therefore **darwin-only**; other platforms keep the existing engines.

### Engine resolution

`codeBuild.voice.sttEngine`: `auto | xai | transcribe | host | webview | off`
(`host` keeps meaning the VS Code Speech bridge, back-compat).

`auto` order: **xai** (darwin + creds present) → **transcribe** (darwin + AWS creds hint:
env/`~/.aws`) → **host** (Speech ext installed) → **webview**. Forced engines resolve to
`off` with a guidance detail when unavailable. Webview hydrate still sees only
`host | webview | off` — xai/transcribe map to `host`, `hostSttAvailable` = any host engine.

### Out of scope (YAGNI)

- Quill's grammar **Polish** step — CB's composer is editable before send; a polish pass can
  later reuse the Claude Code CLI (`claude -p`, works on Bedrock via `CLAUDE_CODE_USE_BEDROCK=1`)
  the way Quill reuses the grok login. Documented, not built.
- Quill's insert-anywhere/hotkey/HUD — that's Quill's job; it already types into the CB
  composer as a standalone app and remains a fine zero-integration option.
- Whisper.cpp offline engine — fallback candidate if Transcribe perms are denied at work.

## Files

- `src/host/voice/grokAuth.ts` — auth.json reader (pure, path-injectable)
- `src/host/voice/xaiStt.ts` — `XaiTranscriptAccumulator` (pure) + WebSocket session
- `src/host/voice/micCapture.ts` — compile-cache + spawn of MicCap
- `resources/mic/MicCap.swift` — mic → PCM16 stdout helper
- `src/host/voice/transcribeStt.ts` — AWS Transcribe session
- `src/host/voice/sttResolve.ts` — extended resolver (pure, unit-tested)
- `src/host/sessionManager.ts` — engine dispatch in `hostSttStart`, hydrate mapping
- `package.json` — settings, deps (`ws`, `@aws-sdk/client-transcribe-streaming`,
  `@aws-sdk/credential-providers`), version 0.14.0
- Tests: `test/unit/xaiStt.test.ts`, `grokAuth.test.ts`, `sttResolve.test.ts`;
  live check `test/manual/xaiSttLive.ts` (`say -o` → `afconvert` → socket → assert transcript)

## Error handling

Every failure posts `sttStatus{error|unsupported, detail}` with actionable copy (Quill's
messages reused): 401/403 → "Grok session expired — open Grok once to refresh"; no swiftc →
install CLT or switch engine; socket close with text already captured → complete, not error.
Stop sends `{"type":"audio.done"}`, waits ≤3 s for the tail, then closes (Quill's finish()).
