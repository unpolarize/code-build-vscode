import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SOCK = join(homedir(), '.sessions', '.daemon', 'daemon.sock');

export interface DaemonHello {
  daemonVersion: string;
  protocol: number;
}

export interface DaemonSessionRow {
  id: string;
  host: string;
  agent: string;
  cwd: string;
  title?: string;
  backend?: string;
  hasContent: boolean;
  startedAt?: string;
  eventSeq: number;
}

function rpcCall(method: string, params?: unknown, timeoutMs = 2500): Promise<unknown> {
  const socketPath = process.env.CODE_SESSIONS_SOCKET || DEFAULT_SOCK;
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    let settled = false;
    const done = (err: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: { message: string } };
        if (msg.error) done(new Error(msg.error.message));
        else done(null, msg.result);
      } catch (e) {
        done(e as Error);
      }
    });
    sock.on('timeout', () => done(new Error('daemon rpc timeout')));
    sock.on('error', (e) => done(e));
  });
}

export async function daemonHello(): Promise<DaemonHello | null> {
  try {
    return (await rpcCall('hello')) as DaemonHello;
  } catch {
    return null;
  }
}

export async function daemonCreate(params: {
  id?: string;
  backend?: string;
  cwd?: string;
  model?: string;
  title?: string;
  mode?: string;
  effort?: string;
  kind?: string;
}): Promise<string | null> {
  try {
    const r = (await rpcCall('session.create', params)) as { id: string };
    return r.id;
  } catch {
    return null;
  }
}

export async function daemonPatchMeta(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await rpcCall('session.patchMeta', { id, patch });
  } catch {
    /* daemon optional */
  }
}

export async function daemonAppend(id: string, event: unknown, ts?: number): Promise<void> {
  try {
    await rpcCall('session.append', { id, event, ts });
  } catch {
    /* daemon optional */
  }
}

export async function daemonList(filter: { cwd?: string; hasContent?: boolean; limit?: number }): Promise<DaemonSessionRow[]> {
  try {
    const r = (await rpcCall('session.list', { filter, limit: filter.limit ?? 100 })) as {
      sessions: DaemonSessionRow[];
    };
    return r.sessions ?? [];
  } catch {
    return [];
  }
}
