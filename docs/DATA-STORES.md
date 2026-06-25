# Code Build — Architecture & Data Stores

A developer (and curious-user) reference for **how the Code Build extension works**
and **exactly where/how it stores data**. Everything below was written against the
source in this repo; file:line citations point at the authoritative code.

---

## 1. Overview

Code Build is a single streaming chat UI for VS Code that drives **multiple agentic
coding CLIs** behind one interface — Claude Code, Grok, Codex, and any ACP agent
(opencode, Cline). Every backend is normalized into one ACP-shaped event model
(`SessionUpdate`, `src/shared/acpTypes.ts:71`) so the webview is backend-agnostic.

What it persists locally:

- A **session store** under `~/.codebuild/` — one JSONL transcript per chat plus an
  `index.json` history list (`src/host/persistence/store.ts`).
- Sticky UI selections (last mode/model/effort) in VS Code **`globalState`**
  (`src/host/sessionManager.ts:640`) — not on disk in `~/.codebuild`.

Relationship to **Code Sessions**: the two extensions are complementary. **Code Build
*produces* sessions** (it runs the agents and writes transcripts); **Code Sessions
*analyzes* them** (it indexes and visualizes transcripts). Code Build exports a
Claude-Code-style turn JSONL (`src/host/persistence/jsonlExporter.ts`) shaped to be
readable by the Code Sessions indexer, and cross-links into Code Sessions via the
`codeSessions.viewConversation` command (`src/extension.ts:174`).

---

## 2. Architecture

```
┌─────────────────────────────┐        typed postMessage        ┌──────────────────────────────────────┐
│  Webview (React + Vite)     │ ◀══════════════════════════════▶ │  Extension Host (Node)                 │
│  webview-ui/                │   WebviewToHost / HostToWebview  │  src/host/                             │
│   · MessageList / ToolCard  │   (src/shared/protocol.ts)       │                                        │
│   · PermissionPrompt        │                                  │   SessionManager  (sessionManager.ts)  │
│   · Composer / Markdown     │                                  │      │ routes msgs ⇄ events            │
│   · DOMPurify-sanitized MD  │                                  │      ▼                                 │
└─────────────────────────────┘                                  │   AgentSession  (agentSession.ts)      │
                                                                  │   one transport per backend:           │
                                                                  │     ├ StreamJsonTransport ─▶ claude    │
                                                                  │     ├ CodexTransport      ─▶ codex     │
                                                                  │     └ AcpTransport        ─▶ grok,     │
                                                                  │                              opencode, │
                                                                  │                              cline     │
                                                                  │   SessionStore  (persistence/store.ts) │
                                                                  │   EditorTools · pathGuard · exporter   │
                                                                  └───────────────┬────────────────────────┘
                                                                                  │ spawn() over stdio
                                                                                  ▼
                                                                       agent CLI subprocesses
                                                          (stdin/stdout NDJSON or JSON-RPC; stderr → console)
```

- **Webview → Host** and **Host → Webview** messages are the typed `WebviewToHost` /
  `HostToWebview` unions in `src/shared/protocol.ts:67` and `:110`. The webview posts via
  `acquireVsCodeApi().postMessage` (`webview-ui/src/vscodeApi.ts`).
- `SessionManager` owns one chat panel + its live `AgentSession`, routing webview commands
  to the session and session events back to the webview (`sessionManager.ts:26`).
- The transport is chosen by the backend's declared `TransportKind`
  (`src/host/transports/factory.ts:15`).

---

## 3. The on-disk session store — `~/.codebuild/`

Implemented by `SessionStore` (`src/host/persistence/store.ts`). The root defaults to
`path.join(os.homedir(), '.codebuild')` (`store.ts:17`). Layout:

```
~/.codebuild/
├── index.json                 # history list: SessionMeta[] (newest first, capped at 500)
└── sessions/
    ├── <session-uuid>.jsonl    # one transcript per chat
    └── ...
```

