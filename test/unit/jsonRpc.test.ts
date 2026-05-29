import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as readline from 'node:readline';
import { JsonRpcEndpoint } from '../../src/host/transports/acp/jsonRpc';

/** Wire an endpoint to a scriptable peer via two in-memory pipes. */
function makePair() {
  const clientToServer = new PassThrough(); // endpoint.stdin (what client writes)
  const serverToClient = new PassThrough(); // endpoint.stdout (what client reads)
  const endpoint = new JsonRpcEndpoint(clientToServer, serverToClient);
  const sentByClient: any[] = [];
  readline.createInterface({ input: clientToServer }).on('line', (l) => {
    if (l.trim()) sentByClient.push(JSON.parse(l));
  });
  const peerSend = (obj: object) => serverToClient.write(JSON.stringify(obj) + '\n');
  return { endpoint, sentByClient, peerSend };
}

test('outbound request resolves when peer responds', async () => {
  const { endpoint, sentByClient, peerSend } = makePair();
  const p = endpoint.request('initialize', { protocolVersion: 1 });
  await tick();
  assert.equal(sentByClient[0].method, 'initialize');
  const id = sentByClient[0].id;
  peerSend({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
  const res = await p;
  assert.deepEqual(res, { protocolVersion: 1 });
});

test('inbound request is handled and a response is written back', async () => {
  const { endpoint, sentByClient, peerSend } = makePair();
  endpoint.onRequest(async (method, params) => {
    assert.equal(method, 'fs/read_text_file');
    return { content: 'file-body' };
  });
  peerSend({ jsonrpc: '2.0', id: 'r1', method: 'fs/read_text_file', params: { path: 'a.ts' } });
  await tick();
  const reply = sentByClient.find((m) => m.id === 'r1');
  assert.ok(reply, 'a reply was sent');
  assert.deepEqual(reply.result, { content: 'file-body' });
});

test('unknown inbound request gets method-not-found error', async () => {
  const { endpoint, sentByClient, peerSend } = makePair();
  // no onRequest handler registered
  peerSend({ jsonrpc: '2.0', id: 'r2', method: 'mystery/method' });
  await tick();
  const reply = sentByClient.find((m) => m.id === 'r2');
  assert.ok(reply);
  assert.equal(reply.error.code, -32601);
});

test('inbound notification reaches the notification handler', async () => {
  const { endpoint, peerSend } = makePair();
  let got: any;
  endpoint.onNotification((method, params) => {
    got = { method, params };
  });
  peerSend({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {} } });
  await tick();
  assert.equal(got.method, 'session/update');
  assert.equal(got.params.sessionId, 's');
});

function tick() {
  return new Promise((r) => setTimeout(r, 10));
}
