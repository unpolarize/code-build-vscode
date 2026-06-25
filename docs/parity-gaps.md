# Parity gaps — code-build vs claude-code-vscode + grok-build-vscode

Snapshot taken 2026-05-30 against `anthropic.claude-code` 1.x and
`pawelhuryn.grok-vscode-phuryn` 1.2.x. Items already in code-build are
not listed.

## Implemented in this commit

| Gap | Notes |
|---|---|
| Model picker per backend | Header dropdown driven by `BackendSpec.models`. Claude: opus/sonnet/haiku 4.x ids. Grok: grok-build / grok-4.20 / grok-4.3. Codex: gpt-5 / gpt-5-mini / o3 / o3-mini. New setting `codeBuild.defaultModel`. |
| Effort / thinking-budget picker | Claude `--effort`, Codex `--reasoning-effort`. Hidden for grok (not honored). New setting `codeBuild.defaultEffort`. Five steps + `default`. |
| Per-turn files-changed list (robust) | `collectModifiedFiles` now extracts paths from tool-name + rawInput for Edit/Write/MultiEdit/NotebookEdit (claude) and search_replace/write/str_replace_editor/edit_file/apply_patch (grok/codex). Previously only diff content blocks counted, so most edit tools produced no entry. |
| Imported-session model pre-fill | When opening a claude session via "Open in Code Build", the dominant model (highest output-token volume) is read from the transcript and pre-selected in the picker. |
| Drag-drop files into composer | App-level `onDrop` (`webview-ui/src/App.tsx`) intercepts `text/uri-list` / `application/vnd.code.uri-list` / `resourceurls` / raw `Files` from Explorer + OS drags. Drop anywhere in the chat panel (not just the composer strip) → `@path` mention; image files attach as tiles via the `cb-app-drop-files` CustomEvent. Required `preventDefault()` in the dragover handler to stop VS Code's workbench-level "open file / open folder" fallback. |
| Reasoning trace expand-on-click | Thinking renders as a `<details>` element with the first line of thought as the summary preview; click expands the full trace. Per-message timestamp chip + auto-refresh. Empty thoughts filtered. |
| Active question banner | Sticky banner pinned under the header with the current/previous prompt — matches Claude Code's "scroll past but still see what you asked" pattern. Toggle: `codeBuild.showActiveQuestionBanner`. |

## Confirmed gaps — high value, not done yet

| Gap | Why it matters | Sketch |
|---|---|---|
| Context-window meter | The most user-visible spend lever for long sessions ("how full is my context?"). Claude shows pct; grok writes `contextWindowUsage` to signals.json. | Pull from the `usage` event for claude (input_tokens) or the `usage_breakdown` stream; render as a thin bar in the header next to the cost figure. |
| Compact / clear-context action | Claude has `/compact`; users will want a one-click equivalent here. | Built-in `/compact` slash command that posts a synthetic prompt; SessionManager spawns a fresh process at the same id with the previous transcript summarised. |
| Subagent indicator | claude-code panel highlights when a Task subagent is running. Code-build today shows the tool call but doesn't distinguish "the agent spawned a sub-task". | `tool_call_update.title == 'Task'` → render with a different icon + collapse the inner trace. |
| Branch / cwd badge | Each backend's behaviour depends on the workspace folder + git branch. claude-code shows the cwd in the header; grok-build-vscode shows the branch on session card. | Show `cwd basename · branch` in the header (run `git rev-parse --abbrev-ref HEAD` in cwd at hydrate). |
| Session rename | Right-click row in history dropdown → rename. claude-code and grok-build both have it. | Add `renameSession(id, title)` to SessionStore; right-click handler on `.history-item`. |
| Export / share transcript | Both upstreams have it. | Existing `jsonlExporter.ts` already produces a per-session JSONL — wire a "Copy as Markdown" / "Save as…" command on the history menu. |
| Stop-and-correct mid-stream | Claude has a "Stop" button that the user can interrupt + send a new prompt. Code-build's Stop only cancels; doesn't queue. | Composer "Stop and edit" variant: cancel + clear input only after partial response is rendered. |

## Confirmed gaps — lower value / not pursued

| Gap | Reason to skip |
|---|---|
| Voice input | Both upstreams ship it but it's a small audience and adds platform-permission complexity. |
| Walkthrough / onboarding pages | claude-code's walkthrough is mostly auth setup; code-build defers to the backend CLI for auth. |
| Inline diff preview in tool card | Already present (`type: 'diff'` content block); just under-utilised by current normalisers. Tracked as "improve normalisers" rather than a gap. |
| Plan-mode review UI | grok-build has a Plan / Approve UI; permission-prompt already covers it for the canonical case. |
| YOLO toggle button | Bypass-permissions mode is in the picker; calling it YOLO is cosmetic. |

## Notes on backends

- **Grok ACP model swap.** The grok ACP daemon (`grok agent stdio`) reads
  the model from xAI's session config, not a CLI flag. Setting our model
  picker writes the choice to `meta.model` but only takes effect on next
  process spawn. Documented in the picker's tooltip.
- **Codex `--reasoning-effort`.** Only the o-series models accept it;
  passing it to gpt-4o-class models errors. The picker doesn't currently
  cross-validate model × effort — would be a small enhancement.
- **Claude `--effort` vs `--thinking-budget`.** The flag was renamed in
  claude-code 1.x. We pass `--effort`; older claude-code installs will
  emit `Unknown flag` and the session will fail. If the install base
  spans both versions, this needs feature-detection.
