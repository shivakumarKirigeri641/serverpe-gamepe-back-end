import PDFDocument from 'pdfkit';
import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';
import { appTimeString } from '../utils/time.js';
import { publicName } from './player.service.js';
import { storeDocument } from './document.service.js';
import { useFonts } from './report-fonts.js';

/**
 * The host's report on a room they ran.
 *
 * A separate document from the player report because the host is asking a
 * different question. A player wants to know how they did; a host wants to know
 * how the *room* did — who turned up, who stayed, who went quiet, how long it
 * ran, and whether it is worth running another one. Putting both in one PDF
 * meant the host had to read past their own ticket to find any of it.
 *
 * The host also played, so they still receive the player report as well. This
 * is the second document, not a replacement.
 *
 * Privacy holds here exactly as everywhere else: the host sees who played by
 * display name or anonymous tag, never by phone number. Hosting a room does not
 * earn anyone the right to their friends' numbers.
 */

const COLOR = {
  maroon: '#7d0f22',
  ink: '#1e2733',
  muted: '#6b7684',
  line: '#dfe4ea',
  green: '#1f9d55',
  amber: '#b8860b',
  red: '#b3122b',
  panel: '#f6f3ef',
};

const PRIZE_LABELS: Readonly<Record<string, string>> = {
  early_five: 'Early Five',
  top_line: 'Top Line',
  middle_line: 'Middle Line',
  bottom_line: 'Bottom Line',
  four_corners: 'Four Corners',
  full_house: 'Full House',
};

interface HostGameRow {
  room_code: string;
  status: string;
  game_key: string;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  expected_players: number | null;
  plan_key: string | null;
  charged_paise: number | null;
  numbers: number;
}

interface HostPlayerRow {
  player_id: string;
  display_name: string | null;
  joined_at: Date;
  left_at: Date | null;
  answered: number;
  prizes: number;
  median_ms: number | null;
}

const minutesBetween = (a: Date | null, b: Date | null): number | null =>
  a && b ? Math.max(Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000), 0) : null;

