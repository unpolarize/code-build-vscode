// ACP-shaped event model. This is the canonical internal vocabulary (Approach A):
// native backends (Claude stream-json, Codex NDJSON) are normalized INTO these types,
// and real ACP backends (Grok, opencode, Cline) map onto them directly.

import type { BackendErrorClass } from './backendErrorClass';

export type BackendId = 'claude' | 'grok' | 'codex' | 'opencode' | 'cline';

/** Host permission vocabulary. Superset of Claude Code's wire ids so the
 * chip can display Claude's post-2026-08-14 default (`auto`) truthfully:
 * wire `bypassPermissions` ↔ `bypass`, wire `manual` reads as `default`.
 * Non-permission ACP "modes" (opencode agent roles like `build`) do NOT
 * map here — they pass through as vendorModeId on current_mode_update. */
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass' | 'auto' | 'dontAsk';

/** A piece of content in a message or tool result (subset of the ACP ContentBlock model). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'diff'; path: string; oldText: string; newText: string }
  /** Reply to a previously-emitted tool_use. Anthropic's Messages API
   * requires THIS block (not a plain text user message) to fulfil a
   * pending tool call — claude's AskUserQuestion built-in waits on a
   * tool_result keyed by tool_use_id. Sending a text block instead made
   * claude treat the answer as a free-form user message and abandon the
   * tool call ("× AskUserQuestion" failed state). */
  | { type: 'tool_result'; tool_use_id: string; content: string };

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: string; // e.g. 'read' | 'edit' | 'execute' | 'search'
  status: ToolCallStatus;
  content?: ContentBlock[];
  /** File locations this tool touched (for diff/jump-to). */
  locations?: { path: string; line?: number }[];
  /** Raw input the agent passed to the tool, when available. */
  rawInput?: unknown;
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens served from the model provider's prompt cache (e.g. Anthropic
   * server-side cache). Cheaper than `inputTokens` — usually billed at ~10%. */
  cacheReadTokens?: number;
  /** Tokens written to the model provider's prompt cache. Typically billed
   * at a premium (~125% of input) but only paid once per cache entry. */
  cacheCreationTokens?: number;
  costUsd?: number;
  /** Optional model id this usage row is attributed to (e.g.
   * `claude-opus-4-5-20251015`, `grok-build`, `llama3.2:3b`). Lets the UI
   * group per-model breakdown when multiple models contributed turns to
   * a single conversation (cross-tool resume, model swap, etc.). */
  model?: string;
  /** Where the model ran. 'remote' = cloud API with $/token cost; 'local' =
   * laptop GPU (Ollama, transformers.js) with no cost. */
  provider?: 'remote' | 'local';
}

/** Permission option offered by the agent (mirrors ACP request_permission options). */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

/**
 * The single union the webview consumes. All discriminators come from ACP's
 * session/update vocabulary, plus a few host-level events (result/usage/error/
 * permission_request) that we surface uniformly.
 */
export type SessionUpdate =
  | { kind: 'agent_message_chunk'; content: ContentBlock }
  | { kind: 'agent_thought_chunk'; content: ContentBlock }
  | { kind: 'user_message_chunk'; content: ContentBlock }
  | { kind: 'tool_call'; toolCall: ToolCall }
  | { kind: 'tool_call_update'; toolCall: Partial<ToolCall> & { toolCallId: string } }
  | { kind: 'plan'; entries: PlanEntry[] }
  | { kind: 'available_commands_update'; commands: { name: string; description?: string }[] }
  /** Agent-reported mode change. `mode` is null when the vendor id has no
   * permission-mode meaning (e.g. opencode agent roles); `vendorModeId`
   * always carries the raw wire id for labeled passthrough on the chip. */
  | { kind: 'current_mode_update'; mode: PermissionMode | null; vendorModeId: string }
  /** Mode inventory from the ACP session/new|load RESPONSE (`modes` field —
   * ACP has no available_modes_update event). Seeds the picker options and
   * current selection before any current_mode_update arrives. */
  | {
      kind: 'modes_update';
      currentModeId: string;
      availableModes: { id: string; name: string; description?: string }[];
    }
  | { kind: 'usage'; usage: UsageInfo }
  /** Per-model usage breakdown — one entry per (model, provider). Aggregated
   * totals still arrive via `usage` so the header cost display keeps working;
   * this drives the expanded tooltip in the UI. */
  | { kind: 'usage_breakdown'; entries: UsageInfo[] }
  | { kind: 'result'; stopReason: string; usage?: UsageInfo }
  | { kind: 'error'; message: string; errorClass?: BackendErrorClass }
  /** Backend reported its native session id at startup. Claude assigns
   * its own session id (independent of our local UUID) and writes the
   * transcript under that id in ~/.claude/projects. We capture it on
   * the SessionMeta so a later reload can `--resume <native-id>` and
   * pick up the on-disk transcript — without this, the resumed agent
   * spawned with NO context and said "I don't have prior conversation
   * context to continue from". */
  | { kind: 'system_init'; backendSessionId: string }
  /** Negotiated ACP protocol version from the initialize handshake.
   * Read-only header chip; warn never blocks session start. */
  | {
      kind: 'protocol_version_update';
      hostVersion: number;
      agentVersion: number | null;
      experimental: boolean;
      label: string;
      warn: boolean;
      warnReason?: string;
    }
  /** Spend-limit parity chip (Claude 2.1.251 `/usage` bar class).
   * `available:false` → label `spend n/a` — never invent remaining %. */
  | {
      kind: 'spend_limit_update';
      available: boolean;
      usedPercentage: number | null;
      remainingPercentage: number | null;
      resetsAt: number | null;
      /** 5-HOUR rate window resets_at (epoch sec) from the same payload —
       * the window the resume-after-reset park binds to (never spend).
       * Null when the vendor omitted it: unknown reset, manual-resume only. */
      fiveHourResetsAt?: number | null;
      label: string;
      warn: boolean;
      warnReason?: string;
    }
  /** Native resume failed and the transport fell back to a fresh
   * session (e.g. Grok ACP session/load rejected because the on-disk
   * session was deleted or the grok version regressed). The host uses
   * this to arm the self-resume primer so the fresh agent still gets
   * conversation context, and to tell the user what happened. A
   * system_init with the NEW backend session id follows this event. */
  | { kind: 'resume_fallback'; requestedSessionId: string; reason: string }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: ToolCall;
      options: PermissionOption[];
    };
