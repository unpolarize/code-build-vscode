# Design: Better file context in Code Build

**Date:** 2026-06-17
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** `code-build-vscode` (CB). Improve how files get into the agent's context via `@`-mentions and drag-and-drop.

## Problem

Three gaps in CB's file-context UX:

1. **No drag-and-drop.** Dragging a file from the VS Code Explorer onto the chat does nothing. It should insert an `@`-mention (or attach, for images).
2. **`@`-search sometimes doesn't trigger.** The Composer only detects an `@`-token when it sits at the very *end* of the textarea (`/@(\S*)$/`). Editing mid-text, or any trailing character, suppresses the suggestion menu.
3. **Folder-path search is broken.** Typing `@classic/` should list files under a `classic/` folder. Today the host globs `**/*classic/*` on the last (empty) path segment and the results are wrong.

## Goals / Non-goals

- **Goals:** reliable caret-aware `@`-trigger; folder-aware suggestions ranked with recency; drag-and-drop from Explorer inserting `@path` at the caret (images attach as tiles). Stay within VS Code workspace APIs; keep the existing cancellation-token throttle.
- **Non-goals:** fuzzy quick-open–style matching; cross-workspace/global file index; dragging text snippets or URLs; persisting an MRU database.

## Architecture overview

The data flow is unchanged in shape — webview ⇄ host over the existing `protocol.ts` message union:

- **Composer (`webview-ui/src/components/Composer.tsx`)** detects the `@`-token, renders the suggestion menu, and now also handles drop events.
- **`sessionManager.ts` (host)** owns all filesystem/workspace access: `getFileSuggestions()` and a new `resolveDroppedUris()` handler. The webview never touches the filesystem.

Two new protocol messages are added; everything else reuses existing plumbing (`fileSuggestions`, image `ContentBlock`s, `pathGuard`).

---

## Component 1 — Drag-and-drop from Explorer → `@`-mention

**Webview (`Composer.tsx`):**
- Add `onDragOver` (call `preventDefault`, toggle a `.composer--drop-active` highlight class) and `onDragLeave`/`onDrop` handlers on the composer container.
- On drop, collect resource URIs in priority order:
  1. `dataTransfer.getData('text/uri-list')` — newline-separated `file://` URIs (VS Code Explorer drags supply this).
  2. Fallback: `dataTransfer.files` (OS-level file drags).
- Post a new host message `{ type: 'resolveDroppedUris', uris: string[] }`. Do **not** parse paths in the webview — it can't reliably map a `file://` URI to the workspace root.

**Host (`sessionManager.ts`):**
- Handle `resolveDroppedUris`: for each URI, `vscode.Uri.parse` → `stat`. Map to a workspace-relative path with `vscode.workspace.asRelativePath(uri, false)`. Detect images by extension (`.png .jpg .jpeg .gif .webp .bmp .svg`). For images, read bytes and base64-encode host-side. Run results through the existing `pathGuard` so out-of-workspace drops are rejected gracefully.
- Reply `{ type: 'droppedFilesResolved', items: Array<{ path: string; isImage: boolean; mimeType?: string; data?: string; name?: string }> }`.

**Webview applies the reply:**
- Non-image items: insert `@<path> ` (space-separated) at the current caret position (`selectionStart`), or at end if the textarea isn't focused. Multiple files insert in sequence.
- Image items: push onto the existing `images` state as image tiles — identical to the paste path, so they flow through the existing image `ContentBlock` support.

**Why host-side resolution:** the host already owns workspace folders + `pathGuard`; the webview has no filesystem access and can't base64 an image itself.

---

## Component 2 — Caret-aware `@`-trigger (reliability fix)

**Webview (`Composer.tsx`):**
- Replace the end-anchored regex `/@(\S*)$/` with a **caret-scan**: from `textarea.selectionStart`, walk left to the nearest `@` that is at string start or preceded by whitespace, with no whitespace between it and the caret. That `@…caret` substring is the active query.
- Track caret position via `onSelect`/`onKeyUp`/`onClick` (or read `selectionStart` inside the change handler) so mid-text edits re-evaluate the token.
- Empty query (bare `@`) now requests suggestions too — the host returns a small recency-ranked default set instead of `[]`.
- Insertion on accept replaces the active token span (`[atStart, caret)`) rather than assuming the token ends the string.

