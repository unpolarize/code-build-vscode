import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BROWSER_MCP_SERVERS,
  defaultBrowserMcpServers,
  normalizeMcpServerConfig
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

  it('normalizeMcpServerConfig falls back to null on empty', () => {
    assert.equal(normalizeMcpServerConfig([]), null);
    assert.equal(normalizeMcpServerConfig(undefined), null);
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
