import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKENDS, claudeFamilyAlias } from '../../src/host/backendRegistry';

test('claudeFamilyAlias collapses pinned / ARN / vendor-prefixed claude ids to a family alias', () => {
  // version-pinned ids leaked from a transcript → alias the CLI resolves per-environment
  assert.equal(claudeFamilyAlias('claude-opus-4-8'), 'opus');
  assert.equal(claudeFamilyAlias('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'opus');
  assert.equal(claudeFamilyAlias('global.anthropic.claude-haiku-4-5-20251001-v1:0'), 'haiku');
  assert.equal(claudeFamilyAlias('claude-sonnet-4-6'), 'sonnet');
  // already an alias → unchanged
  assert.equal(claudeFamilyAlias('opus'), 'opus');
  // opaque inference-profile ARN carries no family → undefined (caller uses the env default)
  assert.equal(claudeFamilyAlias('arn:aws:bedrock:us-west-2:387769110234:application-inference-profile/xn8omlpdqv2w'), undefined);
  // non-claude / empty → undefined
  assert.equal(claudeFamilyAlias('grok-4'), undefined);
  assert.equal(claudeFamilyAlias(undefined), undefined);
});

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

const claude = (opts: Parameters<(typeof BACKENDS)['claude']['buildArgs']>[0]) =>
  BACKENDS.claude.buildArgs(opts);

test('claude: passes a family alias for --model, never a version-pinned id (Bedrock-safe resume)', () => {
  const a = claude({ ...base, model: 'claude-opus-4-8' });
  const i = a.indexOf('--model');
  assert.notEqual(i, -1);
  assert.equal(a[i + 1], 'opus'); // pinned id collapsed to the portable alias
});

test('claude: a vendor-prefixed pinned id also collapses to its family alias', () => {
  const a = claude({ ...base, model: 'us.anthropic.claude-sonnet-4-6' });
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
});

test('claude: an already-aliased model is passed through; default adds no --model', () => {
  assert.equal(claude({ ...base, model: 'opus' })[claude({ ...base, model: 'opus' }).indexOf('--model') + 1], 'opus');
  assert.ok(!claude({ ...base, model: 'default' }).includes('--model'));
});

test('claude: a discovered pinned id with no family alias passes through as-is (e.g. fable)', () => {
  // fable isn't opus/sonnet/haiku, so claudeFamilyAlias() returns undefined and
  // the real id is used — which is exactly why a fable-configured machine can run it.
  const a = claude({ ...base, model: 'claude-fable-5' });
  assert.equal(a[a.indexOf('--model') + 1], 'claude-fable-5');
});

// ── dynamic model discovery ─────────────────────────────────────────────────
import { modelsFor } from '../../src/host/backendRegistry';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

function withFakeHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'cb-home-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() on win32
  try {
    fn(home);
  } finally {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
}

test('claude: discovers the configured model + session-transcript models, merged with aliases', () => {
  // Skip if this platform's homedir() ignores env (rare); the assertions below
  // only hold when we can redirect HOME.
  withFakeHome((home) => {
    if (homedir() !== home) return;
    const cdir = join(home, '.claude');
    mkdirSync(cdir, { recursive: true });
    // configured default carries a [1m] context tag that must be stripped
    writeFileSync(join(cdir, 'settings.json'), JSON.stringify({ model: 'claude-fable-5[1m]' }));
    const proj = join(cdir, 'projects', 'repo-a');
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 's1.jsonl'),
      '{"type":"x","model":"claude-opus-4-8"}\n{"model":"<synthetic>"}\n{"model":"claude-fable-5"}\n'
    );

    const models = modelsFor('claude');
    assert.equal(models[0], 'default', 'default leads');
    for (const alias of ['opus', 'sonnet', 'haiku']) assert.ok(models.includes(alias), `keeps alias ${alias}`);
    assert.ok(models.includes('claude-fable-5'), 'surfaces the configured/used model the old array could not');
    assert.ok(models.includes('claude-opus-4-8'), 'surfaces a model seen in transcripts');
    assert.ok(!models.includes('<synthetic>'), 'drops synthetic placeholder');
    assert.equal(new Set(models).size, models.length, 'no duplicates');
  });
});

test('claude: discovery miss falls back to the curated aliases (never worse than static)', () => {
  withFakeHome((home) => {
    if (homedir() !== home) return;
    // empty fake home — no ~/.claude at all
    assert.deepEqual(modelsFor('claude'), ['default', 'opus', 'sonnet', 'haiku']);
  });
});

test('grok: discovery miss falls back to the static list', () => {
  withFakeHome((home) => {
    if (homedir() !== home) return;
    assert.deepEqual(modelsFor('grok'), ['default', 'grok-build']);
  });
});
