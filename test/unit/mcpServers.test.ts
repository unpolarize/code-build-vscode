import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BROWSER_MCP_SERVERS,
  defaultBrowserMcpServers,
  explicitMcpServersValue,
  normalizeMcpServerConfig,
  resolveAcpMcpServersFromInspect
} from '../../src/host/transports/mcpServers.ts';

describe('DEFAULT_BROWSER_MCP_SERVERS', () => {
  it('includes chrome-devtools with autoConnect', () => {
    const cdt = DEFAULT_BROWSER_MCP_SERVERS.find((s) => s.name === 'chrome-devtools');
    assert.ok(cdt);
    assert.equal(cdt!.command, 'npx');
    assert.ok(cdt!.args?.includes('--autoConnect'));
    assert.ok(cdt!.args?.some((a) => a.includes('chrome-devtools-mcp')));
  });

  it('includes playwright mcp', () => {
    const pw = DEFAULT_BROWSER_MCP_SERVERS.find((s) => s.name === 'playwright');
    assert.ok(pw);
    assert.equal(pw!.command, 'npx');
    assert.ok(pw!.args?.some((a) => a.includes('@playwright/mcp')));
  });

  it('normalizeMcpServerConfig: unset → null (caller uses defaults)', () => {
    assert.equal(normalizeMcpServerConfig(undefined), null);
    assert.equal(normalizeMcpServerConfig(null), null);
    assert.equal(normalizeMcpServerConfig('nope'), null);
    assert.equal(normalizeMcpServerConfig({ name: 'x' }), null);
  });

  it('normalizeMcpServerConfig: explicit empty array → [] (no defaults)', () => {
    const n = normalizeMcpServerConfig([]);
    assert.ok(Array.isArray(n));
    assert.equal(n!.length, 0);
  });

  it('normalizeMcpServerConfig: all-invalid items → [] not null', () => {
    const n = normalizeMcpServerConfig([
      { name: '', command: 'echo' },
      { name: 'x' },
      null,
      'skip'
    ]);
    assert.ok(Array.isArray(n));
    assert.equal(n!.length, 0);
  });

  it('normalizeMcpServerConfig accepts valid entries and forces env array', () => {
    const n = normalizeMcpServerConfig([
      { name: 'x', command: 'echo', args: ['hi'] }
    ]);
    assert.ok(n);
    assert.equal(n![0].name, 'x');
    assert.deepEqual(n![0].args, ['hi']);
    // ACP requires env even when the user omits it
    assert.deepEqual(n![0].env, []);
  });

  it('defaultBrowserMcpServers includes env:[] on every server (ACP requirement)', () => {
    const a = defaultBrowserMcpServers();
    for (const s of a) {
      assert.ok(Array.isArray(s.env), `${s.name} missing env array`);
    }
    const b = defaultBrowserMcpServers();
    assert.notEqual(a[0].args, b[0].args);
    assert.deepEqual(a[0].args, b[0].args);
  });
});

describe('resolveAcpMcpServersFromInspect', () => {
  it('unset config → default browser stack', () => {
    const servers = resolveAcpMcpServersFromInspect(undefined);
    assert.equal(servers.length, DEFAULT_BROWSER_MCP_SERVERS.length);
    assert.deepEqual(
      servers.map((s) => s.name),
      DEFAULT_BROWSER_MCP_SERVERS.map((s) => s.name)
    );
    // empty inspect object is also unset
    const servers2 = resolveAcpMcpServersFromInspect({});
    assert.equal(servers2.length, DEFAULT_BROWSER_MCP_SERVERS.length);
  });

  it('explicit empty array → no servers (opt out)', () => {
    assert.deepEqual(
      resolveAcpMcpServersFromInspect({ workspaceValue: [] }),
      []
    );
    assert.deepEqual(
      resolveAcpMcpServersFromInspect({ globalValue: [] }),
      []
    );
    assert.deepEqual(
      resolveAcpMcpServersFromInspect({ workspaceFolderValue: [] }),
      []
    );
  });

  it('disableDefaultMcpServers with unset override → no servers', () => {
    assert.deepEqual(resolveAcpMcpServersFromInspect(undefined, true), []);
    assert.deepEqual(resolveAcpMcpServersFromInspect({}, true), []);
  });

  it('disableDefault still passes through explicit populated config', () => {
    const servers = resolveAcpMcpServersFromInspect(
      {
        workspaceValue: [{ name: 'only', command: 'true', args: [] }]
      },
      true
    );
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'only');
    assert.equal(servers[0].command, 'true');
  });

  it('populated override → as configured', () => {
    const servers = resolveAcpMcpServersFromInspect({
      workspaceValue: [
        { name: 'github', command: 'npx', args: ['-y', 'github-mcp'] }
      ]
    });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'github');
    assert.deepEqual(servers[0].env, []);
  });

  it('folder layer wins over workspace and global', () => {
    const servers = resolveAcpMcpServersFromInspect({
      workspaceFolderValue: [{ name: 'folder', command: 'echo' }],
      workspaceValue: [{ name: 'ws', command: 'echo' }],
      globalValue: [{ name: 'global', command: 'echo' }]
    });
    assert.equal(servers[0].name, 'folder');
  });

  it('workspace layer wins over global when folder unset', () => {
    const servers = resolveAcpMcpServersFromInspect({
      workspaceValue: [],
      globalValue: [{ name: 'global', command: 'echo' }]
    });
    assert.deepEqual(servers, []);
  });

  it('invalid explicit value → [] (fail closed, no silent defaults)', () => {
    assert.deepEqual(
      resolveAcpMcpServersFromInspect({ workspaceValue: 'not-an-array' }),
      []
    );
    assert.deepEqual(
      resolveAcpMcpServersFromInspect({
        workspaceValue: [{ name: '', command: '' }]
      }),
      []
    );
  });
});

describe('explicitMcpServersValue', () => {
  it('returns undefined when no user layer is set', () => {
    assert.equal(explicitMcpServersValue(undefined), undefined);
    assert.equal(explicitMcpServersValue({}), undefined);
  });

  it('prefers folder > workspace > global', () => {
    assert.deepEqual(
      explicitMcpServersValue({
        workspaceFolderValue: [1],
        workspaceValue: [2],
        globalValue: [3]
      }),
      [1]
    );
    assert.deepEqual(
      explicitMcpServersValue({ workspaceValue: [2], globalValue: [3] }),
      [2]
    );
    assert.deepEqual(explicitMcpServersValue({ globalValue: [3] }), [3]);
  });
});
