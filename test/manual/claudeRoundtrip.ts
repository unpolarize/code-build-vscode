// Manual integration check: drive the REAL claude CLI through StreamJsonTransport.
// Run: npx tsx test/manual/claudeRoundtrip.ts
// Requires `claude` on PATH and a valid login. Sends one trivial prompt.
import { StreamJsonTransport } from '../../src/host/transports/streamJsonTransport';
import type { SessionUpdate } from '../../src/shared/acpTypes';

async function main() {
  const t = new StreamJsonTransport('manual-1', 'claude', {});
  const events: SessionUpdate[] = [];
  let assistantText = '';

  t.onEvent((u) => {
    events.push(u);
    if (u.kind === 'agent_message_chunk' && u.content.type === 'text') {
      assistantText += u.content.text;
    }
    console.log('[event]', u.kind, u.kind === 'agent_message_chunk' ? JSON.stringify(u.content) : '');
  });

  await t.start({ cwd: process.cwd(), mode: 'default' });
  await t.prompt([{ type: 'text', text: 'Reply with exactly the single word: PONG' }]);

  const done = await Promise.race([
    new Promise<boolean>((resolve) => {
      const off = t.onEvent((u) => {
        if (u.kind === 'result' || u.kind === 'error') {
          off();
          resolve(true);
        }
      });
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60000))
  ]);

  t.dispose();
  console.log('\n--- SUMMARY ---');
  console.log('completed:', done);
  console.log('assistant text:', JSON.stringify(assistantText.trim()));
  console.log('event kinds:', events.map((e) => e.kind).join(', '));
  const ok = done && /PONG/i.test(assistantText);
  console.log(ok ? '\n✅ PASS: real Claude round-trip via StreamJsonTransport' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
