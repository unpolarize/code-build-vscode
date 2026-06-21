import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BACKENDS } from '../../src/host/backendRegistry';

// The shipped defaults live in package.json's contributes.configuration — VS
// Code reads them directly, and sessionManager reads them back via
// config.get(key, fallback) where the fallback never fires for a registered
// key. So the *defaults that ship* are what these assertions guard.
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  contributes: { configuration: { properties: Record<string, { default: unknown }> } };
};
const props = pkg.contributes.configuration.properties;

test('package.json ships "bypass" as the default initial permission mode', () => {
  assert.equal(props['codeBuild.initialPermissionMode'].default, 'bypass');
});

test('package.json opens the bypass capability gate by default', () => {
  // initialPermissionMode=bypass is silently downgraded to "default" at runtime
  // unless allowDangerouslySkipPermissions is true (sessionManager.rememberedConfig:
  //   if (mode === 'bypass' && !this.allowBypass) mode = 'default').
  // Both must flip together or the new default is a no-op.
  assert.equal(props['codeBuild.allowDangerouslySkipPermissions'].default, true);
});

test('claude honours bypass: emits --dangerously-skip-permissions when the gate is open', () => {
  // Characterization guard: the bypass default is only meaningful because
  // buildArgs turns it into the flag that actually stops every prompt.
  const args = BACKENDS.claude.buildArgs({ cwd: '/tmp', mode: 'bypass', allowBypass: true });
  assert.ok(
    args.includes('--dangerously-skip-permissions'),
    'bypass mode must skip permissions for the new default to mean anything'
  );
});

test('claude bypass WITHOUT the gate falls back to a permission-mode flag (never the dangerous one)', () => {
  // Defense-in-depth: if a user explicitly turns the gate back off, bypass must
  // not silently emit --dangerously-skip-permissions.
  const args = BACKENDS.claude.buildArgs({ cwd: '/tmp', mode: 'bypass', allowBypass: false });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--permission-mode'));
});
