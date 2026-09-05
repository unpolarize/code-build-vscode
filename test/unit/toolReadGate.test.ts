import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolReadGate,
  classifyReadSize,
  detectReadToolPath,
  parseBashReadPath,
  formatBytes,
  DEFAULT_TOOL_READ_MAX_BYTES_WARN,
  DEFAULT_TOOL_READ_MAX_BYTES_BLOCK,
  DEFAULT_TOOL_READ_GATE_CONFIG,
  type ToolReadGateEvent
} from '../../src/shared/toolReadGate';

const WARN = DEFAULT_TOOL_READ_MAX_BYTES_WARN;
const BLOCK = DEFAULT_TOOL_READ_MAX_BYTES_BLOCK;
const TWO_MIB = 2 * 1024 * 1024;

// --- classify / format --------------------------------------------------------

test('classifyReadSize: defaults allow / warn / block', () => {
  assert.equal(classifyReadSize(0), 'allow');
  assert.equal(classifyReadSize(WARN - 1), 'allow');
  assert.equal(classifyReadSize(WARN), 'warn');
  assert.equal(classifyReadSize(BLOCK - 1), 'warn');
  assert.equal(classifyReadSize(BLOCK), 'block');
  assert.equal(classifyReadSize(TWO_MIB), 'block');
});

test('classifyReadSize: disabled thresholds never fire', () => {
  assert.equal(classifyReadSize(TWO_MIB, { maxBytesWarn: 0, maxBytesBlock: 0 }), 'allow');
  assert.equal(classifyReadSize(TWO_MIB, { maxBytesWarn: WARN, maxBytesBlock: 0 }), 'warn');
  assert.equal(classifyReadSize(WARN + 10, { maxBytesWarn: 0, maxBytesBlock: BLOCK }), 'allow');
});

test('formatBytes renders KiB/MiB', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(WARN), '100 KiB');
  assert.equal(formatBytes(BLOCK), '1.0 MiB');
  assert.equal(formatBytes(TWO_MIB), '2.0 MiB');
});

// --- bash / tool detectors ----------------------------------------------------

test('parseBashReadPath extracts simple cat/head paths', () => {
  assert.equal(parseBashReadPath('cat /tmp/big.log'), '/tmp/big.log');
  assert.equal(parseBashReadPath('head -n 20 ./a.txt'), './a.txt');
  assert.equal(parseBashReadPath('sudo less notes.md'), 'notes.md');
  assert.equal(parseBashReadPath('cat foo | wc -l'), null); // pipe
  assert.equal(parseBashReadPath('cat a; rm a'), null);
});

test('detectReadToolPath covers Read and Bash cat', () => {
  assert.equal(detectReadToolPath('Read', { path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(detectReadToolPath('read_file', { file_path: 'x.md' }), 'x.md');
  assert.equal(detectReadToolPath('Bash', { command: 'cat huge.json' }), 'huge.json');
  assert.equal(detectReadToolPath('Edit', { path: 'x.ts' }), null);
  assert.equal(detectReadToolPath('Bash', { command: 'npm test' }), null);
});

// --- gate: block / grant-once / session-allow ---------------------------------

test('2 MiB fixture is blocked without a grant', () => {
  const events: ToolReadGateEvent[] = [];
  const g = new ToolReadGate(DEFAULT_TOOL_READ_GATE_CONFIG, (e) => events.push(e));
  const path = '/tmp/fixture-2mib.bin';
  assert.equal(g.allowRead(path, TWO_MIB), false);
  const ev = g.evaluate(path, TWO_MIB);
  assert.equal(ev.decision, 'block');
  assert.ok(events.some((e) => e.type === 'deny' && e.path === path && e.bytes === TWO_MIB));
});

test('grant-once permits exactly one subsequent read of that path', () => {
  const events: ToolReadGateEvent[] = [];
  const g = new ToolReadGate(DEFAULT_TOOL_READ_GATE_CONFIG, (e) => events.push(e));
  const path = '/workspace/big.log';

  assert.equal(g.allowRead(path, TWO_MIB), false);

  g.grantOnce(path);
  assert.ok(g.hasOnceGrant(path));
  assert.ok(events.some((e) => e.type === 'grant' && e.grant === 'once'));

  const first = g.evaluate(path, TWO_MIB);
  assert.equal(first.decision, 'allow');
  assert.equal(first.usedGrant, 'once');
  assert.equal(g.hasOnceGrant(path), false); // consumed

  // Second read of the same path blocks again.
  const second = g.evaluate(path, TWO_MIB);
  assert.equal(second.decision, 'block');
  assert.equal(second.usedGrant, undefined);
});

test('grant-once does not cover a different path', () => {
  const g = new ToolReadGate();
  g.grantOnce('/a.log');
  assert.equal(g.allowRead('/b.log', TWO_MIB), false);
  assert.equal(g.allowRead('/a.log', TWO_MIB), true);
});

test('session-allow permits all oversized reads for the session', () => {
  const events: ToolReadGateEvent[] = [];
  const g = new ToolReadGate(DEFAULT_TOOL_READ_GATE_CONFIG, (e) => events.push(e));

  g.grantSession();
  assert.ok(g.hasSessionAllow());
  assert.ok(events.some((e) => e.type === 'grant' && e.grant === 'session'));

  assert.equal(g.allowRead('/a', TWO_MIB), true);
  assert.equal(g.allowRead('/b', TWO_MIB * 2), true);
  const ev = g.evaluate('/c', TWO_MIB);
  assert.equal(ev.decision, 'allow');
  assert.equal(ev.usedGrant, 'session');
});

test('warn fires once per path; read still proceeds', () => {
  const events: ToolReadGateEvent[] = [];
  const g = new ToolReadGate(DEFAULT_TOOL_READ_GATE_CONFIG, (e) => events.push(e));
  const path = '/mid.txt';
  const size = WARN + 50;

  const a = g.evaluate(path, size);
  assert.equal(a.decision, 'warn');
  const b = g.evaluate(path, size);
  assert.equal(b.decision, 'warn');
  assert.equal(events.filter((e) => e.type === 'warn' && e.path === path).length, 1);
});

test('clearGrants restores deny posture', () => {
  const g = new ToolReadGate();
  g.grantSession();
  g.grantOnce('/x');
  g.clearGrants();
  assert.equal(g.hasSessionAllow(), false);
  assert.equal(g.allowRead('/x', TWO_MIB), false);
});

test('setConfig updates thresholds mid-session', () => {
  const g = new ToolReadGate({ maxBytesWarn: 10, maxBytesBlock: 100 });
  assert.equal(g.allowRead('/f', 50), true); // warn band
  g.setConfig({ maxBytesWarn: 10, maxBytesBlock: 40 });
  assert.equal(g.allowRead('/f', 50), false);
});
