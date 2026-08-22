import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AcpMcpServer } from '../../src/host/transports/mcpServers.ts';
import {
  DEFAULT_SCHEMA_TOKEN_TABLE,
  applyMcpSchemaBudget,
  estimateSchemaTokensFromTools,
  resolveSchemaTokenCost,
  toAcpMcpPayload
} from '../../src/host/transports/mcpSchemaBudget.ts';
import {
  defaultBrowserMcpServers,
  normalizeMcpServerConfig
} from '../../src/host/transports/mcpServers.ts';

function server(
  name: string,
  extra?: Partial<AcpMcpServer>
): AcpMcpServer {
  return { name, command: 'npx', args: ['-y', name], env: [], ...extra };
}

describe('estimateSchemaTokensFromTools', () => {
  it('ceil(stableStringify length / 4)', () => {
    assert.equal(estimateSchemaTokensFromTools([]), Math.ceil('[]'.length / 4));
    // Object key order must not change the estimate.
    const a = estimateSchemaTokensFromTools({ z: 1, a: 2 });
    const b = estimateSchemaTokensFromTools({ a: 2, z: 1 });
    assert.equal(a, b);
  });
});

describe('resolveSchemaTokenCost', () => {
  it('prefers per-server schemaTokens, then overrides, then static table', () => {
    assert.deepEqual(resolveSchemaTokenCost(server('chrome-devtools')), {
      name: 'chrome-devtools',
      tokens: 5811,
      known: true,
      exempt: false
    });
    assert.equal(
      resolveSchemaTokenCost(server('chrome-devtools', { schemaTokens: 100 })).tokens,
      100
    );
    assert.equal(
      resolveSchemaTokenCost(server('chrome-devtools'), { 'chrome-devtools': 42 }).tokens,
      42
    );
    // per-server field wins over overrides map
    assert.equal(
      resolveSchemaTokenCost(server('chrome-devtools', { schemaTokens: 7 }), {
        'chrome-devtools': 42
      }).tokens,
      7
    );
  });

  it('unknown names are fail-open (known=false)', () => {
    const c = resolveSchemaTokenCost(server('mystery'));
    assert.equal(c.known, false);
    assert.equal(c.tokens, undefined);
  });

  it('kp is exempt', () => {
    assert.equal(resolveSchemaTokenCost(server('kp')).exempt, true);
  });
});