- `sessionsDir = ~/.codebuild/sessions`, `indexPath = ~/.codebuild/index.json`; the
  `sessions/` dir is created on construction (`store.ts:19-21`).
- Session ids are `crypto.randomUUID()` (`sessionManager.ts:295`). For sessions imported
  from an upstream CLI, the **upstream** session id is reused as the local id
  (`sessionManager.ts:506`).

### Transcript record format (`sessions/<id>.jsonl`)

Each line is one JSON object. The writers (`store.ts:33-59`):

| First line | `{ "type": "meta", "meta": SessionMeta }` | Self-describing header written by `createSession()`. Rewritten in place by `updateMeta()` when the title/model changes. |
| Agent event | `{ "type": "update", "update": SessionUpdate }` | Appended on every normalized event via `appendUpdate()`. |
| User message | `{ "type": "user", "text": "<prompt>" }` | Appended by `appendUserText()` on the first/each real user prompt. |

`SessionMeta` (`src/shared/protocol.ts:22`) carries: `id`, `backend`, `title`, `mode`,
`cwd`, `createdAt`, optional `source` (`'codebuild' | 'claude' | 'grok'`),
`externalPath`, `model`, `effort`.

`SessionUpdate` is the full ACP-shaped union (§6, `src/shared/acpTypes.ts:71`).

### Index / lifecycle nuances

- A transcript is created on open, but **not** indexed until it has real content —
  `commitSession()` / `commitAndTitle()` promote it into `index.json` on the first real
  prompt (`store.ts:38`, `sessionManager.ts:617`). `list()` additionally hides any indexed
  row whose transcript has no substantive content via `hasContent()` (`store.ts:84-124`).
- `index.json` is the last 500 `SessionMeta` entries, newest first (`store.ts:129`).
- `load(id)` parses the JSONL back into `{ meta, records[] }` for UI rehydration, skipping
  corrupt lines defensively (`store.ts:66-82`).

### Plaintext — secrets persist here

Transcripts are **plaintext JSONL**. The full user prompt text (`appendUserText`) and the
full normalized agent stream (`appendUpdate`) are written verbatim. **Anything you paste
into a prompt — including API keys or secrets — is persisted to
`~/.codebuild/sessions/<id>.jsonl` in cleartext.** The directory is **gitignored**
(`.gitignore` entry `.codebuild/`) so transcripts are never committed from this repo, but
the files themselves remain on the local disk until deleted (§9).

---

## 4. The JSONL export format

`exportToClaudeJsonl(meta, records)` (`src/host/persistence/jsonlExporter.ts:17`) converts
a Code Build transcript into a **Claude-Code-style turn JSONL** that the **Code Sessions**
extension's indexer can read. The shape deliberately mirrors Claude Code's native
`*.jsonl` turn schema:

- Leading **summary** line:
  `{ type:'summary', sessionId, source:'code-build', backend, cwd, timestamp }`
  (`jsonlExporter.ts:19`).
- `type:'user'` records →
  `{ type:'user', message:{ role:'user', content:[{type:'text', text}] } }`.
- `agent_message_chunk` → `{ type:'assistant', message:{ role:'assistant',
  content:[{type:'text', text}] } }`.
- `tool_call` → an assistant message with a `tool_use` content block
  (`id`, `name`=tool title, `input`=`rawInput`).
- `result` → `{ type:'result', subtype:stopReason, total_cost_usd, usage:{input_tokens,
  output_tokens} }`.

Why this shape: Code Sessions indexes Claude Code's own transcripts directly. When Code
Build drives the real `claude`/`grok` CLIs those CLIs already persist native transcripts
Code Sessions reads; this exporter exists as a **uniform cross-link target** for
synthetic/other backends (`jsonlExporter.ts:4-10`).

---

## 5. Backend matrix

From `BACKENDS` in `src/host/backendRegistry.ts:43`. `buildArgs()` produces the spawn
argv; the binary resolves via `resolveBin()` (`backendRegistry.ts:159`): explicit
`codeBuild.binPaths` override, else the `bin` name on `PATH`.

