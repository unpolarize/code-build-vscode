# AGENTS.md — Code Build

Instructions for AI coding agents (Claude Code, Grok, etc.) working in this repo.

## Version bumping — REQUIRED on every commit that ships code

**Every commit that touches any of `src/`, `webview-ui/`, `package.json`, or any other file that ends up in the published `.vsix` MUST bump the version in [`package.json`](package.json) and add a matching entry to [`CHANGELOG.md`](CHANGELOG.md). No exceptions — including bug fixes, refactors, build tweaks, and dependency bumps.** The VS Code Marketplace gates installs on the version field; without a bump, `code --install-extension` silently keeps the old build even though the `.vsix` is new, and the user thinks the fix didn't ship. Doc-only changes that aren't in the package (e.g. agent-internal notes outside `README.md` / `CHANGELOG.md` / `AGENTS.md`) may skip the bump — when in doubt, bump.

The bumping rules — `MAJOR.MINOR.PATCH` (SemVer):

| Change kind | Bump | Example |
|---|---|---|
| Bug fix, internal refactor, docs, README, hover tooltip wording | **PATCH** (`0.1.0 → 0.1.1`) | Stuck "working…" spinner fix; clarified notice text |
| New user-facing capability, new setting, new command, new chat surface, new backend transport | **MINOR** (`0.1.0 → 0.2.0`) | Backend-switch primer; AskUserQuestion free-text input; `codeBuild.additionalTrustedDirs` setting |
| Breaking change: removed setting, command id renamed, protocol incompatibility with previously-saved transcripts, switch of default-backend semantics | **MAJOR** (`0.1.0 → 1.0.0`) | Rebrand from `claude-build` to `code-build`; protocol v1 → v2 incompatible session-store schema |

Pre-1.0 (`0.x.x`) currently treats MINOR as breaking-allowed — until 1.0 you may break the protocol on a MINOR bump, but call it out explicitly in CHANGELOG and the commit body.

**Workflow each commit:**

1. Update `"version"` in [`package.json`](package.json).
2. Prepend a `## X.Y.Z — YYYY-MM-DD` section to [`CHANGELOG.md`](CHANGELOG.md) summarising the change in 1–6 bullets.
3. Run the build:

   ```bash
   npm run build && npx tsc --noEmit
   ```

4. Stage `package.json`, `CHANGELOG.md`, and the code changes in the same commit.
5. **Ship (required after a landed feature):** build, package, and install so the user can try it without extra `npm run build` / vsce steps:

   ```bash
   npm run ship
   ```

   That is `build` + `vsce package` + `code --install-extension code-build-vscode-$version.vsix --force`.
   **Do not reload the working Code Build chat.** Verify in a **second VS Code window**. Host-trace: Output → **Code Build**; file `~/.sessions/.daemon/host-trace.ndjson` (see `../architecture/tools/observability.md`).

**Do not publish to the Marketplace from an agent session.** Publishing is a user-initiated step; the agent's job is to bump the version, update the changelog, and produce a clean .vsix.

## Repo conventions

- **No `Co-Authored-By` trailers** in commit messages.
- **Don't commit unless asked** — staging is fine; commit only on a "save" command from the user.
- **Commit style** matches the existing log: `code-build: <short summary>` or `notes: …` / `docs: …` for non-code changes.
- **Always push** after committing (part of the "save" flow).
- TypeScript strict mode is on. Run `npx tsc --noEmit` before any commit that touches `.ts` / `.tsx`.
- The webview build (`webview-ui/`) and host build (`src/`) are separate. `npm run build` runs both via `esbuild.js` for the host and `vite build` for the webview.

## Architecture cheat-sheet

- **Webview** (`webview-ui/`): React + Vite. Renders the chat surface. Communicates with the host via typed `postMessage` (see [`src/shared/protocol.ts`](src/shared/protocol.ts) for the `WebviewToHost` / `HostToWebview` unions).
- **Host** (`src/`): VS Code extension. `SessionManager` owns one panel + one `AgentSession`; the transport (`StreamJsonTransport` for claude stream-json, `AcpTransport` for grok/ACP, `CodexTransport` for codex exec-json) normalises every backend into ACP-shaped `SessionUpdate` events.
- **Session store** (`~/.codebuild/`): local NDJSON transcripts plus an index for the history picker. Externally-imported sessions (claude `~/.claude/projects/`, grok `~/.grok/sessions/`) are replayed via the `externalReplay` loaders. **Slated to move** into the sessions daemon / `~/.sessions` (see suite architecture below); do not add new readers of `~/.codebuild`.

## Suite architecture (private repo — read before cross-component work)

The suite-level design (CS · CSV · CB · KP), the target architecture, the performance tracking
table, the testing strategy and the cross-project issues table live in the **private**
`unpolarize/architecture` repo, cloned next to this one at `../architecture` (symlink:
[`docs/suite-architecture`](docs/suite-architecture)). It is private by design — link to it by
path, never copy its content into this public repo.

- Before any change touching the store, protocol, daemon, or CSV/KP contracts: read `tools/target.md` and follow `WORKFLOW.md` there.
- Bugs: claim your row in `tools/issues.md` before starting; perf work: claim the row in `tools/performance.md` and record before → after numbers.
- This file covers only CB-internal conventions; `docs/DATA-STORES.md` documents the *current* on-disk format.

## Publishing checklist (user-driven)

When the user is ready to publish a new version to the VS Code Marketplace:

1. Confirm `package.json` `version` matches the latest entry in `CHANGELOG.md`.
2. Confirm `README.md` reflects the current feature surface (top-of-file blurb + screenshots if changed substantially).
3. Run a clean package:

   ```bash
   rm -f code-build-vscode-*.vsix
   npx vsce package --allow-missing-repository --no-dependencies
   ```

4. The user uploads the resulting `.vsix` via the Marketplace publisher page (`https://marketplace.visualstudio.com/manage/publishers/zhirafovod`). Agents do not perform this step.
5. After upload, the user verifies the listing reflects the new version + screenshots, then tells the agent to tag the release in git (optional).
