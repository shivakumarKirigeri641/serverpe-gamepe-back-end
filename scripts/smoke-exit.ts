/**
 * Exit-and-abandonment smoke test.
 *
 * Covers what happens when players walk out: the Exit option in the claim list,
 * its confirmation step, a game continuing when it still has enough players,
 * and the room closing when it drops below the minimum.
 *
 *   WHATSAPP_ACCESS_TOKEN= npm run dev      # terminal 1
 *   npm run smoke:exit                      # terminal 2
 */
import { createHmac } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';

const URL_ = `http://localhost:${env.PORT}${env.API_BASE_PATH}${env.WHATSAPP_WEBHOOK_PATH}`;
let n = 0;

function hdrs(p: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.WHATSAPP_APP_SECRET) {
    h['X-Hub-Signature-256'] = 'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update(p).digest('hex');
  }
  return h;
}

async function send(waId: string, body: { text?: string; actionId?: string }): Promise<void> {
  n += 1;
  const m: Record<string, unknown> = {
    from: waId,
    id: `wamid.x.${Date.now()}.${n}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  if (body.actionId) {
    m['type'] = 'interactive';
    m['interactive'] = { type: 'list_reply', list_reply: { id: body.actionId, title: 't' } };
  } else {
    m['type'] = 'text';
    m['text'] = { body: body.text ?? '' };
  }
  const p = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 's', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 's', display_phone_number: 's' },
      contacts: [{ wa_id: waId, profile: { name: 'T' } }],
      messages: [m],
    } }] }],
  });
  await fetch(URL_, { method: 'POST', headers: hdrs(p), body: p });
  await new Promise((r) => setTimeout(r, 800));
}

async function lastTo(waId: string): Promise<string> {
  const r = (await pool.query(
    `SELECT body FROM message_log WHERE wa_id=$1 AND direction='outbound' ORDER BY created_at DESC LIMIT 1`,
    [waId],
  )).rows[0];
  return JSON.stringify(r?.body ?? {});
}

let fails = 0;
const ok = (label: string, cond: boolean): void => {
  if (!cond) fails += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const A = '919000000061', B = '919000000062', C = '919000000063';
for (const u of [A, B, C]) {
  await pool.query('DELETE FROM players WHERE wa_id=$1', [u]);
  await send(u, { text: 'hi' });
  await send(u, { actionId: 'legal:agree' });
}

await send(A, { actionId: 'menu:play:tambola' });
await send(A, { actionId: 'count:tambola:3' });
await send(A, { actionId: 'plan:free_trial' });
const g = (await pool.query('SELECT id,room_code FROM games ORDER BY created_at DESC LIMIT 1')).rows[0];
await send(B, { text: `JOIN ${g.room_code}` });
await send(C, { text: `JOIN ${g.room_code}` });
await send(A, { actionId: `start:${g.id}` });
await new Promise((r) => setTimeout(r, 3000));

await send(B, { actionId: `claimmenu:${g.id}` });
ok('claim menu offers Exit game', (await lastTo(B)).includes('Exit game'));

await send(B, { actionId: `exit:${g.id}` });
ok('exit asks to confirm', (await lastTo(B)).includes('Yes, exit'));

await send(B, { actionId: `exitconfirm:${g.id}` });
ok('game continues while enough players remain',
   (await pool.query('SELECT status FROM games WHERE id=$1', [g.id])).rows[0].status === 'running');

await send(C, { actionId: `exitconfirm:${g.id}` });
ok('dropping below the minimum cancels the running game',
   (await pool.query('SELECT status FROM games WHERE id=$1', [g.id])).rows[0].status === 'cancelled');
ok('the remaining player is told the room closed', (await lastTo(A)).includes('closed'));

console.log(fails === 0 ? 'all checks passed' : `${fails} check(s) FAILED`);
await pool.end();
process.exit(fails === 0 ? 0 : 1);