| Backend  | id         | Transport     | Transport class            | Spawn `bin` + args (default) |
|----------|------------|---------------|----------------------------|------------------------------|
| Claude Code | `claude`  | `stream-json` | `StreamJsonTransport`     | `claude -p --input-format stream-json --output-format stream-json --verbose` [+ `--model`, `--permission-mode <m>` *or* `--dangerously-skip-permissions`, `--resume <id>`, `--effort <lvl>`] |
| Grok     | `grok`     | `acp`         | `AcpTransport`            | `grok agent stdio` [+ `--model`, `--effort`] |
| Codex    | `codex`    | `exec-json`   | `CodexTransport`          | `codex exec --json --skip-git-repo-check --sandbox <read-only\|workspace-write>` [+ `--model`, `--reasoning-effort`]; prompt appended as final argv; resume via `codex exec resume <thread_id>` |
| opencode | `opencode` | `acp`         | `AcpTransport`            | `opencode acp` |
| Cline    | `cline`    | `acp`         | `AcpTransport`            | `cline --acp` |

Notes:

- **Permission → flag mapping**: `claudePermMode()` maps `plan/acceptEdits/bypass/default`
  to the claude `--permission-mode` value; `--dangerously-skip-permissions` is used **only**
  in `bypass` mode **and only** when `allowBypass` is set (`backendRegistry.ts:70`,
  gated by `codeBuild.allowDangerouslySkipPermissions`). Codex maps mode to its sandbox:
  `acceptEdits`/`bypass` → `workspace-write`, else `read-only` (`backendRegistry.ts:148`).
- **Effort levels** (`EffortLevel`, `backendRegistry.ts:12`): `default|low|medium|high|xhigh|max`.
  `default` passes no flag.
- **Model discovery**: Grok's model list is read live from `~/.grok/models_cache.json`
  (`backendRegistry.ts:207-233`), filtering hidden models; other backends use the static
  `models` list on the spec.
- **Detection**: `detectBackend()` probes availability via `which <bin>`
  (`backendRegistry.ts:164`).

---

## 6. The ACP-canonical event model

The whole UI consumes **one** discriminated union: `SessionUpdate`
(`src/shared/acpTypes.ts:71`). Discriminators come from ACP's `session/update` vocabulary
plus a few host-level events. Kinds: `agent_message_chunk`, `agent_thought_chunk`,
`user_message_chunk`, `tool_call`, `tool_call_update`, `plan`,
`available_commands_update`, `current_mode_update`, `usage`, `usage_breakdown`, `result`,
`error`, `permission_request`.

Each transport normalizes its backend **into** this union before emitting via
`BaseAgentSession.emit()` (`src/host/agentSession.ts:63`):

- **ACP backends (grok/opencode/cline)** — `AcpTransport` receives JSON-RPC
  `session/update` notifications and maps them with `normalizeAcpUpdate()`
  (`src/host/transports/normalizers/acp.ts:26`). The ACP `sessionUpdate` discriminator maps
  almost 1:1 onto our `kind`. These backends are driven over **newline-delimited JSON-RPC**
  on the agent's stdio (`JsonRpcEndpoint`, `acpTransport.ts:73`): `initialize` →
  `session/new` → `session/prompt` (`acpTransport.ts:77-88`, `:176`).
- **Claude (`stream-json`)** — `StreamJsonTransport` runs one long-lived process and reads
  NDJSON lines; `ClaudeNormalizer.parseLine()` converts claude's `system`/`assistant`/
  `user`/`result` messages into `SessionUpdate`s, synthesizing `diff` content blocks from
  edit/write tool inputs (`normalizers/claude.ts:28`, `:135`). User prompts are encoded as
  a `{type:'user', message:{...}}` stdin line (`claude.ts:126`).
