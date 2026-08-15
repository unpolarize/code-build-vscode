# Code Build voice mode

**Version:** 0.13.2+

Hands-free and ideation surfaces for the Code Build webview: dictation, continuous interactive mode (listen → send → speak reply), and **Voice Ideation Sessions (VIS)** that extract thoughts/ideas into the knowledge-planning store.

## Modes

| Mode | What it does | How to start |
|------|----------------|--------------|
| **Dictation** | Mic → text in the composer (you send) | Voice bar **Mic**, 🎤 button, `/dictation`, `Ctrl+Shift+Space` |
| **Hands-free** | Continuous listen → auto-send on pause → TTS on reply → listen again | Voice bar **Hands-free**, `/voice`, `Ctrl+Alt+Shift+V` |
| **VIS** | Hands-free + facilitation prompt; end extracts KP objects | Voice bar **VIS**, `/vis`, `Ctrl+Alt+Shift+I` |
| **Stop** | Stops mic + TTS | Voice bar **Stop**, `/stop-voice` |

## Voice Ideation Session (VIS)

1. Start VIS (new session, badge **VIS**).
2. Agent greets with a short spoken-friendly invitation.
3. Ramble (hands-free). Agent mirrors problems and candidate slices.
4. End with **End VIS**, `/vis-close`, or say *“close session” / “wrap up”*.
5. Agent creates KP objects via MCP when available; otherwise emits a JSON fence that the host writes with `kp create` / `kp capture`.

**Provenance:** `source: voice-ideation`, tags `voice-ideation,vis`, optional `--session <cb-session-id>`.

### KP configuration

For durable writes set:

```json
{
  "codeBuild.kp.command": "/Users/you/projects/unpolarize/knowledge-planning/src/cli/index.ts",
  "codeBuild.kp.root": "/Users/you/docs/planning",
  "codeBuild.kpMcp.enabled": true
}
```

VIS **force-enables** KP MCP injection on ACP backends (Grok/Codex) even when `kpMcp.enabled` is false, as long as `kp.command` + `kp.root` are set. Claude (stream-json) relies on the host JSON fallback after close.

If `kp.root` is unset, the host tries `~/docs/planning` when that directory exists.

## TTS

| Setting | Values |
|---------|--------|
| `codeBuild.voice.ttsEnabled` | default `true` |
| `codeBuild.voice.ttsEngine` | `auto` (macOS → `say`, else webview), `webview`, `system`, `off` |
| `codeBuild.voice.systemVoice` | optional `say -v` name |

Only **assistant reply text** is spoken (markdown stripped; code fences omitted). Tool spam is not read.

## STT

### xAI streaming STT (`xai`) — **preferred, auto-selected on macOS with a grok login**

