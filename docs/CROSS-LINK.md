# Cross-store session join contract

Frozen join keys for correlating a **Code Build** session with the **native**
transcript each backend writes on its own. Consumed by Code Sessions (CSV)
analytics/dedupe and any future multi-store tools. Additive only — never invent
ids; never rewrite existing capture paths.

Authoritative types: `SessionMeta` in `src/shared/protocol.ts`. Capture path:
`applyBackendSessionId` in `src/host/backendIdentity.ts`. Exporter summary:
`exportToClaudeJsonl` in `src/host/persistence/jsonlExporter.ts`.

---

## 1. Key table

| Key | Where it lives | Meaning |
| --- | --- | --- |
| `meta.id` | CB `~/.codebuild/sessions/<id>.jsonl` header + `index.json` | CB-local UUID. Stable for the CB conversation row. |
| `meta.backendSessionId` | same meta header | **Current** native session id announced by the backend via `system_init`. Used for `--resume` / `session/load` / `codex exec resume`. |
| `meta.backendSessionHistory[].id` | same meta header | Every native id this CB session has owned, oldest first. Appended only on **id change** (same-id re-inits are no-ops). |
| `meta.native.format` | same meta header | On-disk layout of the backend's own store (see format map). Absent for unmapped backends. |
| `meta.native.id` | same meta header | Must equal `backendSessionId` (single source of truth for the current native id). |
| Exporter `summary.sessionId` | Claude-style export JSONL first line | = `meta.id` (CB id). |
| Exporter `summary.backendSessionId` | same, **only if set** | = `meta.backendSessionId`. Omitted entirely when absent (no `null`). |
| Exporter `summary.native` | same, **only if set** | `{ format, id }` copy of `meta.native`. Omitted when absent. |

### Invariants

1. **`native.id === backendSessionId`** whenever `native` is present.
2. History appends only on id **change**; long sessions that re-init hundreds of times must not spam history.
3. Never invent a native id that does not appear in a `system_init` (or equivalent) line of the transcript. Offline backfill refuses live `~/.codebuild` without explicit opt-in (`backfillNativeIds`).

---

## 2. N:1 mapping

Many native transcript ids may map to **one** CB session:

```
history[].id  ∪  { backendSessionId }   →   meta.id
```

Reasons a CB session rotates its native id (`BackendSessionTransitionReason`):

| reason | when |
| --- | --- |
| `initial` | first `system_init` of the session |
| `respawn` | mid-session process respawn (model/effort change, etc.) issued a fresh id |
| `compact` | reserved — compaction respawns once detectable |
| `resume_fallback` | native resume rejected; transport fell back to a fresh session |

Consumers that want "every native file that belongs to this conversation" must
union history ids with the current `backendSessionId`. Consumers that only need
the live resume target read `backendSessionId` alone.

---

## 3. External-open rule

Rows can also surface **upstream** CLI sessions the user started outside CB
(`SessionSource`):

| `source` | id semantics | resume |
| --- | --- | --- |
| `codebuild` (default / missing) | `meta.id` is CB-local; native id is `backendSessionId` / `native.id` | CB spawns with backend resume flag using `backendSessionId` when present |
| `claude` | **`meta.id` IS the native claude session id** — never invent a second id | spawn `claude --resume <meta.id>` (and `externalPath` points at the jsonl) |
| `grok` | **`meta.id` IS the native grok session id** | spawn/load using that id; `externalPath` points at the grok transcript |

For `source ∈ {claude, grok}`, do not invent a separate `backendSessionId` to
"hold" the native id — the row id already is native. Dual-write fields on those
rows are optional/redundant; CSV join for external rows is `meta.id` ↔ native
path, not CB dual-write history.

---

## 4. Native format map

| Backend | `native.format` | On-disk path pattern |
| --- | --- | --- |
| `claude` | `claude-jsonl` | `~/.claude/projects/<slug>/<uuid>.jsonl` |
| `grok` | `grok-jsonl` | `~/.grok/sessions/<cwd-key>/<uuid>/` (transcript files inside) |
| `codex` | `codex-rollout` | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<uuid>.jsonl` |
| `opencode`, `cline`, others | *(none)* | id/history still tracked; no `native` pointer until the layout is verified |

Format strings are stable API for CSV and exporters — do not rename without a
migration note.

---

## 5. Exporter summary contract

`exportToClaudeJsonl` first line (`type: "summary"`):

**Always present:** `sessionId`, `source: "code-build"`, `backend`, `cwd`, `timestamp`.

**Additive (omit when unset — never emit `null`):**

- `backendSessionId` — current native id
- `native` — `{ "format": "<NativeTranscriptFormat>", "id": "<same as backendSessionId>" }`

CSV / other consumers: parse these as optional. Absence means "pre-dual-write
session" or "backend has no known native store," not "deleted."

---

## 6. Out of scope (this contract)

- CSV merge/dedupe implementation (follow-on in `code-sessions-vscode` against this doc).
- Deleting or hiding orphan native transcripts after rotation.
- Live unattended backfill of `~/.codebuild` (operator opt-in only).
- UI for history lineage.