- **Codex (`exec-json`)** — `CodexTransport` is spawn-per-prompt: one process per turn,
  prompt passed as the final argv, NDJSON read until exit (`codexTransport.ts:39-76`).
  `CodexNormalizer.parseLine()` maps `thread.started`/`turn.*`/`item.*`/`error` events,
  capturing `thread_id` for resume (`normalizers/codex.ts:32`).

`SessionManager` subscribes once per session and **fans every event to both the store and
the webview** (`sessionManager.ts:300-310`): `store.appendUpdate(id, update)` +
`panel.post({type:'sessionUpdate', ...})`. It also intercepts structured `tool_call`s
(`AskUserQuestion`, `TodoWrite`/`todo_write`) to render purpose-built cards
(`sessionManager.ts:356`).

---

## 7. The `fs/*` bridge & permissions

ACP agents can ask the **client** to read/write files via the `fs/*` JSON-RPC methods.
Code Build advertises this capability on `initialize`
(`clientCapabilities.fs.{readTextFile,writeTextFile}: true`, `acpTransport.ts:79`) and
handles the agent→client requests in `AcpTransport.onRequest()` (`acpTransport.ts:106`):

- `fs/read_text_file` → reads `confineToRoot(root, path)` and returns `{ content }`.
- `fs/write_text_file` → writes to `confineToRoot(root, path)`.

### Workspace confinement guard

`confineToRoot(root, requested)` (`src/host/pathGuard.ts:14`) resolves the requested path
against the session **cwd** (the sandbox root, `acpTransport.ts:99-104`), normalizes `..`,
and **throws if the resolved path escapes the root** (`!== root` and not prefixed by
`root + sep`). This blocks a compromised or prompt-injected agent from reading/writing
arbitrary files (e.g. `~/.ssh/id_rsa`, `~/.aws/credentials`) through the `fs/*` bridge —
which crucially **never passes through the interactive permission UI**. The session cwd is
the first workspace folder, falling back to `process.cwd()` (`sessionManager.ts:54`).

### Interactive permissions (`session/request_permission`)

When an ACP agent requests permission for a tool, `AcpTransport.handlePermission()`
(`acpTransport.ts:127`):

1. **Auto-approves** to match Claude Code semantics — `bypass` mode (only when
   `allowBypass`) approves everything; `acceptEdits` approves edit/write/create tools but
   still prompts for the rest (Bash, fetch, …). It picks the strongest "allow" option the
   agent offered (`allow_always` > `allow_once`).
2. Otherwise emits a `permission_request` `SessionUpdate` (with `requestId`, the tool call,
   and `options[]`), which `SessionManager` forwards to the webview. The webview renders
   `PermissionPrompt` and posts back `respondPermission`
   (`protocol.ts:87`); the host calls `session.respondPermission(requestId, outcome)`
   (`sessionManager.ts:140`), resolving the pending JSON-RPC reply (`acpTransport.ts:199`).

> Codex uses sandbox policy rather than interactive prompts, so its
> `respondPermission` is a no-op (`codexTransport.ts:98`). The claude stream-json
> interactive permission round-trip is not yet wired (`streamJsonTransport.ts:147`); claude
> permissions are governed at spawn time by `--permission-mode` / `--dangerously-skip-permissions`.

---

## 8. Settings & commands

### Settings (`codeBuild.*`, `package.json:144`)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `codeBuild.defaultBackend` | enum `claude\|grok\|codex\|opencode\|cline` | `claude` | Backend for new chats. |
| `codeBuild.initialPermissionMode` | enum `default\|plan\|acceptEdits\|bypass` | `default` | Initial permission mode. |
| `codeBuild.allowDangerouslySkipPermissions` | boolean | `false` | Permit `bypass` mode / `--dangerously-skip-permissions`. Security-sensitive. |
| `codeBuild.binPaths` | object (`{ id: path }`) | `{}` | Explicit CLI paths per backend id. |
| `codeBuild.autoStartSession` | boolean | `true` | Connect to the default backend on chat open. |
| `codeBuild.defaultModel` | string | `""` | Default model id passed on start. |
| `codeBuild.defaultEffort` | enum `default…max` | `default` | Default effort/thinking budget. |

