import type { SessionUpdate, ToolCall } from '../../src/shared/acpTypes';
import type { HostToWebview, HydrateState, SessionMeta } from '../../src/shared/protocol';

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tool'; id: string; tool: ToolCall }
  | { kind: 'plan'; id: string; entries: { content: string; status: string }[] }
  | { kind: 'error'; id: string; text: string };

export interface PendingPermission {
  requestId: string;
  tool: ToolCall;
  options: { optionId: string; name: string; kind: string }[];
}

export interface ChatState {
  hydrated: boolean;
  session: SessionMeta | null;
  backends: HydrateState['backends'];
  allowBypass: boolean;
  items: ChatItem[];
  busy: boolean;
  permission: PendingPermission | null;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  commands: { name: string; description?: string }[];
}

export const initialState: ChatState = {
  hydrated: false,
  session: null,
  backends: [],
  allowBypass: false,
  items: [],
  busy: false,
  permission: null,
  usage: null,
  commands: []
};

let seq = 0;
const nextId = () => `i${seq++}`;

/** Pure reducer: (state, host message) -> next state. Streaming chunks patch in place. */
export function reduce(state: ChatState, msg: HostToWebview): ChatState {
  switch (msg.type) {
    case 'hydrate':
      return {
        ...state,
        hydrated: true,
        session: msg.state.session,
        backends: msg.state.backends,
        allowBypass: msg.state.allowBypass
      };
    case 'sessionMeta':
      return { ...state, session: msg.session };
    case 'busy':
      return { ...state, busy: msg.busy };
    case 'sessionUpdate':
      return applyUpdate(state, msg.update);
    default:
      return state;
  }
}

/** Append a locally-echoed user message immediately on send. */
export function appendUser(state: ChatState, text: string): ChatState {
  return { ...state, items: [...state.items, { kind: 'user', id: nextId(), text }], busy: true };
}

function applyUpdate(state: ChatState, u: SessionUpdate): ChatState {
  const items = state.items.slice();
  switch (u.kind) {
    case 'agent_message_chunk': {
      const text = blockText(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant') {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: 'assistant', id: nextId(), text });
      }
      return { ...state, items };
    }
    case 'agent_thought_chunk': {
      const text = blockText(u.content);
      const last = items[items.length - 1];
      if (last && last.kind === 'thought') {
        items[items.length - 1] = { ...last, text: last.text + text };
      } else {
        items.push({ kind: 'thought', id: nextId(), text });
      }
      return { ...state, items };
    }
    case 'tool_call':
      items.push({ kind: 'tool', id: nextId(), tool: u.toolCall });
      return { ...state, items };
    case 'tool_call_update': {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'tool' && it.tool.toolCallId === u.toolCall.toolCallId) {
          items[i] = { ...it, tool: { ...it.tool, ...u.toolCall } };
          break;
        }
      }
      return { ...state, items };
    }
    case 'plan':
      items.push({ kind: 'plan', id: nextId(), entries: u.entries });
      return { ...state, items };
    case 'available_commands_update':
      return { ...state, commands: u.commands };
    case 'usage':
      return { ...state, usage: { ...state.usage, ...u.usage } };
    case 'result':
      return { ...state, busy: false, usage: u.usage ? { ...state.usage, ...u.usage } : state.usage };
    case 'error':
      items.push({ kind: 'error', id: nextId(), text: u.message });
      return { ...state, items, busy: false };
    case 'permission_request':
      return {
        ...state,
        permission: { requestId: u.requestId, tool: u.toolCall, options: u.options }
      };
    case 'current_mode_update':
      return state.session
        ? { ...state, session: { ...state.session, mode: u.mode } }
        : state;
    default:
      return state;
  }
}

function blockText(content: { type: string; text?: string }): string {
  return content.type === 'text' ? content.text ?? '' : '';
}