async function gatherHostData(gameId: string) {
  const game = await queryOne<HostGameRow>(
    `SELECT g.room_code, g.status, g.game_key, g.created_at, g.started_at, g.ended_at,
            g.expected_players, g.plan_key, g.charged_paise,
            (SELECT count(*)::int FROM game_draws d WHERE d.game_id = g.id) AS numbers
       FROM games g WHERE g.id = $1`,
    [gameId],
  );
  if (!game) return null;

  const players = await query<HostPlayerRow>(
    `SELECT gp.player_id, p.display_name, gp.joined_at, gp.left_at,
            (SELECT count(*)::int FROM game_draw_responses r
              WHERE r.game_id = gp.game_id AND r.player_id = gp.player_id) AS answered,
            (SELECT count(*)::int FROM game_claims c
              WHERE c.game_id = gp.game_id AND c.player_id = gp.player_id AND c.status = 'awarded') AS prizes,
            (SELECT percentile_cont(0.5) WITHIN GROUP (
                      ORDER BY EXTRACT(EPOCH FROM (r.responded_at - d.drawn_at)) * 1000)
               FROM game_draw_responses r
               JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
              WHERE r.game_id = gp.game_id AND r.player_id = gp.player_id) AS median_ms
       FROM game_players gp
       JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1
      ORDER BY gp.joined_at`,
    [gameId],
  );

  const claims = await query<{ claim_type: string; player_id: string; display_name: string | null }>(
    `SELECT c.claim_type, c.player_id, p.display_name
       FROM game_claims c JOIN players p ON p.id = c.player_id
      WHERE c.game_id = $1 AND c.status = 'awarded'
      ORDER BY c.created_at`,
    [gameId],
  );

  const rejected = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM game_claims WHERE game_id = $1 AND status <> 'awarded'`,
    [gameId],
  );

  return { game, players, claims, rejectedClaims: Number(rejected?.n ?? 0) };
}

/* ------------------------------------------------------------------ drawing */

function sectionTitle(doc: PDFKit.PDFDocument, fonts: ReturnType<typeof useFonts>, text: string, top: number): number {
  doc.fillColor(COLOR.ink).fontSize(12).font(fonts.bold).text(text, 40, top);
  doc.moveTo(40, top + 17).lineTo(555, top + 17).lineWidth(1).strokeColor(COLOR.line).stroke();
  return top + 26;
}

function tile(
  doc: PDFKit.PDFDocument,
  fonts: ReturnType<typeof useFonts>,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  accent = COLOR.maroon,
): void {
  doc.roundedRect(x, y, w, 54, 8).fill(COLOR.panel);
  doc.fillColor(accent).fontSize(19).font(fonts.bold).text(value, x, y + 9, { width: w, align: 'center' });
  doc.fillColor(COLOR.muted).fontSize(8).font(fonts.regular).text(label, x, y + 34, { width: w, align: 'center' });
}

/* ------------------------------------------------------------------- render */

export interface HostReport {
  buffer: Buffer;
  filename: string;
  docNumber: string;
}

export async function buildHostReport(
  hostPlayerId: string,
  hostWaId: string,
  gameId: string,
): Promise<HostReport | null> {
  const data = await gatherHostData(gameId);
  if (!data) return null;

  const { game, players, claims, rejectedClaims } = data;

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `${env.BRAND_NAME} host report - ${game.room_code}` },
  });
  const fonts = useFonts(doc, 'latin');

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  /* header */
  doc.rect(0, 0, 595, 90).fill(COLOR.maroon);
  doc.fillColor('#ffffff').fontSize(22).font(fonts.bold).text(env.BRAND_NAME, 40, 24);
  doc.fontSize(12).font(fonts.regular).text(`Host report — room ${game.room_code}`, 40, 52);
  doc.fontSize(8).text(appTimeString(), 40, 70, { width: 515, align: 'right' });

  let y = 108;

  /* headline numbers */
  const seated = players.filter((p) => !p.left_at).length;
  const left = players.length - seated;
  const duration = minutesBetween(game.started_at, game.ended_at);
  const answeredTotal = players.reduce((sum, p) => sum + p.answered, 0);
  const possible = players.length * game.numbers;
  const engagement = possible > 0 ? Math.round((answeredTotal / possible) * 100) : 0;

  const w = (515 - 3 * 10) / 4;
  tile(doc, fonts, 40, y, w, 'Players joined', String(players.length));
  tile(doc, fonts, 40 + (w + 10), y, w, 'Stayed to the end', String(seated), left > 0 ? COLOR.amber : COLOR.green);
  tile(doc, fonts, 40 + 2 * (w + 10), y, w, 'Numbers called', String(game.numbers));
  tile(doc, fonts, 40 + 3 * (w + 10), y, w, 'Minutes', duration === null ? '—' : String(duration));
  y += 68;

  tile(doc, fonts, 40, y, w, 'Answered', `${engagement}%`, engagement >= 60 ? COLOR.green : COLOR.amber);
  tile(doc, fonts, 40 + (w + 10), y, w, 'Prizes claimed', String(claims.length));
  tile(doc, fonts, 40 + 2 * (w + 10), y, w, 'Invalid claims', String(rejectedClaims), rejectedClaims ? COLOR.red : COLOR.muted);
  tile(doc, fonts, 40 + 3 * (w + 10), y, w, 'Cost to you', game.charged_paise ? `Rs ${(game.charged_paise / 100).toFixed(0)}` : 'Free');
  y += 76;

  /* how the room went */
  y = sectionTitle(doc, fonts, 'How the room went', y);

  const rows: [string, string][] = [
    ['Status', game.status === 'completed' ? 'Played to the end' : game.status],
    ['Expected players', game.expected_players ? String(game.expected_players) : 'Not stated'],
    ['Actually joined', `${players.length}${game.expected_players ? ` of ${game.expected_players}` : ''}`],
    ['Left before the end', left === 0 ? 'Nobody' : `${left} player${left === 1 ? '' : 's'}`],
    ['Plan', game.plan_key ?? 'free_trial'],
  ];
  doc.fontSize(10);
  for (const [k, v] of rows) {
    doc.fillColor(COLOR.muted).font(fonts.regular).text(k, 40, y, { width: 300 });
    doc.fillColor(COLOR.ink).font(fonts.bold).text(v, 340, y, { width: 215, align: 'right' });
    y += 16;
  }

  /* every player */
  y = sectionTitle(doc, fonts, 'Every player in this room', y + 12);

  doc.fontSize(9).fillColor(COLOR.muted).font(fonts.bold);
  doc.text('Player', 40, y).text('Answered', 250, y).text('Speed', 340, y).text('Prizes', 420, y).text('Stayed', 490, y);
  y += 14;
  doc.moveTo(40, y - 3).lineTo(555, y - 3).strokeColor(COLOR.line).stroke();

  for (const p of players) {
    if (y > 740) { doc.addPage(); y = 50; }
    const name = publicName(p.player_id, p.display_name) + (p.player_id === hostPlayerId ? ' (you)' : '');
    const speed = p.median_ms === null ? '—' : `${(Number(p.median_ms) / 1000).toFixed(1)}s`;

    doc.fontSize(9.5).font(fonts.regular).fillColor(COLOR.ink).text(name, 40, y, { width: 205 });
    doc.fillColor(COLOR.muted)
      .text(`${p.answered} of ${game.numbers}`, 250, y)
      .text(speed, 340, y);
    doc.fillColor(p.prizes > 0 ? COLOR.green : COLOR.muted).font(p.prizes > 0 ? fonts.bold : fonts.regular)
      .text(String(p.prizes), 420, y);
    doc.fillColor(p.left_at ? COLOR.red : COLOR.green).font(fonts.regular)
      .text(p.left_at ? 'left' : 'yes', 490, y);
    y += 15;
  }

  /* prizes */
  y = sectionTitle(doc, fonts, 'Prizes', y + 14);
  if (claims.length === 0) {
    doc.fontSize(10).font(fonts.regular).fillColor(COLOR.muted).text('No prizes were claimed in this room.', 40, y);
    y += 18;
  } else {
    for (const c of claims) {
      if (y > 750) { doc.addPage(); y = 50; }
      doc.fontSize(10).font(fonts.regular).fillColor(COLOR.ink)
        .text(PRIZE_LABELS[c.claim_type] ?? c.claim_type, 40, y, { width: 300 });
      doc.font(fonts.bold).fillColor(COLOR.green)
        .text(publicName(c.player_id, c.display_name), 340, y, { width: 215, align: 'right' });
      y += 16;
    }
  }

  /* what to do with this */
  y = sectionTitle(doc, fonts, 'Worth knowing', y + 12);
  const notes: string[] = [];
  if (left > 0) notes.push(`${left} player${left === 1 ? '' : 's'} left before the end. Shorter rooms tend to hold everyone.`);
  if (engagement < 60) notes.push(`Only ${engagement}% of numbers were answered. Players who do not open their board miss the round.`);
  if (rejectedClaims > 0) notes.push(`${rejectedClaims} claim${rejectedClaims === 1 ? ' was' : 's were'} rejected as invalid — the server checks every claim against the numbers actually called.`);
  if (game.expected_players && players.length < game.expected_players) {
    notes.push(`You expected ${game.expected_players} but ${players.length} joined. The invite link can be forwarded again at any time.`);
  }
  if (notes.length === 0) notes.push('A clean room: everybody joined, stayed and played to the end.');

  doc.fontSize(10).font(fonts.regular).fillColor(COLOR.ink);
  for (const note of notes) {
    if (y > 760) { doc.addPage(); y = 50; }
    doc.text(`•  ${note}`, 40, y, { width: 515 });
    y = doc.y + 5;
  }

  /* footer */
  doc.fontSize(8).fillColor(COLOR.muted).font(fonts.regular)
    .text(
      `${env.BRAND_NAME} by ServerPe App Solutions - played for entertainment only - no phone numbers are shown to hosts or players`,
      40,
      800,
      { width: 515, align: 'center' },
    );

  doc.end();
  await done;

  const buffer = Buffer.concat(chunks);

  const stored = await storeDocument({
    kind: 'report',
    buffer,
    playerId: hostPlayerId,
    gameId,
    waId: hostWaId,
    title: 'Host report',
    // One host report per room: regenerating rewrites it rather than minting a
    // second number for the same document.
    dedupeKey: `host:${gameId}`,
    metadata: {
      reportFor: 'host',
      roomCode: game.room_code,
      players: players.length,
      numbersCalled: game.numbers,
      engagementPct: engagement,
    },
  });

  return { buffer, filename: stored.filename, docNumber: stored.docNumber };
}
