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
- **Interops with [Coder Sessions](https://github.com/zhirafovod/coder-sessions-vscode)**
  rather than replacing it: code-build *produces* sessions; Coder Sessions *analyzes* them.

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

## Develop

```bash
npm install
npm run build        # build:webview (vite) + build:host (esbuild)
npm run typecheck
npm run test:unit    # node:test unit suite
```

Press F5 in VS Code to launch the Extension Development Host, then run
**Code Build: New Conversation** or open the **Code Build** sidebar.

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
