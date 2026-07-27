// Shared preview helpers (webview-ui/src/toolPreview.ts) — extracted from
// ToolCard so the PermissionPrompt reuses the SAME classify/preview logic.
// Pure and DOM-free, so they run under node --test directly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolCall } from '../../src/shared/acpTypes';
import { classifyTool, commandPreview, rawCommand, capText } from '../../webview-ui/src/toolPreview';

const bash = (command: string, extra?: Partial<ToolCall>): ToolCall => ({
  toolCallId: 't',
  title: 'Bash',
  status: 'pending',
  rawInput: { command },
  ...extra
});

describe('rawCommand', () => {
  it('returns the verbatim command for Bash-style tools', () => {
    assert.equal(rawCommand(bash('git status\n && ls')), 'git status\n && ls');
  });

  it('supports execute-kind tools with adapter-specific titles (permission payloads)', () => {
    const tool: ToolCall = {
      toolCallId: 't',
      title: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { cmd: 'echo hi' }
    };
    assert.equal(rawCommand(tool), 'echo hi');
  });

  it('returns null when rawInput is missing or not a command', () => {
    assert.equal(rawCommand({ toolCallId: 't', title: 'Bash', status: 'pending' }), null);
    assert.equal(rawCommand({ toolCallId: 't', title: 'Read', status: 'pending', rawInput: { command: 'x' } }), null);
  });
});

describe('classifyTool destructive badges', () => {
  it('flags rm -rf as warn', () => {
    assert.deepEqual(classifyTool(bash('rm -rf /tmp/x')), { badge: '⚠ rm -rf', severity: 'warn' });
  });
  it('flags git push as warn', () => {
    assert.equal(classifyTool(bash('git push origin main'))?.severity, 'warn');
  });
  it('returns null for benign commands', () => {
    assert.equal(classifyTool(bash('ls -la')), null);
  });
});

describe('commandPreview', () => {
  it('collapses whitespace and caps at 80 chars', () => {
    const p = commandPreview(bash('echo ' + 'x'.repeat(200)));
    assert.ok(p && p.length === 80 && p.endsWith('…'));
    assert.ok(!p.includes('\n'));
  });
});

describe('capText size cap', () => {
  it('passes small payloads through untouched', () => {
    assert.equal(capText('short'), 'short');
  });
  it('truncates oversized payloads with a marker', () => {
    const capped = capText('a'.repeat(10_000));
    assert.ok(capped.length < 4200);
    assert.ok(capped.includes('[truncated'));
  });
});

describe('classifyTool on execute-kind permission payloads', () => {
  it('badges rm -rf even when the title is adapter-specific (kind: execute)', () => {
    const tool: ToolCall = {
      toolCallId: 't',
      title: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rm -rf /' }
    };
    assert.equal(classifyTool(tool)?.severity, 'warn');
  });
});
