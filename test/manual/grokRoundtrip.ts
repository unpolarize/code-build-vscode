// Manual integration check: drive the REAL grok CLI through AcpTransport (ACP).
// Run: npx tsx test/manual/grokRoundtrip.ts
import { AcpTransport } from '../../src/host/transports/acpTransport';
import type { SessionUpdate } from '../../src/shared/acpTypes';

async function main() {
  const t = new AcpTransport('manual-grok', 'grok', {});
  const events: SessionUpdate[] = [];
  let text = '';
  t.onEvent((u) => {
    events.push(u);
    if (u.kind === 'agent_message_chunk' && u.content.type === 'text') text += u.content.text;
    console.log('[event]', u.kind, u.kind === 'agent_message_chunk' ? JSON.stringify(u.content.text) : '');
  });

  await t.start({ cwd: process.cwd(), mode: 'default' });
  console.log('[started] session ready');
  await t.prompt([{ type: 'text', text: 'Reply with exactly the single word: PONG' }]);

  t.dispose();
  console.log('\n--- SUMMARY ---');
  console.log('assistant text:', JSON.stringify(text.trim()));
  console.log('event kinds:', events.map((e) => e.kind).join(', '));
  const ok = /PONG/i.test(text) && events.some((e) => e.kind === 'result');
  console.log(ok ? '\n✅ PASS: real Grok round-trip via AcpTransport' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
