import type { Writable, Readable } from 'node:stream';
import * as readline from 'node:readline';

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}
export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}
export interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Incoming = RpcRequest | RpcNotification | RpcResponse;

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

const METHOD_NOT_FOUND = -32601;

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio. Handles outbound
 * requests/notifications and dispatches inbound requests (agent->client) and
 * notifications. Unknown inbound requests get a proper "method not found" reply
 * so the peer never blocks.
 */
export class JsonRpcEndpoint {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandler?: RequestHandler;
  private notificationHandler?: NotificationHandler;
  private rl: readline.Interface;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable
  ) {
    this.rl = readline.createInterface({ input: stdout });
    this.rl.on('line', (line) => this.onLine(line));
  }

  onRequest(h: RequestHandler): void {
    this.requestHandler = h;
  }
  onNotification(h: NotificationHandler): void {
    this.notificationHandler = h;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: RpcNotification = { jsonrpc: '2.0', method, params };
    this.write(msg);
  }

  private write(msg: object): void {
    this.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Incoming;
    try {
      msg = JSON.parse(trimmed) as Incoming;
    } catch {
      return;
    }

    // Response to one of our requests.
    if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      const entry = this.pending.get((msg as RpcResponse).id);
      if (entry) {
        this.pending.delete((msg as RpcResponse).id);
        const r = msg as RpcResponse;
        if (r.error) entry.reject(new Error(r.error.message));
        else entry.resolve(r.result);
      }
      return;
    }

    // Inbound request (agent -> client): has id + method.
    if ('id' in msg && 'method' in msg) {
      void this.dispatchRequest(msg as RpcRequest);
      return;
    }

    // Inbound notification: method, no id.
    if ('method' in msg) {
      this.notificationHandler?.((msg as RpcNotification).method, (msg as RpcNotification).params);
    }
  }

  private async dispatchRequest(req: RpcRequest): Promise<void> {
    if (!this.requestHandler) {
      this.write({ jsonrpc: '2.0', id: req.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } });
      return;
    }
    try {
      const result = await this.requestHandler(req.method, req.params);
      this.write({ jsonrpc: '2.0', id: req.id, result: result ?? null });
    } catch (err) {
      this.write({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: METHOD_NOT_FOUND, message: err instanceof Error ? err.message : String(err) }
      });
    }
  }

  dispose(): void {
    this.rl.close();
    for (const { reject } of this.pending.values()) {
      reject(new Error('JSON-RPC endpoint disposed'));
    }
    this.pending.clear();
  }
}
