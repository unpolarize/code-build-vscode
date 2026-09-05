// Pure helpers for the /kp task-picker and the deferred KP link-session
// binding (kp: tasks/cb-kp-task-picker-start-a-session-from-a-kp-item,
// ideas/cb-host-529-overload-cross-acp-failover-on-model).
//
// No vscode / child_process imports — the host owns spawning; everything
// here is contract parsing and latch logic so it can be unit-tested with
// mocked spawn output.

/** One row of `kp implementable --json` (contract pinned to these keys). */
export interface KpImplementableRow {
  id: string;
  priority: string | null;
  title: string;
  project: string | null;
  targetRepo: string | null;
}

export interface KpImplementableResult {
  /** Store is in away mode (`{away:true, rows:[]}` shape) — show a notice,
   * not an empty-queue error. */
  away: boolean;
  rows: KpImplementableRow[];
}

/**
 * Parse `kp implementable --json` stdout. The CLI emits either a bare array
 * of rows or, in away mode, `{away:true, rows:[]}` — both shapes must parse.
 * Throws on malformed JSON / unrecognized shapes so callers surface one
 * clear error instead of a silent empty QuickPick.
 */
export function parseImplementableJson(raw: string): KpImplementableResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`kp implementable returned non-JSON output (${raw.slice(0, 120)}…)`);
  }
  const toRows = (list: unknown[]): KpImplementableRow[] =>
    list
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .filter((r) => typeof r.id === 'string' && r.id.length > 0)
      .map((r) => ({
        id: r.id as string,
        priority: typeof r.priority === 'string' ? r.priority : null,
        title: typeof r.title === 'string' ? (r.title as string) : (r.id as string),
        project: typeof r.project === 'string' ? (r.project as string) : null,
        targetRepo: typeof r.target_repo === 'string' ? (r.target_repo as string) : null
      }));
  if (Array.isArray(data)) return { away: false, rows: toRows(data) };
  if (data && typeof data === 'object' && (data as Record<string, unknown>).away === true) {
    const rows = (data as Record<string, unknown>).rows;
    return { away: true, rows: Array.isArray(rows) ? toRows(rows) : [] };
  }
  throw new Error('kp implementable returned an unrecognized JSON shape');
}

/**
 * Frame a `kp pack` as a one-shot first-prompt primer (mirrors the /handoff
 * primer contract: prepends to the user's first send, never auto-sent).
 */
export function formatKpPackPrimer(pack: string, itemId: string): string {
  const body = pack.trim();
  if (!body) return '';
  return (
    `<planning-item-pack id="${itemId}">\n` +
    `The user picked this knowledge-planning item to work on. The pack below is ` +
    `the item's briefing (body, linked specs, graph context). Ground your work in ` +
    `it; the user's message follows.\n\n${body}\n</planning-item-pack>\n\n`
  );
}

/**
 * Reject misconfigured `codeBuild.kp.command` values the same way the kp MCP
 * inject does: the setting is the CLI *script* path spawned via node, so a
 * bare 'node' (or the node binary itself) would produce a broken spawn.
 */
export function resolveKpCliPath(command: string | undefined, execPath: string): string | undefined {
  const cli = (command ?? '').trim();
  if (!cli || cli === 'node' || cli === execPath) return undefined;
  return cli;
}

/**
 * Link-once latch: armed with a KP item id at pick time, consumed exactly
 * once when the backend-native session id first lands. The guard lives host-
 * side (KP's appendEdge is deduped, but re-links waste spawns and duplicate
 * notices); resume/reload/history-open never re-arm it.
 */
export class KpLinkLatch {
  private itemId?: string;
  private sessionId?: string;

  /** Arm for ONE local session — a later session transition (switchBackend,
   * history load, handoff) must not link its native uuid to the item. */
  arm(itemId: string, sessionId: string): void {
    this.itemId = itemId;
    this.sessionId = sessionId;
  }

  /**
   * Returns the armed item id exactly once IF the latch was armed for
   * `sessionId`, clearing the latch. A mismatched session clears the latch
   * without firing (the pick's session is gone — dropping is safer than
   * linking a foreign uuid).
   */
  consume(sessionId: string | undefined): string | undefined {
    if (this.itemId === undefined) return undefined;
    const match = sessionId !== undefined && sessionId === this.sessionId;
    const id = this.itemId;
    this.itemId = undefined;
    this.sessionId = undefined;
    return match ? id : undefined;
  }

  get armed(): boolean {
    return this.itemId !== undefined;
  }

  clear(): void {
    this.itemId = undefined;
    this.sessionId = undefined;
  }
}