This fixes "sometimes doesn't trigger": any `@`-token at the caret now shows suggestions, regardless of trailing text.

---

## Component 3 — Folder-aware, recency-ranked suggestions

**Host (`getFileSuggestions(query)` in `sessionManager.ts`):**

Rework the glob + ranking. Let `q` be the trimmed query.

- **Split** `q` into a directory part and a filename part on the last `/`. `classic/` → dir=`classic`, name=`` ; `classic/agent` → dir=`classic`, name=`agent`; `agent` (no slash) → dir=``, name=`agent`.
- **Glob:**
  - With a dir part: `**/${dirGlob}/**/*${nameGlob}*` (when `name` is empty, `**/${dirGlob}/**/*`), so `@classic/` returns every file under any `classic/` directory.
  - Without a dir part: keep `**/*${nameGlob}*`.
- Keep `findFiles(pattern, '**/node_modules/**', max, token)` and the existing per-call `CancellationTokenSource` throttle (cancel the previous search).
- **Filter** to files whose workspace-relative path actually contains the typed query (case-insensitive), so the glob's breadth is constrained back to the user's intent.

**Ranking** (stable sort, best first):
1. **Recency** — files currently open in editor tabs rank first. Build the set once per call from `vscode.window.tabGroups.all` → tab inputs that are `TabInputText`/`TabInputTextDiff`, mapped to relative paths. (Pragmatic "if used" signal; no MRU database — within the "not too complicated" bound the user requested.)
2. Exact path-prefix match of `q`.
3. Path-substring match.
4. Basename match.

Cap at 25 results (unchanged). The empty-`@` default returns the open-tabs set (recency) plus a few top workspace files.

---

## Protocol changes (`src/shared/protocol.ts`)

Add to the webview→host union:
```ts
| { type: 'resolveDroppedUris'; uris: string[] }
```
Add to the host→webview union:
```ts
| { type: 'droppedFilesResolved'; items: Array<{ path: string; isImage: boolean; mimeType?: string; data?: string; name?: string }> }
```
Existing `getFileSuggestions` / `fileSuggestions` are reused for Components 2 & 3.

## Error handling

- Drop of a non-workspace / unreadable file → host omits it from `items` and logs a one-line notice; the rest still resolve.
- Image read failure → fall back to inserting the `@path` text instead of a tile.
- `findFiles` rejection or cancellation → return `[]` (current behavior preserved).
- Empty `uris` (drag carried no file resource, e.g. dragged text) → no-op.

## Testing

- **Host unit (`test/`):** `getFileSuggestions` for `agent`, `classic/`, `classic/agent`, and a non-existent prefix; assert folder-scoping and that open-tab files rank first (mock `tabGroups`). `resolveDroppedUris` maps `file://` URIs to relative paths, flags images, rejects out-of-workspace via `pathGuard`.
- **Webview unit:** caret-scan token detection — `@foo` at end, `@foo` mid-text with trailing chars, bare `@`, caret moved away (no token). Token-span replacement on accept.
- **Manual:** drag one and several files from Explorer onto the chat; drag an image (expect a tile); type `@classic/` and confirm folder contents appear with open files first; edit an `@`-mention mid-line and confirm the menu reappears.

## Affected files

- `webview-ui/src/components/Composer.tsx` — drop handlers, caret-aware trigger, token-span insertion.
- `webview-ui/src/App.tsx` — wire `resolveDroppedUris` / `droppedFilesResolved`.
- `webview-ui/src/styles.css` — drop-active highlight.
- `src/host/sessionManager.ts` — `resolveDroppedUris` handler, folder-aware + recency-ranked `getFileSuggestions`.
- `src/shared/protocol.ts` — two new messages.
- `test/` — host + webview unit tests.
