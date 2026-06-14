# Changelog

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
