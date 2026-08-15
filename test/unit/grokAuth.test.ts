import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readGrokAuth, resolveXaiCreds, isExpired, xaiCredsLikely } from '../../src/host/voice/grokAuth';

function writeAuth(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-grok-auth-'));
  const p = path.join(dir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

test('readGrokAuth picks the newest entry that carries a key', () => {
  const p = writeAuth({
    'https://auth.x.ai::old': {
      key: 'old-token',
      create_time: '2026-01-01T00:00:00Z',
      email: 'old@x.ai'
    },
    'https://auth.x.ai::new': {
      key: 'new-token',
      create_time: '2026-08-01T00:00:00.123Z',
      email: 'new@x.ai',
      expires_at: '2027-01-01T00:00:00Z'
    },
    'https://auth.x.ai::keyless': { create_time: '2026-12-31T00:00:00Z' }
  });
  const creds = readGrokAuth(p);
  assert.ok(creds);
  assert.equal(creds.token, 'new-token');
  assert.equal(creds.email, 'new@x.ai');
  assert.equal(creds.source, 'grok');
  assert.ok(creds.expiresAt);
});

test('readGrokAuth returns undefined for missing or malformed files', () => {
  assert.equal(readGrokAuth('/nonexistent/auth.json'), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-grok-auth-'));
  const p = path.join(dir, 'auth.json');
  fs.writeFileSync(p, 'not json');
  assert.equal(readGrokAuth(p), undefined);
});

test('isExpired respects expires_at', () => {
  const now = new Date('2026-08-14T00:00:00Z');
  assert.equal(isExpired({ token: 't', source: 'grok' }, now), false);
  assert.equal(
    isExpired({ token: 't', source: 'grok', expiresAt: new Date('2026-08-13T00:00:00Z') }, now),
    true
  );
  assert.equal(
    isExpired({ token: 't', source: 'grok', expiresAt: new Date('2026-08-15T00:00:00Z') }, now),
    false
  );
});

test('resolveXaiCreds: explicit key wins over subscription login', () => {
  const p = writeAuth({
    'https://auth.x.ai::a': { key: 'sub-token', create_time: '2026-08-01T00:00:00Z' }
  });
  const viaSetting = resolveXaiCreds({ settingKey: 'my-key', env: {}, authPath: p });
  assert.equal(viaSetting?.token, 'my-key');
  assert.equal(viaSetting?.source, 'apiKey');

  const viaEnv = resolveXaiCreds({ env: { XAI_API_KEY: 'env-key' }, authPath: p });
  assert.equal(viaEnv?.token, 'env-key');

  const viaAuth = resolveXaiCreds({ env: {}, authPath: p });
  assert.equal(viaAuth?.token, 'sub-token');
  assert.equal(viaAuth?.source, 'grok');
});

test('xaiCredsLikely: key, env, or auth.json presence', () => {
  const p = writeAuth({});
  assert.equal(xaiCredsLikely({ settingKey: 'k', env: {} }), true);
  assert.equal(xaiCredsLikely({ env: { XAI_API_KEY: 'k' } }), true);
  assert.equal(xaiCredsLikely({ env: {}, authPath: p }), true);
  assert.equal(xaiCredsLikely({ env: {}, authPath: '/nonexistent/auth.json' }), false);
});
