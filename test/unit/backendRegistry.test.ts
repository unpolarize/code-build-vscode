import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS } from '../../src/host/backendRegistry';

const grok = (opts: Parameters<(typeof BACKENDS)['grok']['buildArgs']>[0]) =>
  BACKENDS.grok.buildArgs(opts);

const base = { cwd: '/tmp', mode: 'default' as const };

test('grok: bare session is just `agent stdio`', () => {
  assert.deepEqual(grok({ ...base }), ['agent', 'stdio']);
});

test('grok: options precede the `stdio` subcommand (stdio takes no flags)', () => {
  const args = grok({ ...base, model: 'grok-build', effort: 'high' });
  // stdio must be last; every flag before it.
  assert.equal(args[args.length - 1], 'stdio');
  assert.deepEqual(args, ['agent', '--model', 'grok-build', '--reasoning-effort', 'high', 'stdio']);
});

test('grok: uses --reasoning-effort, never --effort', () => {
  const args = grok({ ...base, effort: 'medium' });
  assert.ok(args.includes('--reasoning-effort'));
  assert.ok(!args.includes('--effort'), 'grok rejects --effort and exits 2');
  assert.deepEqual(args, ['agent', '--reasoning-effort', 'medium', 'stdio']);
});

test('grok: max maps to xhigh (grok has no `max` level)', () => {
  const args = grok({ ...base, effort: 'max' });
  assert.deepEqual(args, ['agent', '--reasoning-effort', 'xhigh', 'stdio']);
});

test('grok: default model and default effort add no flags', () => {
  assert.deepEqual(grok({ ...base, model: 'default', effort: 'default' }), ['agent', 'stdio']);
});
