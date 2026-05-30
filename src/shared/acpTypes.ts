// ACP-shaped event model. This is the canonical internal vocabulary (Approach A):
// native backends (Claude stream-json, Codex NDJSON) are normalized INTO these types,
// and real ACP backends (Grok, opencode, Cline) map onto them directly.

export type BackendId = 'claude' | 'grok' | 'codex' | 'opencode' | 'cline';

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass';

/** A piece of content in a message or tool result (subset of the ACP ContentBlock model). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'diff'; path: string; oldText: string; newText: string };

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
  | { kind: 'current_mode_update'; mode: PermissionMode }
  | { kind: 'usage'; usage: UsageInfo }
  /** Per-model usage breakdown — one entry per (model, provider). Aggregated
   * totals still arrive via `usage` so the header cost display keeps working;
   * this drives the expanded tooltip in the UI. */
  | { kind: 'usage_breakdown'; entries: UsageInfo[] }
  | { kind: 'result'; stopReason: string; usage?: UsageInfo }
  | { kind: 'error'; message: string }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: ToolCall;
      options: PermissionOption[];
    };
