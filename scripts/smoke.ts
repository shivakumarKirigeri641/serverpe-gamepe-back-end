/**
 * Edge-case smoke test.
 *
 * Drives simulated WhatsApp webhooks against a locally running server and
 * asserts the awkward state transitions: a player messaging mid-game, trying to
 * join a second room, tapping a stale button from a finished round, and the
 * host walking out of a lobby.
 *
 * Run it against a server started WITHOUT WhatsApp credentials, so nothing is
 * actually sent:
 *
 *   WHATSAPP_ACCESS_TOKEN= npm run dev      # terminal 1
 *   npm run smoke                           # terminal 2
 *
 * It writes real rows to the configured database - point DATABASE_URL at a
 * scratch database if that matters to you.
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

async function send(waId: string, name: string, body: { text?: string; actionId?: string; mediaType?: string }) {
  n += 1;
  const m: Record<string, unknown> = { from: waId, id: `wamid.e.${Date.now()}.${n}`, timestamp: String(Math.floor(Date.now()/1000)) };
  if (body.mediaType) { m['type']=body.mediaType; m[body.mediaType]={ id: 'media-1', mime_type: 'image/jpeg' }; }
  else if (body.actionId) { m['type']='interactive'; m['interactive']={type:'list_reply',list_reply:{id:body.actionId,title:'tap'}}; }
  else { m['type']='text'; m['text']={body:body.text ?? ''}; }
  const payload = JSON.stringify({object:'whatsapp_business_account',entry:[{id:'s',changes:[{field:'messages',value:{
      messaging_product:'whatsapp', metadata:{phone_number_id:'s',display_phone_number:'s'},
      contacts:[{wa_id:waId,profile:{name}}], messages:[m]}}]}]});
  await fetch(URL_, { method:'POST', headers: signedHeaders(payload), body: payload });
  await new Promise(r => setTimeout(r, 850));
}

async function lastTo(waId: string): Promise<string> {
  const r = (await pool.query(
    `SELECT body FROM message_log WHERE wa_id=$1 AND direction='outbound' ORDER BY created_at DESC LIMIT 1`, [waId])).rows[0];
  return JSON.stringify(r?.body ?? {});
}
let failures = 0;
/**
 * Every player must accept the legal documents before they can start or join a
 * game, so the fixture does that first. This mirrors what a real player does on
 * their very first message.
 */
async function acceptTerms(waId: string, name: string): Promise<void> {
  await send(waId, name, { text: 'hi' });
  await send(waId, name, { actionId: 'legal:agree' });
}

const ok = (label: string, cond: boolean): void => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
};

const H = '919000000031', P1 = '919000000032', P2 = '919000000033', OUT = '919000000034';

for (const [waId, name] of [[H, 'Host'], [P1, 'P1'], [P2, 'P2'], [OUT, 'Outsider']] as const) {
  await acceptTerms(waId, name);
}
console.log('all fixtures accepted the terms\n');

// --- room A: host + 2 players, started ---
await send(H, 'Host', { text: 'hi' });
await send(H, 'Host', { actionId: 'menu:play:tambola' });
await send(H, 'Host', { actionId: 'count:tambola:3' });
const A = (await pool.query('SELECT id, room_code FROM games ORDER BY created_at DESC LIMIT 1')).rows[0];
await send(P1, 'P1', { text: `JOIN ${A.room_code}` });
await send(P2, 'P2', { text: `JOIN ${A.room_code}` });
await send(H, 'Host', { actionId: `start:${A.id}` });
console.log(`room A = ${A.room_code}, started\n`);

// --- an outsider opens a second room, so there is one to poach into ---
await send(OUT, 'Outsider', { actionId: 'menu:play:tambola' });
await send(OUT, 'Outsider', { actionId: 'count:tambola:2' });
const B = (await pool.query('SELECT id, room_code FROM games ORDER BY created_at DESC LIMIT 1')).rows[0];
console.log(`room B = ${B.room_code}, lobby\n`);

// 1. mid-game 'hi'
await send(P1, 'P1', { text: 'hi' });
const m1 = await lastTo(P1);
ok("mid-game 'hi' shows in-game menu, not welcome", m1.includes('playing in room') || m1.includes('Claim a prize'));
ok("mid-game 'hi' does NOT offer 'Play Tambola'", !m1.includes('Play Tambola'));

// 2. mid-game typed join of another room
await send(P1, 'P1', { text: `JOIN ${B.room_code}` });
ok('mid-game JOIN <other room> is refused', (await lastTo(P1)).includes('still playing in room'));

