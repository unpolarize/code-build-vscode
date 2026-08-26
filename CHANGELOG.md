# Changelog

## 0.16.1 — 2026-08-26

### /compact marker plumbing (slice 1 of the built-in /compact)

- **`CompactMarker` in `shared/protocol.ts`** — `{ at, preTokens?, summaryPreview, instructions? }`, plus the `compactMarker` host→webview event, the `compact` webview→host command type (handler lands with the compact verb slice), and a `marker` field on `historyLoaded` records.
- **`SessionStore.appendCompactMarker`** persists a `{ type: 'compact', marker }` transcript record; it replays through `load()`/`historyLoaded` like any body line, and a marker alone never counts as content.
- **Webview timeline** — new `compact` ChatItem renders as a quiet dashed divider ("Context compacted · Nk tokens summarized", summary/focus in the hover tooltip), never a bubble; scrollback above it is kept. The divider is also a turn boundary: `result` after a compact never aggregates pre-compact tool edits into the files card.
- 5 new unit tests: store round-trip + not-content, reducer append, replay of both segments around the divider, files-card boundary. (kp: tasks/cb-built-in-compact-one-click-context-compaction)

## 0.16.0 — 2026-08-23

### Host-side stop governor (umbrella slice)

- **New `src/host/stopGovernor.ts`** — per-session budgets that catch runaway agent sessions at the ACP host layer, across every backend: `maxToolCalls` (default 400), `maxWallMinutes` of ACTIVE agent time (turn-open wall clock only — idle time between your messages never counts; default off), and `maxEstUsd` from the backend's cumulative usage cost (default off). Each budget fires at most once per session.
- **Warn-only by default**: `codeBuild.governor.mode` = `warn` shows a sticky banner (tripped budget + last 5 tool titles + session counters) and records the event, but never interrupts. `hard` also cancels the active stream — the session stays resumable (context intact; next message resumes). `off` disables everything. Existing sessions see zero behavior change until a limit is actually crossed.
- **Stop events persist on SessionMeta** (`stopEvents[]`: budget, action, counters, last tools) so CSV can join stop outcomes to sessions later.
- Config surface reserved for the delegated detector slices: `codeBuild.governor.dupToolStop` and `codeBuild.governor.noProgressStop` (both default false, not yet active — identical-tool-signature and no-progress detectors are child KP items that will reuse this trip/banner plumbing).
- 9 new unit tests (pure, injected clock — no VS Code, no network). (kp: ideas/cb-host-side-stop-governor-tool-call-time-spend)

## 0.15.1 — 2026-08-22

### MCP schema token budget (PR1)

- New settings `codeBuild.mcpSchemaTokenBudget` (default 6000) and `codeBuild.mcpPriority`.
- On ACP session/new|load, known MCP tool-schema costs are knapsacked under the budget; at the default, playwright (~4617) is deferred so chrome-devtools (~5811) fits. Set budget to `0` to restore the full list.
- Per-server optional `schemaTokens` on `codeBuild.mcpServers` overrides the static table; unknown-cost servers are included fail-open; `kp` is always exempt.
- Log line on the **Code Build: MCP** output channel: `MCP schema budget: included=[…] deferred=[…] budget=N`.
- Live tools/list probe + cache is deferred to PR2. (kp: ideas/cb-mcp-schema-token-budget-measure-tool-schema-t, agent: grok)

## 0.15.0 — 2026-08-14

### Resizable composer

- Drag the handle above the input to grow or shrink it. A maximize/restore button expands the composer to most of the panel. Height persists across reloads.

### Turn navigation stays on the prompt

- ↑/↓ (and Alt+arrows) pin the user prompt at the top so the reply is visible below. Manual scroll or navigation pauses follow-the-bottom; Send, **latest**, or ↓ to the last turn resumes it. Streaming no longer jumps you off a turn you just scrolled to.

### Stall timeout is warn-only by default

- `codeBuild.stallAutoCancelSeconds` default is now `0` (alert, do not kill). A header picker sets the current session to never / 2m / 5m / 10m and remembers the last choice for new sessions.

### Grok question picker (ACP)

- CB implements `_x.ai/ask_user_question` / `x.ai/ask_user_question`. Grok's blocking questionnaire now opens the existing AskUserQuestion card instead of failing with `Method not found`. Answers resolve the ACP request (not a Claude-style tool_result).

## 0.14.0 — 2026-08-14

### Quill-style streaming STT engines (voice input that actually hears you)

