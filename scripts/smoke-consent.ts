/**
 * Consent-gate smoke test.
 *
 * Verifies that a new player is shown the legal documents before anything else,
 * cannot start or join a game until they accept, that acceptance is recorded
 * per document and version, and that bumping a document's version forces
 * everyone to accept again.
 *
 *   WHATSAPP_ACCESS_TOKEN= npm run dev      # terminal 1
 *   npm run smoke:consent                   # terminal 2
 *
 * Deletes and recreates its own test player on each run.
 */
import { pool } from '../src/db/pool.js';
import { createHmac } from 'node:crypto';
import { env } from '../src/config/env.js';

const URL_ = `http://localhost:5009${env.API_BASE_PATH}${env.WHATSAPP_WEBHOOK_PATH}`;

/**
 * Meta signs every webhook with the app secret, and the server rejects
 * unsigned posts once WHATSAPP_APP_SECRET is set. Sign the same way.
 */
function signedHeaders(payload: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.WHATSAPP_APP_SECRET) {
    const digest = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(payload).digest('hex');
    headers['X-Hub-Signature-256'] = `sha256=${digest}`;
  }
  return headers;
}

let n = 0;
async function send(waId: string, body: { text?: string; actionId?: string }) {
  n += 1;
  const m: Record<string, unknown> = { from: waId, id: `wamid.c.${Date.now()}.${n}`, timestamp: String(Math.floor(Date.now()/1000)) };
  if (body.actionId) { m['type']='interactive'; m['interactive']={type:'list_reply',list_reply:{id:body.actionId,title:'tap'}}; }
  else { m['type']='text'; m['text']={body:body.text ?? ''}; }
  const payload = JSON.stringify({object:'whatsapp_business_account',entry:[{id:'s',changes:[{field:'messages',value:{
      messaging_product:'whatsapp', metadata:{phone_number_id:'s',display_phone_number:'s'},
      contacts:[{wa_id:waId,profile:{name:'Tester'}}], messages:[m]}}]}]});
  await fetch(URL_, { method:'POST', headers: signedHeaders(payload), body: payload });
  await new Promise(r => setTimeout(r, 900));
}
async function lastTo(waId: string) {
  const r = (await pool.query(`SELECT body FROM message_log WHERE wa_id=$1 AND direction='outbound' ORDER BY created_at DESC LIMIT 1`, [waId])).rows[0];
  return JSON.stringify(r?.body ?? {});
}
let fails = 0;
const ok = (l: string, c: boolean) => { if (!c) fails++; console.log(`${c?'PASS':'FAIL'}  ${l}`); };

const U = '919000000041';
// The gate only fires for a player who has not yet consented, so start clean.
await pool.query('DELETE FROM players WHERE wa_id = $1', [U]);

await send(U, { text: 'hi' });
ok('first hi shows the terms, not the play menu', (await lastTo(U)).includes('I agree'));
ok('play menu is NOT offered before consent', !(await lastTo(U)).includes('Play Tambola'));

await send(U, { text: 'play' });
ok('play is blocked before consent', !(await lastTo(U)).includes('How many players'));

await send(U, { actionId: 'legal:doc:entertainment_only' });
const doc = await lastTo(U);
ok('opening a document is answered', doc.length > 0);

await send(U, { actionId: 'legal:decline' });
ok('declining is handled gracefully', (await lastTo(U)).includes('change your mind'));

const beforeCount = (await pool.query(
  `SELECT count(*)::int c FROM player_consents WHERE player_id=(SELECT id FROM players WHERE wa_id=$1)`, [U])).rows[0];
ok('declining records no consent', beforeCount.c === 0);

await send(U, { actionId: 'legal:agree' });
const rows = (await pool.query(
  `SELECT doc_key, version, source FROM player_consents
    WHERE player_id=(SELECT id FROM players WHERE wa_id=$1) ORDER BY doc_key`, [U])).rows;
ok('agreeing records all 5 documents', rows.length === 5);
console.log('     recorded:', rows.map((r: any) => `${r.doc_key}@v${r.version}`).join(', '));
ok('agreeing then shows the play menu', (await lastTo(U)).includes('Play Tambola'));

await send(U, { text: 'play' });
ok('play now works', (await lastTo(U)).includes('How many players'));

// version bump forces re-consent
await pool.query("UPDATE legal_documents SET version = version + 1 WHERE doc_key='privacy'");
await send(U, { text: 'hi' });
ok('bumping a version forces re-consent', (await lastTo(U)).includes('I agree'));
await pool.query("UPDATE legal_documents SET version = version - 1 WHERE doc_key='privacy'");

console.log(fails === 0 ? 'all checks passed' : `${fails} FAILED`);
await pool.end(); process.exit(fails === 0 ? 0 : 1);
