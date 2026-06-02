# Code Build

A generalized, Claude-Code-style coding-agent UI for VS Code that drives **multiple
agentic CLIs** behind one streaming chat — opened as an **editor tab**, a **new window**,
or a **sidebar** view.

One UI, many agents: **Claude Code**, **Grok**, **Codex**, and any **ACP** agent
(opencode, Cline). Every backend is normalized into a single ACP-shaped event model
(Approach A), so the UI is backend-agnostic.

## Why

- **Looks/feels like Claude Code for VS Code** — streaming text, tool-call cards, inline
  diffs, permission prompts, plan mode, slash commands.
- **Backend-agnostic** — pick Claude, Grok, Codex, or any ACP CLI from the same chat.
- **Interops with [Code Sessions](https://github.com/unpolarize/code-sessions-vscode)**
  rather than replacing it: code-build *produces* sessions; Code Sessions *analyzes* them.

## Architecture (Approach A — ACP-canonical)

```
Webview (React + Vite)  ──typed postMessage──▶  Extension Host
  chat · tool cards · diffs                       SessionManager
  permissions · slash cmds                        AgentSession (ACP-shaped events)
                                                   ├─ StreamJsonTransport  (claude)
                                                   ├─ CodexTransport       (codex exec --json)
                                                   └─ AcpTransport         (grok/opencode/cline)
                                                  EditorTools · SessionStore · JSONL export
```

- **AcpTransport** — newline-delimited JSON-RPC 2.0 over the agent's stdio
  (`initialize` → `session/new` → `session/prompt` → `session/update`), bridging
  `fs/*` and `session/request_permission` back to the editor/UI.
- **StreamJsonTransport** — drives `claude -p --input-format stream-json
  --output-format stream-json`; a `ClaudeNormalizer` maps native NDJSON to
  `SessionUpdate`s.
- **CodexTransport** — spawn-per-prompt `codex exec --json`; captures `thread_id` for
  resume (`codex exec resume`).
- Normalizers convert every backend into the one `SessionUpdate` union the webview reads.

## Backend matrix

| Backend  | Transport     | Spawn                                                   |
|----------|---------------|---------------------------------------------------------|
| Claude   | stream-json   | `claude -p --input-format stream-json --output-format stream-json --verbose` |
| Grok     | ACP           | `grok agent stdio`                                      |
| Codex    | exec-json     | `codex exec --json --skip-git-repo-check -s <sandbox>`  |
| opencode | ACP           | `opencode acp`                                          |
| Cline    | ACP           | `cline --acp`                                           |

Spawn args are centralized in `src/host/backendRegistry.ts` so CLI flag drift lives in
one place.

## Requirements

- **Node.js ≥ 18** and **npm** (built with Node 24 / npm 11).
- **VS Code ≥ 1.90** with the `code` CLI on your PATH
  (in VS Code: *Cmd/Ctrl+Shift+P → "Shell Command: Install 'code' command in PATH"*).
- At least one backend CLI installed and logged in — you only need the ones you plan to
  use:
  - **Claude Code** — `claude` ([install](https://code.claude.com/docs))
  - **Grok** — `grok` (xAI Grok Build)
  - **Codex** — `codex` (OpenAI Codex CLI)
  - **opencode** / **Cline** — `opencode` / `cline` (any ACP agent)

  Code Build auto-detects which are present (via `which`) and disables the rest in the
  backend picker. Set explicit paths with the `codeBuild.binPaths` setting if a CLI isn't
  on PATH.

## Install

### Option A — build, package, and install a VSIX (recommended)

```bash
git clone https://github.com/unpolarize/code-build-vscode.git
cd code-build-vscode

npm install              # install dependencies
npm run build            # build the webview (vite) + host (esbuild) into dist/
npm run package          # produce code-build-vscode-0.0.1.vsix
npm run install-extension   # = code --install-extension <the .vsix> --force
```

Then reload VS Code (*Cmd/Ctrl+Shift+P → "Developer: Reload Window"*). You'll see a
**Code Build** icon in the Activity Bar.

> Prefer the GUI? After `npm run package`, open the Extensions view
> (*Cmd/Ctrl+Shift+X*) → *…* menu → **Install from VSIX…** → pick
> `code-build-vscode-0.0.1.vsix`.

To uninstall: `code --uninstall-extension zhirafovod.code-build-vscode`.

### Option B — run from source (Extension Development Host)

```bash
npm install
npm run build
```

Open the folder in VS Code and press **F5** (*Run → Start Debugging*). A second
"Extension Development Host" window launches with Code Build loaded — handy for
iterating, since `npm run watch:host` and `npm run watch:webview` rebuild on change.

## Usage

1. Click the **Code Build** icon in the Activity Bar for the sidebar chat, **or** run
   **Code Build: New Conversation** (`Cmd/Ctrl+N`) to open a chat as an editor tab.
2. Pick a backend (Claude / Grok / Codex / …) and a permission mode in the header.
3. Type a request and press **Enter**. Type `/` to see backend-provided slash commands (per-agent).
   Type `@` (or pick from suggestions) to reference a workspace file as context; `@browser` or
   `@web` for browser/web context hints. File references become `resource_link` blocks (or
   inlined content for Codex) and work across all backends.
4. **Title bar actions** (top-right of the editor tab, exactly like Claude Code): use the split-horizontal
   and multiple-windows icons (or the commands / keybindings) to open the chat in a new tab or new window.
5. **Conversation history**: Run **Code Build: Open Previous Conversation...** (Command Palette). It shows a
   filterable QuickPick of all prior sessions (grouped naturally by backend when you type the name). Selecting one
   opens it in a new tab with the full transcript rehydrated so you can review or continue. History is stored
   under `~/.codebuild/`.
6. **@-mentions now support full paths**: `@knowledge/tech/knowledge-base-architecture.md` (or any subpath) works
   for file context. `@browser` / `@web` injects a browser-context hint.

Sessions are persisted under `~/.codebuild/` and exported in a Coder-Sessions-readable
JSONL format.

## Develop

```bash
npm install
npm run build        # build:webview (vite) + build:host (esbuild)
npm run typecheck    # host + webview type-check
npm run test:unit    # node:test unit suite
npm run watch:host & npm run watch:webview   # rebuild on change (use with F5)
```

### Manual integration checks (need the real CLIs installed + logged in)

```bash
npx tsx test/manual/claudeRoundtrip.ts   # Claude stream-json round-trip
npx tsx test/manual/grokRoundtrip.ts     # Grok ACP round-trip (token streaming)
npx tsx test/manual/grokPermission.ts    # Grok file-write task
npx tsx test/manual/codexRoundtrip.ts    # Codex spawn-per-prompt (set CODEX_MODEL)
```

## Status

Built and validated through P0–P5 (scaffold → Claude → Grok/ACP → diffs &
permissions → Codex & persistence → sidebar & slash commands). Real round-trips
validated against `claude` and `grok`.

### Roadmap (remaining)
- Full new-window state restore (rehydrate transcript from `~/.codebuild` on the
  reload a window-move forces).
- Localhost `ide` MCP server exposing `EditorTools` to CLIs (Claude Code's pattern).
- Live permission-mode switching for stream-json backends (control protocol).
- MCP server config UI; modes/profiles; checkpoints/rewind.

## License

MIT
