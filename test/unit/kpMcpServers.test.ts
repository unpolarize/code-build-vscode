import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendKpMcpServer,
  buildKpMcpServerEntry,
  resolveAcpMcpServersFromInspect,
  type AcpMcpServer,
  type KpMcpOptions
} from '../../src/host/transports/mcpServers.ts';

const CLI = '/Users/me/projects/knowledge-planning/src/cli/index.ts';

function opts(over: Partial<KpMcpOptions> = {}): KpMcpOptions {
  return {
    enabled: true,
    command: CLI,
    root: '/Users/me/docs/planning',
    backend: 'grok',
    model: 'grok-4.5',
    sessionId: 'host-session-1',
    ...over
  };
}

function envMap(server: AcpMcpServer): Record<string, string> {
  return Object.fromEntries(server.env.map((e) => [e.name, e.value]));
}

describe('buildKpMcpServerEntry', () => {
  it('builds node + [cli, mcp] with all four provenance env vars', () => {
    const r = buildKpMcpServerEntry(opts());
    assert.ok('server' in r);
    const s = (r as { server: AcpMcpServer }).server;
    assert.equal(s.name, 'kp');
    assert.equal(s.command, process.execPath);
    assert.deepEqual(s.args, [CLI, 'mcp']);
    const env = envMap(s);
    assert.deepEqual(Object.keys(env).sort(), ['KP_AGENT', 'KP_MODEL', 'KP_ROOT', 'KP_SESSION']);
    assert.equal(env.KP_ROOT, '/Users/me/docs/planning');
    assert.equal(env.KP_AGENT, 'grok');
    assert.equal(env.KP_MODEL, 'grok-4.5');
    assert.equal(env.KP_SESSION, 'host-session-1');
  });

  it('maps codex backend to KP_AGENT=codex', () => {
    const r = buildKpMcpServerEntry(opts({ backend: 'codex' }));
    assert.equal(envMap((r as { server: AcpMcpServer }).server).KP_AGENT, 'codex');
  });

  it('KP_MODEL falls back to "default" (never clientInfo 0.0.1)', () => {
    for (const model of [undefined, '', '   ']) {
      const r = buildKpMcpServerEntry(opts({ model }));
      const env = envMap((r as { server: AcpMcpServer }).server);
      assert.equal(env.KP_MODEL, 'default');
      assert.notEqual(env.KP_MODEL, '0.0.1');
    }
  });

  it('disabled → skip disabled', () => {
    assert.deepEqual(buildKpMcpServerEntry(opts({ enabled: false })), { skip: 'disabled' });
  });

  it('missing/blank command → skip missing-command', () => {
    for (const command of [undefined, '', '  ']) {
      assert.deepEqual(buildKpMcpServerEntry(opts({ command })), { skip: 'missing-command' });
    }
  });

  it('rejects bare node / node binary as command (script path required)', () => {
    assert.deepEqual(buildKpMcpServerEntry(opts({ command: 'node' })), {
      skip: 'missing-command'
    });
    assert.deepEqual(buildKpMcpServerEntry(opts({ command: process.execPath })), {
      skip: 'missing-command'
    });
  });

  it('missing/blank root → skip missing-root', () => {
    for (const root of [undefined, '', '  ']) {
      assert.deepEqual(buildKpMcpServerEntry(opts({ root })), { skip: 'missing-root' });
    }
  });
});

describe('appendKpMcpServer', () => {
  const base = (): AcpMcpServer[] => [
    { name: 'chrome-devtools', command: 'npx', args: ['-y', 'x'], env: [] }
  ];

  it('default off → base returned byte-identical (no kp entry)', () => {
    const b = base();
    const { servers, skip } = appendKpMcpServer(b, opts({ enabled: false }));
    assert.equal(skip, 'disabled');
    assert.equal(servers, b);
    assert.deepEqual(servers, base());
    assert.ok(!servers.some((s) => s.name === 'kp'));
  });

  it('enabled → exactly one kp entry appended after base', () => {
    const { servers, skip } = appendKpMcpServer(base(), opts());
    assert.equal(skip, undefined);
    assert.equal(servers.length, 2);
    assert.equal(servers.filter((s) => s.name === 'kp').length, 1);
    assert.equal(servers[1].command, process.execPath);
    assert.deepEqual(servers[1].args, [CLI, 'mcp']);
  });

  it('enabled + empty base → [kp] (setting is the opt-in, not browser defaults)', () => {
    const { servers } = appendKpMcpServer([], opts());
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'kp');
  });

  it('disableDefaultMcpServers + enabled → [kp] only', () => {
    const b = resolveAcpMcpServersFromInspect(undefined, true);
    assert.deepEqual(b, []);
    const { servers } = appendKpMcpServer(b, opts());
    assert.deepEqual(servers.map((s) => s.name), ['kp']);
  });

  it('user config already lists kp → no duplicate, entry untouched', () => {
    const userKp: AcpMcpServer = {
      name: 'kp',
      command: '/custom/node',
      args: ['/custom/kp.js', 'mcp'],
      env: [{ name: 'KP_ROOT', value: '/custom' }]
    };
    const b = [userKp];
    const { servers, skip } = appendKpMcpServer(b, opts());
    assert.equal(skip, 'user-defined');
    assert.equal(servers.filter((s) => s.name === 'kp').length, 1);
    assert.equal(servers[0], userKp);
    assert.equal(servers[0].command, '/custom/node');
  });

  it('exact-name match only — kp-other does not block injection', () => {
    const b: AcpMcpServer[] = [{ name: 'kp-other', command: 'x', env: [] }];
    const { servers } = appendKpMcpServer(b, opts());
    assert.deepEqual(servers.map((s) => s.name), ['kp-other', 'kp']);
  });

  it('missing command/root → skip reason surfaced, base unchanged (session starts)', () => {
    const b = base();
    const noCmd = appendKpMcpServer(b, opts({ command: undefined }));
    assert.equal(noCmd.skip, 'missing-command');
    assert.equal(noCmd.servers, b);
    const noRoot = appendKpMcpServer(b, opts({ root: undefined }));
    assert.equal(noRoot.skip, 'missing-root');
    assert.equal(noRoot.servers, b);
  });

  it('does not mutate the base array on append', () => {
    const b = base();
    appendKpMcpServer(b, opts());
    assert.equal(b.length, 1);
  });
});