- **New `xai` STT engine** — reimplements [xfreeze2/quill](https://github.com/xfreeze2/quill)'s verified pipeline in the extension host: bundled Swift mic helper (16 kHz mono PCM16, compiled once via `xcrun swiftc`, uses VS Code's own mic grant) → `wss://api.x.ai/v1/stt` with the **grok CLI subscription login** (`~/.grok/auth.json`; `codeBuild.voice.xaiApiKey`/`XAI_API_KEY` override). Live interim partials + per-segment finals; last-write-wins segment model; `audio.done` tail flush. Verified live end-to-end (`test/manual/xaiSttLive.ts`).
- **New `transcribe` STT engine** — Amazon Transcribe streaming for Bedrock-only work machines (Anthropic/Bedrock have no STT); reuses the same AWS credential chain Claude-on-Bedrock uses. Settings: `codeBuild.voice.awsRegion`, `codeBuild.voice.awsProfile`.
- **`codeBuild.voice.sttEngine`** enum extended: `auto | xai | transcribe | host | webview | off`; auto order xai → transcribe → host (VS Code Speech bridge) → webview. Webview protocol unchanged.
- Design doc: `docs/specs/2026-08-14-quill-stt-engines-design.md`; `docs/VOICE.md` updated.
- Deps: `ws`, `@aws-sdk/client-transcribe-streaming`, `@aws-sdk/credential-providers`.

## 0.13.3 — 2026-08-13

### Dual-write session identity (final slice)

- **CROSS-LINK join contract** — `docs/CROSS-LINK.md` freezes CB↔native keys (`meta.id`, `backendSessionId`, `backendSessionHistory`, `native`), N:1 mapping, external-open rule, and the native format map for CSV/analytics consumers.
- **Exporter summary fields** — `exportToClaudeJsonl` includes `backendSessionId` + `native` on the summary line only when set (additive; absent metas stay byte-identical, no null spam). (kp: ideas/cb-dual-write-backendsessionid-shared-grok-cb-se)
- **Fixtures-first native-id backfill** + `updateMeta` read-modify-write for dual-write identity.

### Pre-send token estimate chip

- Composer shows a rough outbound token estimate next to Send (`~12k tok · ~8% window`) while you type. Heuristic is chars÷4 (no tokenizer API call); debounced 200ms. Window % uses a small hardcoded model-family table when the selected model is known. Does not block send; estimate failure hides the chip. (kp: ideas/cb-pre-send-prompt-context-token-estimate-chip-r)

## 0.13.2 — 2026-07-25

### Voice STT that actually works (host path + honest webview errors)

- **(c) Host-side STT via VS Code Speech** — when `ms-vscode.vscode-speech` is installed, `codeBuild.voice.sttEngine: auto` prefers **host**. CB opens a scratch editor and runs workbench editor dictation so recognition uses the Speech extension + **host process mic grant** (not the sandboxed chat iframe). Protocol: `sttStart` / `sttStop` ↔ `sttResult` / `sttStatus`. Without the Speech extension, host mode explains how to install it and points at OS dictation.
- **(b) Webview getUserMedia preflight** — before `webkitSpeechRecognition.start()`, request `{ audio: true }` so permission failures are explicit (and occasionally surface a prompt). Does not fix the iframe sandbox by itself.
- **(a) Honest errors** — `not-allowed` / preflight denial no longer say “allow mic in System Settings” (you already did). They explain the webview sandbox limit and point to **host STT** or **OS dictation (Fn Fn)**. Network Speech errors also mention Electron’s missing Google speech endpoint.
- Setting: `codeBuild.voice.sttEngine` = `auto` | `host` | `webview` | `off`. Docs: [docs/VOICE.md](docs/VOICE.md).

## 0.13.1 — 2026-07-25

### Fixed

- **Switching to an uninstalled backend no longer poisons the session.** Picking a backend that isn't on PATH (e.g. Grok on a machine without it) used to latch the outgoing session and then fail inside the spawn, so flipping *back* to the original agent fired an endless `--resume` loop (`Couldn't resume … error_during_execution`). `switchBackend` now preflights availability with `detectBackend`, refuses cleanly with a clear notice, and leaves the live session and thread untouched. (+3 tests)

## 0.13.0 — 2026-07-25

### Voice mode (dictation · hands-free · VIS · TTS)

- **Dictation** — Web Speech STT fills the composer; mic button + Voice bar + `/dictation` + `Ctrl+Shift+Space`.
- **Hands-free interactive** — continuous listen → silence debounce → auto-send → read assistant reply aloud → re-listen (`/voice`, Voice bar **Hands-free**). Mid-turn steer still works while the agent is busy.
- **TTS** — webview `speechSynthesis` or macOS `say` (`codeBuild.voice.ttsEngine`: auto/webview/system/off). Markdown stripped for natural speech.
- **Voice Ideation Sessions (VIS)** — session kind `voice-ideation` with facilitation preamble, no-repo-edit bias, force KP MCP on ACP when configured; close via **End VIS** / `/vis-close` / spoken “close session”; host parses JSON fence and writes KP via `kp create`/`capture` with `source: voice-ideation`.
- Settings: `codeBuild.voice.*`; docs: [docs/VOICE.md](docs/VOICE.md).

## Unreleased

### Dual-write session identity (final slice)

- **CROSS-LINK join contract** — `docs/CROSS-LINK.md` freezes CB↔native keys (`meta.id`, `backendSessionId`, `backendSessionHistory`, `native`), N:1 mapping, external-open rule, and the native format map for CSV/analytics consumers.
- **Exporter summary fields** — `exportToClaudeJsonl` includes `backendSessionId` + `native` on the summary line only when set (additive; absent metas stay byte-identical, no null spam). (kp: ideas/cb-dual-write-backendsessionid-shared-grok-cb-se)

### Pre-send token estimate chip

- Composer shows a rough outbound token estimate next to Send (`~12k tok · ~8% window`) while you type. Heuristic is chars÷4 (no tokenizer API call); debounced 200ms. Window % uses a small hardcoded model-family table when the selected model is known. Does not block send; estimate failure hides the chip. (kp: ideas/cb-pre-send-prompt-context-token-estimate-chip-r)

### Path guard (ACP fs bridge)

- **Realpath-based workspace confinement** for non-bypass `fs/*` reads/writes: `createPathGuard(root)` caches a realpathed root; `confine` rejects `../`, absolute outside paths, in-root symlinks that point out, broken symlinks, null bytes, and intermediate-is-file paths via `PathEscapeError` (`PATH_ESCAPE`).
- First unit suite in `test/unit/pathGuard.test.ts`. Bypass mode still skips the guard unchanged.

### MCP defaults opt-out

- **Explicit `codeBuild.mcpServers: []`** now means *no servers* (stops unconditional chrome-devtools + playwright npx spawns). Previously empty was treated as “use defaults,” and there was no supported opt-out.
- **Unset** (no user/workspace override) still injects the personal-browser default stack.
- New **`codeBuild.disableDefaultMcpServers`** boolean for a discoverable off switch; explicit `mcpServers` entries still pass through when set.
- Resolution uses `Configuration.inspect` so package.json’s default `[]` is not confused with a user opt-out.

## 0.10.4 — 2026-07-17

### Lossless history restore: replay through the live reducer

- **Root cause:** reopened sessions looked broken — `replayRecordsToItems` was a second, impoverished reimplementation of the live `applyUpdate` reducer that silently dropped `agent_thought_chunk` (all thinking gone), `tool_call_update` (tool cards stuck at *pending* with no result/diff), TodoWrite task lists, AskUserQuestion cards, and the end-of-turn files-changed summary. The data was on disk all along; only the restore path was crippled.
- **Fix:** `historyLoaded` now folds persisted records through the same `applyUpdate` reducer as the live stream, plus a webview-side mirror of the host's AskUserQuestion/TodoWrite interception (their structured cards are never persisted — they're rebuilt from the `tool_call` records). Reopened and imported (Claude/Grok) sessions restore completed tool cards with results/diffs, thinking blocks, task lists, and per-turn files-changed summaries. Replay never resurrects permission modals; restored AskUserQuestion cards render inert (answered), not as live pickers on a dead agent.
- **Tests:** first webview reducer suite (`test/unit/webviewStore.test.ts`, 14 tests) — chunk merge, `tool_call_update` matching, turn-boundary file aggregation, TodoWrite snapshot-replace, and live/replay parity.

## 0.10.3 — 2026-07-16

### Composer: Option+Enter for newline (Claude-like)

- **Option+Enter** (Alt+Enter) inserts a newline in the chat composer, matching Claude Code muscle memory. **Shift+Enter** still inserts a newline; plain **Enter** sends.

## 0.10.2 — 2026-07-16

### Fix: Grok session restore / ACP `Invalid params`

- **Root cause:** 0.10.1 injected browser MCP servers on ACP `session/new` without the required `env: []` field. Grok's agent-client-protocol untagged `McpServer` enum rejected the params (`Invalid params`), so every Grok start — including history restore — failed at handshake.
- **Fix:** always serialize `env` as an array on MCP server objects.
- **Grok native resume:** when the agent advertises `loadSession` and the host has a `resumeId`, call ACP `session/load` instead of `session/new`. `supportsResume: true` for the grok backend; external `[GR]` rows pass the session UUID as resume id.

## 0.10.1 — 2026-07-15

### Personal browser MCP for Grok / ACP

- ACP `session/new` no longer passes empty `mcpServers: []`. Empty `codeBuild.mcpServers` injects the **default personal-browser stack**: `chrome-devtools` (`--autoConnect`) + `playwright`, so Grok can drive the live Chrome profile (`zhirafovod@gmail.com` via CDP).
- New setting `codeBuild.mcpServers` to override the list.
- `@browser` / `browser://current` expands to an explicit personal-profile instruction (Claude path).
- Project `.grok/config.toml` registers the same MCP servers for native Grok TUI.

Companion docs/scripts live in `~/docs` (`deploy-grok-browser-stack.sh`, `browser-personal` skill).

## 0.10.0 — 2026-07-15

### Session performance debug + streaming hot-path fixes

Addresses “Claude in Code Build feels slower than native Claude Code” by (1) measuring host vs webview vs model latency and (2) removing the worst synchronous costs on every stream chunk.

**Observability (P0/P2)**

- Setting `codeBuild.perfDebug`: `off` | `hud` (default) | `full`.
- Header **perf HUD**: TTFT · host tax · events/s · paint lag · phase — click opens the panel.
- **`/perf`** slash command + commands: Toggle Session Performance Panel, Copy Flight Report, Export Performance JSON, Show Flight Recorder Output.
- **Activity strip** under the header while busy (think / text / tool segments).
- **Session Performance panel**: waterfall, event inspector, dual-store sizes (`~/.codebuild` + Claude native jsonl), copyable flight report + decision tree.
- Output channel **Code Build: Flight Recorder** (always on copy/export; auto-append after each turn when `full`).
- Export writes `~/.codebuild/sessions/<id>.perf.json` next to the transcript.

**Hot-path fixes (P1)**

- Session store: **batched async appends** (~50ms coalesce) instead of `appendFileSync` per event; readers flush first so load/list stay consistent.
- Host→webview: **24ms IPC coalesce** via `sessionUpdates` batch message (immediate flush on result/error/permission).
- Streaming markdown: throttle marked+DOMPurify to ~100ms while the last assistant bubble is streaming.
- Auto-scroll uses `behavior: 'auto'` while busy (smooth only when idle).
- Message `Item` is `React.memo`’d so unchanged bubbles skip re-render.

## 0.9.9 — 2026-07-13

- Activate on `onCommand:codeBuild.newConversation` (+ open-in-tab/window) so external callers (e.g. the Code Sessions planning dashboard "Run in Code Build") reliably launch a chat even when Code Build hasn't been opened yet this session.

## 0.9.8 — 2026-07-12

- Global keybinding `⌘⌃⇧C` (win/linux `ctrl+alt+shift+c`) → **New Conversation** — start a Code Build chat from anywhere, not just inside the chat webview (`⌘N` there still works).

## 0.9.7 — 2026-07-11

### Dynamic model discovery for every backend (Claude picker now shows the real models)

The model picker was hardcoded per backend: Claude was a fixed alias list `['default','opus','sonnet','haiku']`, so a distinctly-named model you actually run — e.g. `claude-fable-5` — could never appear, while Grok already discovered its models from `~/.grok/models_cache.json`. Reported: "on my home laptops the model list does not show fable for claude, but shows the proper one for grok."

- **`discoverModels()` now runs per backend and is additive.** Whatever a backend discovers on THIS machine is merged with its curated aliases and de-duplicated; a discovery miss is never worse than the old static list. `default` always leads.
- **Claude discovery** (new `readClaudeModels()`): the `claude` CLI has no `models` subcommand or cache, so we combine (1) the configured model in `~/.claude/settings.json` (stripping the `[1m]` context tag) and (2) distinct model ids seen in recent `~/.claude/projects/**/*.jsonl` session transcripts. That's why `claude-fable-5` now shows up where it's configured/used. It composes with 0.9.6's `claudeFamilyAlias`: family models (opus/sonnet/haiku) still collapse to portable aliases for Bedrock-safe resume, while a family-less id like `claude-fable-5` passes through as its real id.
- **Codex discovery** (new `readCodexModels()`): surfaces ids hinted in `~/.codex/config.toml` (e.g. `gpt-5.5`) on top of the curated list.
- **Restore fix:** session restore validated a remembered model against the *static* `BACKENDS[id].models`, which would silently drop a discovered selection on the next session. New exported `modelsFor(id)` returns the same list the picker shows; `sessionManager` now validates against it.
- No webview change — the `<select>` already renders whatever the backend reports. 5 new unit tests.

Pre-1.0 PATCH (`0.9.6 → 0.9.7`) — additive discovery, no protocol/settings change.

## 0.9.6 — 2026-06-29

### Bedrock-safe model on every turn (fixes mid-session "invalid model identifier")

- **Fix:** the model alias is now applied at the spawn choke point (`buildArgs`), so
  **every** claude turn — including `--resume` continuations (2nd input onward) — passes a
  portable family alias (`opus`/`sonnet`/`haiku`), never a version-pinned id. On
  Bedrock/enterprise installs a pinned id (e.g. `claude-opus-4-8`) can reach the backend
  untranslated on resume and be rejected with *"The provided model identifier is invalid"*,
  even when the same id worked on the first (fresh) turn where `modelOverrides` translate it.
  Opaque inference-profile ARNs pass through unchanged. (Supersedes 0.9.5's resume-only fix.)

## 0.9.5 — 2026-06-29

### Resume across differently-provisioned Claude installs

- **Fix:** resuming a session no longer passes the transcript's version-pinned model id
  (e.g. `claude-opus-4-8`) to `claude --model`. On a differently-provisioned install —
  Bedrock that only serves Opus 4.1, an older account — that id is rejected with
  *"The provided model identifier is invalid"*. The resume path now collapses the model
  to its family **alias** (`opus`/`sonnet`/`haiku`), which the CLI resolves to whatever
  that environment actually provides (`claudeFamilyAlias`); an unrecognizable id (opaque
  inference-profile ARN) falls back to the environment default.

## 0.9.4 — 2026-06-24

### Fix: external/native Claude session titles also stripped of wrapper tags

0.9.3 cleaned titles derived from the composer, but sessions opened/continued from
the history picker still showed `<command-message>load</command-message>…` — those
titles come from `externalSources` reading the Claude transcript's first user
message. Now run through `cleanCommandText` at the source.

## 0.9.3 — 2026-06-24

### Fix: session titles no longer show raw slash-command wrapper tags

Sessions started with a slash command titled as `<command-message>load</command-message>…`.
`deriveTitle` now runs the first prompt through `cleanCommandText` (shared util): a
`/command` becomes a readable `/load <args>`, and harness wrapper blocks
(`<command-message>`, `<system-reminder>`, …) are stripped from plain prompts.

## 0.9.2 — 2026-06-24

### Composer / webview UI refinements

Reapplied in-progress webview UI work on top of 0.9.1 — composer layout and input
handling (`Composer.tsx`), `App.tsx` wiring, `webviewHtml.ts`, and styles — plus
`docs/` (DATA-STORES, parity-gaps) and `.vscodeignore` updates. No host/protocol changes.

## 0.8.0 — 2026-06-19

### Fix: stuck "working…" turns now warn + auto-recover; Stop actually stops

CB could sit on the "working…" spinner forever when the underlying claude CLI stalled mid-turn — no output, no tokens, and Stop appeared to do nothing. Root cause (from field transcripts in `~/.codebuild/sessions` + `~/.claude/projects`): an intermittent claude 2.1.x `result subtype=error_during_execution` that produces **zero** assistant output and burns **zero** tokens, against a CB that had no mid-turn liveness check and a cancel that couldn't kill a wedged process. New sessions hit the same stall, so it looked like the whole agent was dead (and Code Sessions showed no progress, since nothing was written).

- **Stall watchdog (D1).** Each turn is now watched for total silence. At `codeBuild.stallWarnSeconds` (default 45) CB posts a "may be stuck" notice explaining the options (Stop now / keep waiting). At `codeBuild.stallAutoCancelSeconds` (default 120) it auto-stops the turn so the UI never stays frozen. The silence clock resets on real agent progress (assistant/thought chunks, tool calls, usage) and is **suppressed while a tool/command is running** — a long build or test suite is silent by design and is never auto-killed (you Stop those yourself). New `src/host/turnWatchdog.ts` (pure, 8 unit tests).
- **Hardened cancel (D2).** `StreamJsonTransport.cancel()` now escalates: SIGINT first (graceful interrupt, preserves the session for `--resume`), then SIGKILL after a 2.5s grace if the process ignores it. The `exit` handler emits a synthetic `result`, so the webview always leaves "working…" even when the process was wedged. The watchdog's auto-stop also force-clears `busy` independently of the transport.
- **`system_init` spam fix (D3).** The claude normalizer emitted a `system_init` for **every** `system` line (claude re-emits them throughout a turn) — measured 258–1109 bogus events per session, each triggering a synchronous `appendFileSync` and, critically, masking stalls by looking like fresh progress. Now deduped to one emission per backend session id (the host still gets the first one to persist the `--resume` id). Fixes a pre-existing failing test and adds dedup coverage.
- New settings: `codeBuild.stallWarnSeconds`, `codeBuild.stallAutoCancelSeconds` (set warn to 0 to disable; set auto-cancel ≤ warn for warn-only).
- Note: the watchdog is transport-agnostic, so the UI-recovery guarantee covers all backends; the SIGINT→SIGKILL hardening is currently claude-only (grok ACP already has `session/cancel`; codex remains SIGINT-only — follow-up).

Pre-1.0 MINOR (`0.7.0 → 0.8.0`) — new user-facing recovery behavior + two new settings. No protocol break.

## 0.7.0 — 2026-06-19

### Bypass permission mode is now the default

New conversations start in **bypass** mode — the agent runs autonomously with no per-action approval prompts (the Claude Code `--dangerously-skip-permissions` / terminal "YOLO" workflow). The previous default was `default` (approve every action) with bypass gated off.

- `codeBuild.initialPermissionMode` default: `default` → **`bypass`**.
- `codeBuild.allowDangerouslySkipPermissions` default: `false` → **`true`**. Both had to flip together — `initialPermissionMode = bypass` is silently downgraded to `default` at session start unless the capability gate is open (`sessionManager.rememberedConfig`: `if (mode === 'bypass' && !this.allowBypass) mode = 'default'`).
- In bypass mode the user's `$HOME` is trusted by default (existing `trustedDirs()` behavior), so the agent isn't locked to the workspace folder. Narrow this with `codeBuild.additionalTrustedDirs`.
- **Security note:** with bypass on, the agent reads/writes files and runs commands without asking. To restore approval-based behavior, set `codeBuild.allowDangerouslySkipPermissions` to `false` (disables bypass entirely) or choose `default` / `plan` / `acceptEdits` in the header. Per-session choices stay sticky via `globalState.lastMode`, so an existing install keeps whatever mode it last used — the new default applies to fresh state.
- Locked by `test/unit/permissionDefaults.test.ts` (shipped defaults + buildArgs honoring bypass only when the gate is open, and refusing the dangerous flag when it isn't).

Pre-1.0 MINOR (`0.6.0 → 0.7.0`) — user-facing default behavior change, no protocol break.

## 0.6.0 — 2026-06-17

### Better file context: drag-and-drop, caret-aware @-search, folder search

Three improvements to how files get into the agent's context, plus two fixes to unblock the build.

- **Drag-and-drop from the Explorer → `@`-mention.** Dropping files on the chat inserts `@relpath` at the cursor; dropped images attach as tiles (like paste). The webview parses `text/uri-list`; the new host `resolveDroppedUris` maps URIs to workspace-relative paths (rejecting anything outside the workspace) and base64-encodes images.
- **Caret-aware `@`-trigger.** The suggestion menu now fires for an `@`-token at the cursor, not only when it sits at the very end of the input — editing mid-text triggers search again (the old end-anchored `/@(\S*)$/` silently did nothing). A bare `@` now lists recently-used (open) files instead of nothing.
- **Folder-aware search.** `@classic/` lists every file under a `classic/` folder; `@classic/agent` narrows by name within it. Results rank open editor tabs first as a recency proxy, then path-prefix, substring, basename. New pure helpers `buildSuggestGlob` + `rankFileSuggestions` (`src/host/fileSuggest.ts`) and `findActiveMention` + `parseUriList` (`webview-ui/src/util/mentions.ts`), covered by 23 unit tests.
- **Fix:** removed a stray duplicate `import { useState }` in `MessageList.tsx` that broke `tsc`.

Pre-1.0 MINOR (`0.5.0 → 0.6.0`) — new user-facing capability (drag-and-drop + folder search). No protocol break.

## 0.5.0 — 2026-06-13

### Active question banner

A sticky one-line banner pinned under the chat header showing the user's CURRENT (or most recent) prompt. Matches Claude Code's pattern — keeps the user's question visible while a long agent reply scrolls past it. Hover the question text for the full prompt + the absolute timestamp.

- Renders with two states: `⏳ active` while the agent is busy responding (subtle blue tint borrowed from `--vscode-focusBorder`), `↩︎ previous` once the turn is complete (neutral border).
- Inline relative-time chip next to the question text (same `formatRelative` helper as the per-bubble `TimeChip`).
- Per-session × dismiss button on the right; reappears on the next reload.
- New `codeBuild.showActiveQuestionBanner` setting (default `true`) for permanent off-switch.
- Plumbed through `HydrateState.showActiveQuestionBanner`, the webview store's `showActiveQuestionBanner` field, and a new `ActiveQuestionBanner.tsx` component rendered in `App.tsx` between the Header and PrimerBanner.
- Cap on visible text: first non-empty line, 240 chars; full text in the hover tooltip.

Per AGENTS.md: 0.4.1 → 0.5.0 (MINOR — new user-facing surface + new setting).

## 0.4.1 — 2026-06-13

### Fix: "+ New conversation" + external-session opens no longer split the editor

Same root cause as code-sessions 1.2.1: `vscode.ViewColumn.Active` is unreliable when commands fire from a sidebar tree (active text editor is undefined → VS Code falls through to "create new split column"). Reported in notes.md as "very annoying."

Fix: new `preferredEditorColumn()` helper in `src/host/panel.ts` (exported) queries `vscode.window.tabGroups.activeTabGroup` first (always-defined focused editor group), then falls back to the active editor's column, then `ViewColumn.One`. Applied to all four panel-creation sites: `ChatPanel.create` default, `codeBuild.openInNewTab`, `codeBuild.openInNewWindow`, `codeBuild.openExternalSession`, `openPreviousSession`.

Result: the `+ New conversation` icon in the header, "Resume session" / "Open in Code Build" cross-extension actions, and the "Open in new tab/window" commands all reuse the existing editor area instead of stacking a new column next to it.

## 0.4.0 — 2026-06-13

### Memory chip in the header

Companion to Code Sessions 1.2.0's new Memory tab. CB now surfaces
"how many memories the agent has access to" right in the chat header.

- New `🧠 N` chip between the header spacer and the cost/usage chip. Hover tooltip carries the per-provider breakdown (`claude: 12, codex: 3, …`) and a pointer to the Code Sessions Memory tab for the full inventory.
- Counts are computed at every `hydrate` via a CB-side `memoryScan.ts` that scans CLAUDE.md / CLAUDE.local.md / AGENTS.md / MEMORY.md / `.claude/CLAUDE.md` / `.claude/rules/*` / `.claude/commands/*` at the workspace root plus `~/.claude/{CLAUDE.md,MEMORY.md}` / `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` / `~/.codex/{AGENTS.md,memories/}` / `~/.grok/AGENTS.md` at the user scope. Entry count = H2 headers (markdown) or file count (codex memories dir). Fenced-code-aware.
- `HydrateState` extended with `memoryEntries: number`, `memoryFiles: number`, `memoryByProvider: Record<string, number>`. Backwards-compatible — webview state defaults to zeros when the host didn't populate them.
- Per-session "how many memories WERE used in this conversation" attribution is NOT in this release — that needs the memory-map work in `@unpolarize/agent-memory-core` to land first. v0.4.0 ships the inventory + global counter.

Per AGENTS.md: 0.3.0 → 0.4.0 (MINOR — new user-facing surface).

## 0.3.0 — 2026-06-13

### Per-turn classification chips (§3 from cb-cs-feature-spec.md)

- After each end-of-turn (`result` event), CB now optionally runs a one-shot classifier call against the **active backend** to label the just-finished turn with 1–3 topic chips. The chips render next to the user bubble's role line. Implements notes.md "CB skills to classify all turns of the conversations using current coder model/agent".
- Off by default. Opt in with `codeBuild.classifyTurns: true`. Model picker: `codeBuild.classifyModel` (default `haiku` for cost-cheapest tier on claude).
- Only claude backend is wired in v1 (`claude -p --output-format json` one-shot). Grok one-shot mode pending — labels just don't appear for grok turns until that lands.
- New `src/host/classifier.ts` (~90 LOC) — spawn + parse + 20s timeout, errors swallowed silently (classification is decorative).
- Protocol gains `turnLabels { turnIndex, labels[] }` host→webview message. Indexed by 0-based user-prompt count so out-of-order arrivals still map correctly.
- Reducer decorates the user ChatItem with `labels?: string[]`; renders a chip strip with hover tooltip carrying "Classifier label: <name>".
- Resets cleanly on `/new` and on session switch (per-session turn counter).

## 0.2.1 — 2026-06-13

### Better "Files modified" card per turn

- The card now exposes a per-file **"diff" button** that launches VS Code's side-by-side diff view (via the existing `EditorTools.openDiff` host bridge). Shown only when the tool emitted a diff content block (we have both before + after blobs); rawInput-only fallbacks hide the button.
- The file path stays clickable for reveal-in-editor; the diff button is a sibling control with its own hover treatment, so the two affordances don't collide.
- Diff blobs are capped at 10 KB each so a 5-MB-file edit doesn't bloat the transcript; the host-side diff view still works for larger files.
- New CSS rules: `.files-item` flex row, `.files-path` cursor + truncation, `.files-diff-btn` ghost button.
- Per-turn aggregation now KEEPS the earliest `oldText` and LATEST `newText` when multiple tool calls touch the same file in one turn — so the diff button shows the FULL delta for that turn, not the latest micro-edit.

## 0.2.0 — 2026-06-13

Features driven from the notes.md "next session (CB & CS)" punchlist.

### Per-message timestamps

- Every chat bubble (user / assistant / thought / tool / files / plan / error / notice / askUser / tasks / context) now renders a small relative-time chip next to the role label: `just now` → `15s ago` → `7m ago` → `at 14:32` → `2026-06-13 14:32`. The chip auto-updates every 30s while the panel is open.
- Hover the chip for the absolute ISO 8601 timestamp(s). Streaming assistant / thought chunks AND TodoWrite snapshot rewrites preserve the FIRST `createdAt` and surface the latest `updatedAt` in the hover tooltip, so the bubble reads "when did this *start*" with "last touched at X" available on demand.
- New helpers in `webview-ui/src/util/time.ts`: `formatRelative`, `formatIso`, `formatHover`.
- `ChatItem` union extended with `createdAt: number` (required) + `updatedAt?: number` (optional, set on chunk merges + tasks snapshots).

### Per-backend session memory across switches

- Switching backends (claude ↔ grok) used to create a fresh session on every flip — flip claude → grok → claude and you'd end up in a brand-new claude session, the previous thread effectively orphaned in the history picker.
- New `previousSessionByBackend: Map<BackendId, string>` in `SessionManager` remembers the session id for each backend used in this chat panel. On switch-back to a backend that has a remembered session, `loadExistingSession` is invoked instead of `openSession` — the original thread is restored with full transcript + native `--resume` on backends that support it (claude). The primer banner is skipped entirely; the user is rejoining their own thread, not handing off across agents.
- A soft amber notice announces the restore so the user knows what happened: *"Restoring your earlier Claude Code thread (`xxxxxxxx`) — no carry-over needed, the agent already has its own context."*
- Cleared on `/new` (fresh slate intent). A second flip-back after the first restore intentionally creates a fresh session — the user can pull the old one from the history picker if they need it.

### Spec coordination

- `knowledge/tech/projects/code-build/cb-cs-feature-spec.md` in the docs workspace documents the remaining four feature requests (memory maps, turn classification, files-changed polish, switch-without-loss, timestamps) with status + sequencing. Items #1 (browser personal profile) and #6/#7 (this release) are done; #4 (files-changed polish) and #3 (turn classifier) follow.

## 0.1.0 — 2026-06-13

First Marketplace-targeted build. Bundles the cross-backend handoff
overhaul, resume-context machinery, transparency layer, and a batch
of silent-error fixes accumulated since 0.0.2.

### Cross-backend handoff (Claude ↔ Grok)

- New card-based primer picker (Full / Summary + last N turns / Start fresh) with an inline N input.
- LLM-summarisation pipeline: one-shot `claude -p --output-format json` fork on the prior transcript, then last N user/assistant turns appended verbatim plus a framing instruction. Grok-source falls back to a clipped mechanical summary.
- Async `applyPrimerDecision` with progress notices and queued-prompt hold — switchBackend latches the handoff state synchronously before `await openSession` so a fast-typing user can't slip a context-less prompt through during the new-agent spawn.
- External-replay records merge in `switchBackend` so externally-imported sessions (opened via "Open in Code Build") get the banner too.

### Resume context

- Claude `system_init` event carries the native session id; persisted on `SessionMeta.backendSessionId`. `loadExistingSession` now passes it as `--resume <native-id>` so claude reads its own jsonl back into context.
- Self-resume primer for backends without native `--resume` (today: grok ACP). New `serializeSelfResumePrimer` injects the last 10 turns verbatim + framing as a one-shot primer on the first prompt.
- `StreamJsonTransport` auto-retries WITHOUT `--resume` on non-zero exit when `--resume` was the suspect; latch prevents loops.

### UI transparency

- New collapsible "context injected" audit card surfaced above the user bubble on backend-switch handoffs. Sections: carry-over primer, resolved `@`-mention paths, raw user text, image attachments, tool_result payloads.
- Card is scoped to handoffs only — regular prompts no longer get an audit card.

### Anti-foot-gun fixes

- FULL primer cap lowered from 48K → 16K chars. Picker now defaults to Summary; Full is a ghost "(risky)" button.
- Claude stream-json `result.is_error` is surfaced as a chat error (previously "prompt is too long" silently flipped `busy` off with no bubble).
- Clean process exit emits a synthetic terminal `result` so a silent exit doesn't strand the "working…" pill.
- `ClaudeNormalizer.shapeContentBlock`: converts `resource_link` (@-mentions) to inline text and `image` to claude's `source` envelope. Anthropic Messages API rejects `resource_link` / non-standard image — was 400'ing mid-turn.
- AskUserQuestion answer goes back as a `tool_result` content block (not a text user message). Previously claude couldn't correlate the answer with the in-flight tool_use.
- AskUserQuestion card gains an "Other (enter your answer)" free-text escape hatch matching Claude Code's IDE renderer.
- Generic ToolCard suppressed for `AskUserQuestion` / `TodoWrite` / `todo_write` — dedicated cards already render them.
- Thinking: empty `block.thinking` chunks filtered at the normalizer + reducer; first-line preview shown in the collapsed `<details>` summary.

### Tool scope (bypass mode actually unlocks the filesystem now)

- New `codeBuild.additionalTrustedDirs: string[]` setting; in bypass-with-opt-in mode it defaults to `[$HOME]` so claude's tools mirror terminal-claude behaviour. Plumbed through `StartOpts` → `BACKENDS.claude.buildArgs` as `--add-dir <path>` flags.
- ACP transport's `fs/read_text_file` / `fs/write_text_file` skip `confineToRoot()` when `mode === 'bypass' && allowBypass` — grok ACP can now reach beyond the workspace too.

### Startup notices

- `postStartupNotice` tooltip carries the resolved spawn argv + cwd + resume id.
- `system_init` added to the cancel-nudge condition.
- 30s "still waiting" nudge skipped for fresh (no-resume) sessions where claude is sub-second-spawned and idle on stdin.
- Stale "still waiting" notice retroactively dismissable via new `dismissNotice` host→webview message — cancelled when the agent's first event arrives even if the timer already fired.

### Session persistence

- Webview `setState({lastSessionId})` on session change. `deserializeWebviewPanel` reads it and calls `mgr.queueResume(id)` so a panel reload picks up the same conversation.

### Backend wiring

- Grok backend arg ordering: options precede the `stdio` subcommand (`stdio` takes no flags; reverse made grok exit 2). Unit test added.
- ACP transport disposes pending RPC on process error / exit so a crashed handshake doesn't hang the user on "working…".

### Metadata

- Publisher metadata: author, homepage, icon, bugs URL.
- `media/icon.png` (128×128).

## 0.0.2 — pre-Marketplace iteration

Development build series. Persistent transcripts, multi-backend transports (claude stream-json, grok ACP, codex exec-json), permission UI, plan mode, slash commands, image attachments, file `@`-mentions, per-model usage breakdown, "Open in Code Sessions" cross-extension link. See git log for the granular history.
