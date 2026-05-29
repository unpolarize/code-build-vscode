// Manual integration check: drive the REAL codex binary through CodexTransport.
// This account's models are blocked, so we validate the spawn-per-prompt + NDJSON
// parsing path produces a clean normalized error + result (not a crash/hang).
// If your account permits a model, set CODEX_MODEL and expect a PONG instead.
import { CodexTransport } from '../../src/host/transports/codexTransport';
import type { SessionUpdate } from '../../src/shared/acpTypes';

async function main() {
  const t = new CodexTransport('manual-codex', 'codex', {});
  const events: SessionUpdate[] = [];
  let text = '';
  t.onEvent((u) => {
    events.push(u);
    if (u.kind === 'agent_message_chunk' && u.content.type === 'text') text += u.content.text;
    if (u.kind === 'error') console.log('[error]', u.message);
  });

  await t.start({ cwd: process.cwd(), mode: 'default', model: process.env.CODEX_MODEL });
  await t.prompt([{ type: 'text', text: 'Reply with exactly the single word: PONG' }]);
  t.dispose();

  console.log('\n--- SUMMARY ---');
  console.log('event kinds:', events.map((e) => e.kind).join(', '));
  console.log('assistant text:', JSON.stringify(text.trim()));

  const gotResult = events.some((e) => e.kind === 'result');
  const gotPong = /PONG/i.test(text);
  const gotCleanError = events.some((e) => e.kind === 'error' && !/^\{/.test(e.message));
  const ok = gotResult && (gotPong || gotCleanError);
  console.log(ok ? '\n✅ PASS: CodexTransport drives the real binary and normalizes events' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