describe('applyMcpSchemaBudget knapsack', () => {
  it('fixture {a:1000,b:4000,c:3000} budget 6000 pri a>b>c → {a,b}, defer c', () => {
    const servers = [
      server('a', { schemaTokens: 1000 }),
      server('b', { schemaTokens: 4000 }),
      server('c', { schemaTokens: 3000 })
    ];
    const r = applyMcpSchemaBudget(servers, {
      budget: 6000,
      priority: ['a', 'b', 'c']
    });
    assert.deepEqual(
      r.included.map((s) => s.name),
      ['a', 'b']
    );
    assert.deepEqual(
      r.deferred.map((s) => s.name),
      ['c']
    );
  });

  it('oversize solo:7000 → include {}, warn once', () => {
    const servers = [server('solo', { schemaTokens: 7000 })];
    const r = applyMcpSchemaBudget(servers, { budget: 6000 });
    assert.deepEqual(r.included, []);
    assert.deepEqual(
      r.deferred.map((s) => s.name),
      ['solo']
    );
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /oversize 'solo'/);
  });

  it('default-stack fixture CDT=5811 PW=4617 budget 6000 → chrome-devtools only (+kp if present)', () => {
    const base = defaultBrowserMcpServers();
    assert.equal(DEFAULT_SCHEMA_TOKEN_TABLE['chrome-devtools'], 5811);
    assert.equal(DEFAULT_SCHEMA_TOKEN_TABLE.playwright, 4617);

    const r = applyMcpSchemaBudget(base, { budget: 6000 });
    assert.deepEqual(
      r.included.map((s) => s.name),
      ['chrome-devtools']
    );
    assert.deepEqual(
      r.deferred.map((s) => s.name),
      ['playwright']
    );
    assert.equal(
      r.logLine,
      'MCP schema budget: included=[chrome-devtools(~5811)] deferred=[playwright(~4617)] budget=6000'
    );

    const withKp = [...base, server('kp', { env: [{ name: 'KP_ROOT', value: '/tmp' }] })];
    const r2 = applyMcpSchemaBudget(withKp, { budget: 6000 });
    assert.deepEqual(
      r2.included.map((s) => s.name),
      ['chrome-devtools', 'kp']
    );
    assert.deepEqual(
      r2.deferred.map((s) => s.name),
      ['playwright']
    );
    // kp does not consume budget — still room math based on CDT only
    assert.match(r2.logLine, /included=\[chrome-devtools\(~5811\),kp\(/);
  });

  it('fail-open unknown-cost inclusion', () => {
    const servers = [
      server('chrome-devtools'),
      server('mystery'),
      server('playwright')
    ];
    const r = applyMcpSchemaBudget(servers, { budget: 6000 });
    assert.ok(r.included.some((s) => s.name === 'mystery'));
    assert.ok(r.included.some((s) => s.name === 'chrome-devtools'));
    assert.ok(r.deferred.some((s) => s.name === 'playwright'));
    assert.ok(r.warnings.some((w) => /mystery/.test(w) && /unknown/.test(w)));
  });

  it('budget 0 → byte-identity (same names + env arrays)', () => {
    const servers = defaultBrowserMcpServers();
    const r = applyMcpSchemaBudget(servers, { budget: 0 });
    assert.deepEqual(
      r.included.map((s) => s.name),
      servers.map((s) => s.name)
    );
    assert.equal(r.deferred.length, 0);
    for (let i = 0; i < servers.length; i++) {
      assert.deepEqual(r.included[i]!.env, servers[i]!.env);
      assert.equal(r.included[i], servers[i]); // same references
    }
  });

  it('higher priority never dropped to fit lower', () => {
    // b costs 5000, a costs 2000; priority b>a; budget 6000 → b only (a deferred)
    const servers = [
      server('a', { schemaTokens: 2000 }),
      server('b', { schemaTokens: 5000 })
    ];
    const r = applyMcpSchemaBudget(servers, {
      budget: 6000,
      priority: ['b', 'a']
    });
    assert.deepEqual(
      r.included.map((s) => s.name),
      ['b']
    );
    assert.deepEqual(
      r.deferred.map((s) => s.name),
      ['a']
    );
  });

  it('preserves original input order in included/deferred lists', () => {
    const servers = [
      server('c', { schemaTokens: 1000 }),
      server('a', { schemaTokens: 1000 }),
      server('b', { schemaTokens: 1000 })
    ];
    const r = applyMcpSchemaBudget(servers, {
      budget: 6000,
      priority: ['a', 'b', 'c']
    });
    assert.deepEqual(
      r.included.map((s) => s.name),
      ['c', 'a', 'b']
    );
  });

  it('explicit empty list stays empty — budget never re-injects defaults', () => {
    const r = applyMcpSchemaBudget([], { budget: 6000 });
    assert.deepEqual(r.included, []);
    assert.deepEqual(r.deferred, []);
  });
});

describe('toAcpMcpPayload env-array preservation', () => {
  it('strips schemaTokens and always emits env arrays', () => {
    const servers: AcpMcpServer[] = [
      {
        name: 'x',
        command: 'echo',
        schemaTokens: 99,
        env: [{ name: 'A', value: '1' }]
      },
      { name: 'y', command: 'echo', env: [] }
    ];
    const payload = toAcpMcpPayload(servers);
    assert.equal('schemaTokens' in payload[0]!, false);
    assert.deepEqual(payload[0]!.env, [{ name: 'A', value: '1' }]);
    assert.deepEqual(payload[1]!.env, []);
  });
});

describe('normalizeMcpServerConfig schemaTokens', () => {
  it('preserves non-negative schemaTokens from raw config', () => {
    const n = normalizeMcpServerConfig([
      { name: 'x', command: 'echo', schemaTokens: 123.9 },
      { name: 'y', command: 'echo', schemaTokens: -1 },
      { name: 'z', command: 'echo' }
    ]);
    assert.equal(n![0]!.schemaTokens, 123);
    assert.equal(n![1]!.schemaTokens, undefined);
    assert.equal(n![2]!.schemaTokens, undefined);
  });
});
