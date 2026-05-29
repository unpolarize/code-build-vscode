// Manual integration check: real Grok permission round-trip through AcpTransport.
// Asks Grok to write a file in `default` mode; auto-approves the permission request;
// verifies the file lands on disk. Run: npx tsx test/manual/grokPermission.ts
import { AcpTransport } from '../../src/host/transports/acpTransport';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuild-perm-'));
  const target = path.join(dir, 'hello.txt');

  const t = new AcpTransport('manual-perm', 'grok', {});
  let sawPermission = false;

  t.onEvent((u) => {
    console.log('[event]', u.kind);
    if (u.kind === 'permission_request') {
      sawPermission = true;
      const allow = u.options.find((o) => o.kind.startsWith('allow')) ?? u.options[0];
      console.log('  -> auto-approving with option', allow?.name);
      t.respondPermission(u.requestId, { outcome: 'selected', optionId: allow.optionId });
    }
  });

  await t.start({ cwd: dir, mode: 'default' });
  await t.prompt([
    {
      type: 'text',
      text: `Create a file named hello.txt in the current directory containing exactly: HELLO. Do not ask follow-up questions.`
    }
  ]);

  // give any trailing fs work a moment
  await new Promise((r) => setTimeout(r, 1500));
  t.dispose();

  const exists = fs.existsSync(target);
  const content = exists ? fs.readFileSync(target, 'utf8').trim() : '';
  console.log('\n--- SUMMARY ---');
  console.log('saw permission request:', sawPermission);
  console.log('file created:', exists, 'content:', JSON.stringify(content));
  const ok = sawPermission && exists && /HELLO/.test(content);
  console.log(ok ? '\n✅ PASS: ACP permission round-trip + file write' : '\n⚠️  PARTIAL (see summary)');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