// 3. mid-game 'Join a game' menu button
await send(P1, 'P1', { actionId: 'menu:join' });
ok("mid-game 'Join a game' button is refused", (await lastTo(P1)).includes('leave'));

// 4. mid-game 'play'
await send(P1, 'P1', { text: 'play' });
const m4 = await lastTo(P1);
ok("mid-game 'play' refused without asking player count", !m4.includes('How many players'));

// 5. garbage mid-game
await send(P1, 'P1', { text: 'asdfgh qwerty' });
const m5 = await lastTo(P1);
ok('garbage mid-game returns the board, not the welcome menu', !m5.includes('Welcome to'));

// 6. still only in one game
const inGames = (await pool.query(
  `SELECT count(*)::int c FROM game_players gp JOIN games g ON g.id=gp.game_id
    WHERE gp.player_id=(SELECT id FROM players WHERE wa_id=$1) AND gp.left_at IS NULL
      AND g.status IN ('lobby','running')`, [P1])).rows[0];
ok('player is in exactly one active game', inGames.c === 1);

// 7. stale ack for a finished game
await pool.query("UPDATE games SET status='completed', ended_at=now() WHERE id=$1", [A.id]);
await send(P2, 'P2', { actionId: `ack:${A.id}:1:y` });
ok('ack on a finished game is refused', (await lastTo(P2)).includes('already finished'));
const junk = (await pool.query(
  `SELECT count(*)::int c FROM game_draw_responses WHERE game_id=$1 AND seq=1
     AND player_id=(SELECT id FROM players WHERE wa_id=$2)`, [A.id, P2])).rows[0];
ok('no response row written for the finished game', junk.c === 0);

// 8. host leaves a lobby -> someone inherits it
await send(P1, 'P1', { text: 'leave' });   // free P1 from room A (now completed anyway)
await send(P1, 'P1', { text: `JOIN ${B.room_code}` });
await send(OUT, 'Outsider', { text: 'leave' });
const bAfter = (await pool.query('SELECT host_player_id, status FROM games WHERE id=$1', [B.id])).rows[0];
const p1Id = (await pool.query('SELECT id FROM players WHERE wa_id=$1', [P1])).rows[0].id;
ok('host leaving a lobby promotes the next player', bAfter.host_player_id === p1Id);
ok('room B is still open', bAfter.status === 'lobby');
ok('new host is told they are host', (await lastTo(P1)).includes('host') || (await lastTo(P1)).includes('Start game'));

// 9. last player leaves -> room closes
await send(P1, 'P1', { text: 'leave' });
const bFinal = (await pool.query('SELECT status FROM games WHERE id=$1', [B.id])).rows[0];
ok('last player leaving cancels the room', bFinal.status === 'cancelled');


// 10. junk while being asked for a room code -> re-ask, do not drop the prompt
await send(OUT, 'Outsider', { text: 'hi' });
await send(OUT, 'Outsider', { actionId: 'menu:join' });
await send(OUT, 'Outsider', { text: 'what is this' });
ok('junk at the room-code prompt is re-asked', (await lastTo(OUT)).includes('does not look like a room code'));

// 11. well-formed but unknown code -> keep the prompt alive
await send(OUT, 'Outsider', { text: 'ZZZZZZ' });
const m11 = await lastTo(OUT);
ok('unknown room code keeps the prompt alive', m11.includes('No game found') && m11.includes('Send another code'));

// 12. the prompt really is still armed
await send(OUT, 'Outsider', { text: 'still nonsense' });
ok('prompt survives a second wrong answer', (await lastTo(OUT)).includes('does not look like a room code'));

// 13. a photo -> told we cannot read it, then re-offered the options
await send(OUT, 'Outsider', { text: 'menu' });
await send(OUT, 'Outsider', { mediaType: 'image' });
const m13 = await lastTo(OUT);
ok('a photo gets an answer with options', m13.includes('Play Tambola') || m13.includes('Welcome'));

// 14. unrecognised text outside a game is acknowledged, not silently menued
await send(OUT, 'Outsider', { text: 'blah blah' });
const logged = (await pool.query(
  `SELECT count(*)::int c FROM analytics_events
    WHERE event_type='command.unrecognised' AND wa_id=$1`, [OUT])).rows[0];
ok('unrecognised input is tracked for analytics', logged.c > 0);

console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`);
await pool.end();
process.exit(failures === 0 ? 0 : 1);
