// /kp task-picker contracts (kp: tasks/cb-kp-task-picker-start-a-session-from-a-kp-item):
// implementable-JSON parsing (bare array AND away shape), pack-primer framing,
// the link-once latch, CLI-path validation, and builtin registration. All pure
// (mocked-spawn output as strings) — the host spawn itself is thin plumbing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KpLinkLatch,
  formatKpPackPrimer,
  parseImplementableJson,
  resolveKpCliPath
} from '../../src/shared/kpClient';
import { BUILTIN_COMMANDS, BUILTIN_NAMES } from '../../webview-ui/src/builtinCommands';

describe('parseImplementableJson', () => {
  it('parses the bare-array shape with the pinned row contract', () => {
    const raw = JSON.stringify([
      {
        id: 'ideas/cb-foo',
        priority: 'p1',
        title: 'CB: foo',
        project: 'projects/code-build',
        target_repo: 'code-build-vscode',
        extra: 'ignored'
      },
      { id: 'tasks/kp-bar', priority: null, title: 'KP: bar', project: null, target_repo: null }
    ]);
    const out = parseImplementableJson(raw);
    assert.equal(out.away, false);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows[0], {
      id: 'ideas/cb-foo',
      priority: 'p1',
      title: 'CB: foo',
      project: 'projects/code-build',
      targetRepo: 'code-build-vscode'
    });
    assert.equal(out.rows[1].priority, null);
    assert.equal(out.rows[1].targetRepo, null);
  });

  it('parses the away shape ({away:true, rows:[]}) instead of crashing', () => {
    const out = parseImplementableJson('{"away":true,"rows":[]}');
    assert.equal(out.away, true);
    assert.deepEqual(out.rows, []);
  });

  it('drops malformed rows but keeps valid ones', () => {
    const out = parseImplementableJson('[{"id":"ideas/x","title":"X"}, {"nope":1}, null, "str"]');
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].id, 'ideas/x');
  });

  it('falls back to the id when title is missing', () => {
    const out = parseImplementableJson('[{"id":"tasks/y"}]');
    assert.equal(out.rows[0].title, 'tasks/y');
  });

  it('throws one clear error on non-JSON output', () => {
    assert.throws(() => parseImplementableJson('command not found: kp'), /non-JSON/);
  });

  it('throws on an unrecognized JSON shape', () => {
    assert.throws(() => parseImplementableJson('{"rows":[]}'), /unrecognized/);
  });
});

describe('formatKpPackPrimer', () => {
  it('frames the pack with the item id and keeps the (kp: id) trailer', () => {
    const pack = '# Item briefing\n…body…\n\n(kp: ideas/cb-foo)';
    const primer = formatKpPackPrimer(pack, 'ideas/cb-foo');
    assert.ok(primer.startsWith('<planning-item-pack id="ideas/cb-foo">'));
    assert.ok(primer.includes('(kp: ideas/cb-foo)'));
    assert.ok(primer.trimEnd().endsWith('</planning-item-pack>'));
  });

  it('returns empty string for an empty pack (caller surfaces the error)', () => {
    assert.equal(formatKpPackPrimer('   \n', 'ideas/cb-foo'), '');
  });
});

describe('KpLinkLatch (link-once guard)', () => {
  it('consumes exactly once — resume/reload cannot re-link', () => {
    const latch = new KpLinkLatch();
    latch.arm('ideas/cb-foo');
    assert.equal(latch.armed, true);
    assert.equal(latch.consume(), 'ideas/cb-foo');
    assert.equal(latch.armed, false);
    // Second native-id landing (respawn, reload) finds nothing to fire.
    assert.equal(latch.consume(), undefined);
  });

  it('re-arming replaces the previous item; clear() disarms', () => {
    const latch = new KpLinkLatch();
    latch.arm('ideas/a');
    latch.arm('ideas/b');
    assert.equal(latch.consume(), 'ideas/b');
    latch.arm('ideas/c');
    latch.clear();
    assert.equal(latch.consume(), undefined);
  });
});

describe('resolveKpCliPath', () => {
  it('rejects unset / bare node / the node binary itself', () => {
    const node = '/usr/local/bin/node';
    assert.equal(resolveKpCliPath(undefined, node), undefined);
    assert.equal(resolveKpCliPath('  ', node), undefined);
    assert.equal(resolveKpCliPath('node', node), undefined);
    assert.equal(resolveKpCliPath(node, node), undefined);
  });

  it('accepts an absolute CLI script path', () => {
    assert.equal(
      resolveKpCliPath('/x/knowledge-planning/dist/cli.js', '/usr/local/bin/node'),
      '/x/knowledge-planning/dist/cli.js'
    );
  });
});

describe('/kp builtin registration', () => {
  it('is registered so the webview intercepts it (never forwarded to the agent)', () => {
    assert.ok(BUILTIN_NAMES.has('kp'));
    const cmd = BUILTIN_COMMANDS.find((c) => c.name === 'kp');
    assert.ok(cmd);
    assert.match(cmd!.description, /knowledge-planning/i);
  });
});