The [Quill](https://github.com/xfreeze2/quill) approach (MIT), reimplemented in the extension
host — design: `docs/specs/2026-08-14-quill-stt-engines-design.md`:

1. A tiny bundled Swift helper (`resources/mic/MicCap.swift`, compiled once with
   `xcrun swiftc` into globalStorage) captures the mic as **16 kHz mono PCM16**. The mic TCC
   grant is VS Code's own — no extra permission dance.
2. The host streams frames to **`wss://api.x.ai/v1/stt`**, authenticated with the **grok CLI
   subscription login** (`~/.grok/auth.json`) — the same token Grok Build's `/voice` uses.
   Nothing metered, no API key needed. `codeBuild.voice.xaiApiKey` / `XAI_API_KEY` override
   for people without a subscription.
3. Live partials show as interim text; each closed segment lands as a final chunk in the
   composer / hands-free pipeline.

Requires: macOS, Xcode Command Line Tools (one-time compile), a grok CLI login or xAI key.

### Amazon Transcribe streaming (`transcribe`) — the work-machine engine

For machines where the only model access is **AWS** (e.g. Claude via Bedrock): Anthropic has
no STT API and Bedrock hosts no streaming STT model, so CB points the **same AWS credential
chain Bedrock uses** (env / SSO / `~/.aws`, optional `codeBuild.voice.awsProfile`) at
**Amazon Transcribe streaming** in `codeBuild.voice.awsRegion`. Needs
`transcribe:StartStreamTranscription` permission. Same mic helper, same UX.

### Host STT via VS Code Speech (`host`)

`codeBuild.voice.sttEngine: auto` resolves to **host** when neither `xai` nor `transcribe`
is available and [VS Code Speech](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-speech) (`ms-vscode.vscode-speech`) is installed.

How it works:

1. CB opens a small **scratch editor** beside the chat.
2. Runs workbench **editor dictation** (`workbench.action.editorDictation.start`), which uses the Speech extension’s on-device models and the **host process mic grant** (System Settings → Microphone for VS Code / Cursor).
3. Streams recognized text into the CB composer / hands-free pipeline.
4. **Stop** ends dictation and closes the scratch tab.

This is the real fix for “mic allowed in System Settings but CB still says denied”: the chat webview iframe never receives mic permission; host STT never asks the iframe.

**Install:** Extensions → search “VS Code Speech” → install → reload. Grant **Microphone** to VS Code if prompted.

> Why not call Apple Speech / Web Speech inside the extension host directly?  
> VS Code does not expose a public consumer API for speech providers (only `registerSpeechProvider`). Ad-hoc native helpers abort under macOS TCC without a signed app identity. The marketplace Speech extension is the supported host path.

### Webview STT (fallback)

Browser `SpeechRecognition` / `webkitSpeechRecognition` inside the chat **webview iframe**.

**Why it often fails even when Mic is allowed for VS Code:** the chat is a sandboxed iframe without a microphone Permissions-Policy. Granting Microphone to VS Code unlocks the **host** process (what VS Code Speech needs), **not** the iframe. Web Speech may also need Google’s cloud speech stack, which Electron builds often omit.

Before starting, CB runs a **`getUserMedia({ audio: true })` preflight** so failures are explicit. Errors explain the sandbox and point at host STT / OS dictation — they do **not** tell you to flip a System Settings toggle you’ve already allowed.

### Zero-code fallback

**macOS system dictation** → focus the CB composer, press **Fn Fn** (or your dictation shortcut), speak. Types into any focused field, including the webview input.

### Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `codeBuild.voice.enabled` | `true` | Show Voice bar |
| `codeBuild.voice.lang` | `en-US` | STT/TTS language (also best-effort `accessibility.voice.speechLanguage`) |
| `codeBuild.voice.utteranceEndMs` | `1400` | Silence before auto-send |
| `codeBuild.voice.sttEngine` | `auto` | `auto` \| `xai` \| `transcribe` \| `host` \| `webview` \| `off` — auto order: xai → transcribe → host → webview |
| `codeBuild.voice.xaiApiKey` | `""` | Optional xAI key for `xai`; wins over the grok CLI login |
| `codeBuild.voice.awsRegion` | `us-west-2` | Region for `transcribe` |
| `codeBuild.voice.awsProfile` | `""` | Optional AWS profile for `transcribe` (default chain otherwise) |

## Slash commands

- `/voice` — hands-free toggle  
- `/dictation` — dictation toggle  
- `/vis` — start VIS  
- `/vis-close` — end VIS + KP extract  
- `/stop-voice` — stop mic/TTS  

## Commands palette

- Code Build: Toggle Voice Dictation  
- Code Build: Toggle Hands-Free Voice Mode  
- Code Build: Start Voice Ideation Session  
- Code Build: End Voice Ideation Session (save to KP)  
- Code Build: Stop Voice  

## Limitations

- Host STT requires **VS Code Speech** and briefly opens a scratch editor (closed on Stop).
- Webview STT is unreliable in VS Code’s sandboxed chat iframe.
- Full-duplex barge-in while tools run is limited (listen pauses while busy / while TTS plays).
- VIS does not auto-implement ideas; it only creates planning objects for later triage.