### Commands (`package.json:43`)

- `codeBuild.newConversation`, `codeBuild.openInNewTab`, `codeBuild.openInNewWindow`,
  `codeBuild.focusInput`, `codeBuild.openPreviousSession` — panel/window/history controls
  (`src/extension.ts:27`).
- `codeBuild.openInCodeSessions` — cross-extension link. Best-effort: if the
  **`codeSessions.viewConversation`** command exists, it's invoked with the session id;
  otherwise a notice is shown (`src/extension.ts:151-161`). The webview triggers this via
  the `openInCodeSessions` message (`sessionManager.ts:148`).
- `codeBuild.openExternalSession` (programmatic, **not** in the command palette) — the
  inverse direction: Code Sessions invokes it with `{ source, sessionId, cwd, title }` to
  open a claude/grok session inside Code Build (`src/extension.ts:53`).

---

## 9. Inspect / reset

- The store lives at **`~/.codebuild/`**. To wipe all Code Build history:
  `rm -rf ~/.codebuild` (this removes `index.json` and `sessions/*.jsonl`). Sticky UI prefs
  in VS Code `globalState` are separate and unaffected.
- Inspect a single transcript: `cat ~/.codebuild/sessions/<id>.jsonl` (one JSON object per
  line: a `meta` header then `user`/`update` records).
- **Manual integration harnesses** in `test/manual/` drive the *real* CLIs end-to-end
  (require the CLI on `PATH` and a valid login):
  - `npx tsx test/manual/claudeRoundtrip.ts` — claude via `StreamJsonTransport`.
  - `npx tsx test/manual/codexRoundtrip.ts` — codex via `CodexTransport`.
  - `npx tsx test/manual/grokRoundtrip.ts` — grok via `AcpTransport`.
  - `npx tsx test/manual/grokPermission.ts` — grok permission round-trip.
- Unit tests (no CLIs needed): `npm run test:unit` (`test/unit/*.test.ts`, incl.
  `persistence.test.ts` and the normalizer tests).

---

## 10. Privacy & security

- **Subprocess model** — agents run as **local subprocesses** spawned over stdio
  (`spawn(bin, args, { cwd, env, stdio })` in each transport). Code Build sends **no data
  to any external service itself**; network traffic is whatever the agent CLI makes on its
  own (e.g. the model provider). Conversation content stays on disk in `~/.codebuild`.
- **Environment** — subprocesses inherit a copy of the host environment
  (`env: { ...process.env }`, e.g. `streamJsonTransport.ts:52`,
  `acpTransport.ts:61`, `codexTransport.ts:56`) so subscription/login auth keeps working.
  Code Build **never injects API keys** into the child env (`streamJsonTransport.ts:51`).
- **stderr logging** — subprocess stderr is logged to the extension host console prefixed
  `[code-build:<backend>]`; `StreamJsonTransport` additionally buffers stderr (capped at
  8 KB) so a non-zero exit can surface the real error in the chat
  (`streamJsonTransport.ts:68-110`).
- **Webview hardening** — the webview HTML carries a strict CSP
  (`default-src 'none'`; scripts only via a per-load nonce; `localResourceRoots` limited to
  `dist/webview`) (`src/host/webviewHtml.ts:19-25`, `:43`). Assistant markdown is rendered
  through **`marked` + DOMPurify** sanitization; links are forced to
  `target=_blank rel=noopener noreferrer` (`webview-ui/src/components/Markdown.tsx`).
- **fs confinement** — the `fs/*` bridge is sandboxed to the session cwd via
  `confineToRoot()` (§7), the one filesystem path that bypasses the interactive permission
  UI.
- **Plaintext store** — see §3: transcripts are unencrypted; pasted secrets persist on
  local disk until `~/.codebuild` is deleted.
