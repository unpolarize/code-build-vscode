import type { ContentBlock, PlanEntry, SessionUpdate, ToolCall } from '../../../shared/acpTypes';
import { permissionModeFromAcpId } from '../../../shared/permissionModes';

/** Shape of an ACP `session/update` notification's `update` field (partial). */
interface AcpUpdate {
  sessionUpdate: string;
  content?: AcpContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  // tool call content is an array of ToolCallContent (content | diff)
  rawInput?: unknown;
  locations?: { path: string; line?: number }[];
  entries?: { content: string; status: string }[];
  availableCommands?: { name: string; description?: string }[];
  currentModeId?: string;
  /** Some agents follow the narrative ACP docs and send `modeId` instead of
   * the schema's `currentModeId` — accepted as a fallback, never preferred. */
  modeId?: string;
}

type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: string; [k: string]: unknown };

/** Convert an ACP `session/update` payload into our SessionUpdate union. */
export function normalizeAcpUpdate(u: AcpUpdate): SessionUpdate[] {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      return [{ kind: 'agent_message_chunk', content: toBlock(u.content) }];
    case 'agent_thought_chunk':
      return [{ kind: 'agent_thought_chunk', content: toBlock(u.content) }];
    case 'user_message_chunk':
      return [{ kind: 'user_message_chunk', content: toBlock(u.content) }];
    case 'tool_call':
      return [{ kind: 'tool_call', toolCall: toToolCall(u) }];
    case 'tool_call_update':
      return [{ kind: 'tool_call_update', toolCall: toToolCallPartial(u) }];
    case 'plan':
      return [{ kind: 'plan', entries: (u.entries ?? []).map(toPlanEntry) }];
    case 'available_commands_update':
      return [{ kind: 'available_commands_update', commands: u.availableCommands ?? [] }];
    case 'current_mode_update': {
      // Wire field is `currentModeId` (schema SSOT; some doc examples show
      // `modeId` — tolerated as fallback). Unknown ids pass through with
      // mode:null — never throw, never coerce to 'default' (opencode
      // reports agent roles here).
      const wireId = u.currentModeId ?? u.modeId;
      return wireId
        ? [
            {
              kind: 'current_mode_update',
              mode: permissionModeFromAcpId(wireId),
              vendorModeId: wireId
            }
          ]
        : [];
    }
    default:
      return [];
  }
}

function toBlock(c: AcpContentBlock | undefined): ContentBlock {
  if (!c) return { type: 'text', text: '' };
  if (c.type === 'text') return { type: 'text', text: String((c as { text?: string }).text ?? '') };
  if (c.type === 'resource_link')
    return { type: 'resource_link', uri: String((c as { uri?: string }).uri ?? ''), name: (c as { name?: string }).name };
  if (c.type === 'image')
    return {
      type: 'image',
      mimeType: String((c as { mimeType?: string }).mimeType ?? ''),
      data: String((c as { data?: string }).data ?? '')
    };
  return { type: 'text', text: '' };
}

function toToolCall(u: AcpUpdate): ToolCall {
  return {
    toolCallId: String(u.toolCallId),
    title: String(u.title ?? 'tool'),
    kind: u.kind,
    status: (u.status as ToolCall['status']) ?? 'in_progress',
    rawInput: u.rawInput,
    locations: u.locations,
    content: extractToolContent(u)
  };
}

function toToolCallPartial(u: AcpUpdate): Partial<ToolCall> & { toolCallId: string } {
  const p: Partial<ToolCall> & { toolCallId: string } = { toolCallId: String(u.toolCallId) };
  if (u.status) p.status = u.status as ToolCall['status'];
  if (u.title) p.title = u.title;
  const content = extractToolContent(u);
  if (content.length) p.content = content;
  return p;
}

function extractToolContent(u: AcpUpdate): ContentBlock[] {
  return extractAcpToolContent((u as unknown as { content?: unknown }).content);
}

/** ACP tool content is an array of {type:'content',content} | {type:'diff',...}.
 * Exported so the permission gate can normalize the toolCall embedded in a
 * session/request_permission with the same rules as tool_call updates. */
export function extractAcpToolContent(raw: unknown): ContentBlock[] {
  const out: ContentBlock[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const it = item as Record<string, unknown>;
      if (it.type === 'content' && it.content) {
        out.push(toBlock(it.content as AcpContentBlock));
      } else if (it.type === 'diff') {
        out.push({
          type: 'diff',
          path: String(it.path ?? ''),
          oldText: String(it.oldText ?? ''),
          newText: String(it.newText ?? '')
        });
      }
    }
  }
  return out;
}

function toPlanEntry(e: { content: string; status: string }): PlanEntry {
  const status = (['pending', 'in_progress', 'completed'].includes(e.status) ? e.status : 'pending') as PlanEntry['status'];
  return { content: e.content, status };
}
