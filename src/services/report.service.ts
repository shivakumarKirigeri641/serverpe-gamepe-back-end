import PDFDocument from 'pdfkit';
import { query, queryOne } from '../db/pool.js';
import { storeDocument } from './document.service.js';
import { drawFooter, useFonts, type FontSet } from './report-fonts.js';
import { env } from '../config/env.js';
import { appDate, appDaysAgo, appTimeString } from '../utils/time.js';
import { displayNameOf, publicName, type PlayerRow } from './player.service.js';

/**
 * A player's stats as a PDF.
 *
 * Drawn with pdfkit primitives rather than rendering HTML through a headless
 * browser: no Chromium to install or keep alive, it runs in a few milliseconds,
 * and the output is a small file that sends cleanly over WhatsApp.
 */

const COLOR = {
  maroon: '#7d0f22',
  ink: '#1e2733',
  muted: '#6b7684',
  line: '#dfe4ea',
  green: '#1f9d55',
  gold: '#f0a202',
  panel: '#f6f3ef',
};

/**
 * pdfkit's built-in fonts are WinAnsi-encoded, so anything outside Latin-1 —
 * the rupee sign, em dashes, curly quotes, emoji — renders as garbage rather
 * than failing loudly. Everything drawn into the PDF goes through here.
 *
 * For true Unicode (a rupee glyph, Devanagari names) the fix is to embed a TTF;
 * this keeps the output correct until that is worth the extra megabyte.
 */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/₹/g, 'Rs.'],
  [/[—–]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/…/g, '...'],
  [/·/g, '-'],
  [/✓/g, 'v'],
  // Anything still outside Latin-1 (emoji, other scripts) is dropped rather
  // than drawn as a random glyph.
  [/[^\x00-\xFF]/g, ''],
];

function safe(value: string): string {
  return SUBSTITUTIONS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), value);
}

/**
 * Faces for the report currently being drawn.
 *
 * Set by buildPlayerReport before anything is rendered. Module-level rather
 * than threaded through fifteen helper signatures, which is safe because
 * reports are built one at a time — concludeGame awaits each one before
 * starting the next, precisely so a room of thirty does not open thirty
 * renders at once.
 */
let F: FontSet = { regular: 'Helvetica', bold: 'Helvetica-Bold', oblique: 'Helvetica-Oblique', unicode: false };

const PRIZE_LABELS: Readonly<Record<string, string>> = {
  early_five: 'Early Five',
  top_line: 'Top Line',
  middle_line: 'Middle Line',
  bottom_line: 'Bottom Line',
  four_corners: 'Four Corners',
  full_house: 'Full House',
};

interface ReportData {
  gamesPlayed: number;
  gamesCompleted: number;
  prizesWon: number;
  fullHouses: number;
  points: number;
  numbersAnswered: number;
  medianResponseMs: number | null;
  fastestResponseMs: number | null;
  accuracyPct: number | null;
  firstPlayed: Date | null;
  lastPlayed: Date | null;
  rank: number | null;
  totalPlayers: number;
  prizeBreakdown: Array<{ claim_type: string; wins: number }>;
  daily: Array<{ day: string; games: number; answered: number; prizes: number }>;
  recentGames: Array<{
    room_code: string;
    ended_at: Date | null;
    numbers: number;
    prizes: number;
    players: number;
  }>;
}

async function gather(playerId: string): Promise<ReportData> {
  const summary = await queryOne<Record<string, string | null>>(
    `SELECT
       (SELECT count(*)::text FROM game_players WHERE player_id = $1)                        AS games_played,
       (SELECT count(*)::text FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.player_id = $1 AND g.status = 'completed')                                 AS games_completed,
       (SELECT count(*)::text FROM game_claims WHERE player_id = $1 AND status = 'awarded')   AS prizes_won,
       (SELECT count(*)::text FROM game_claims
         WHERE player_id = $1 AND status = 'awarded' AND claim_type = 'full_house')           AS full_houses,
       (SELECT COALESCE(points, 0)::text FROM player_stats WHERE player_id = $1)              AS points,
       (SELECT count(*)::text FROM game_draw_responses WHERE player_id = $1)                  AS answered,
       (SELECT min(joined_at)::text FROM game_players WHERE player_id = $1)                   AS first_played,
       (SELECT max(joined_at)::text FROM game_players WHERE player_id = $1)                   AS last_played`,
    [playerId],
  );

  // Response time is measured from the moment the number was drawn.
  const timing = await queryOne<{ median: string | null; fastest: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::text AS median,
            min(ms)::text AS fastest
       FROM (
         SELECT EXTRACT(EPOCH FROM (r.responded_at - d.drawn_at)) * 1000 AS ms
           FROM game_draw_responses r
           JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
          WHERE r.player_id = $1 AND r.responded_at >= d.drawn_at
       ) t`,
    [playerId],
  );

  // Did they say "I have it" when they really did? A measure of attention.
  const accuracy = await queryOne<{ correct: string; total: string }>(
    `SELECT
       count(*) FILTER (WHERE r.has_number = (e.payload->'numbers') @> to_jsonb(d.value))::text AS correct,
       count(*)::text AS total
       FROM game_draw_responses r
       JOIN game_draws d ON d.game_id = r.game_id AND d.seq = r.seq
       JOIN game_entries e ON e.game_id = r.game_id AND e.player_id = r.player_id
      WHERE r.player_id = $1`,
    [playerId],
  );

  const ranking = await queryOne<{ rank: string | null; total: string }>(
    `SELECT (SELECT count(*) + 1 FROM player_stats s2
              WHERE s2.points > COALESCE((SELECT points FROM player_stats WHERE player_id = $1), 0))::text AS rank,
            (SELECT count(*) FROM player_stats)::text AS total`,
    [playerId],
  );

  const prizeBreakdown = await query<{ claim_type: string; wins: number }>(
    `SELECT claim_type, count(*)::int AS wins
       FROM game_claims WHERE player_id = $1 AND status = 'awarded'
      GROUP BY claim_type ORDER BY wins DESC`,
    [playerId],
  );

  const daily = await query<{ day: string; games: number; answered: number; prizes: number }>(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            COALESCE(a.games_joined, 0)::int     AS games,
            COALESCE(a.numbers_answered, 0)::int AS answered,
            COALESCE(a.prizes_won, 0)::int       AS prizes
       FROM generate_series($2::date, $3::date, '1 day') d
       LEFT JOIN player_daily_activity a ON a.day = d::date AND a.player_id = $1
      ORDER BY d`,
    [playerId, appDaysAgo(13), appDate()],
  );

  const recentGames = await query<{
    room_code: string;
    ended_at: Date | null;
    numbers: number;
    prizes: number;
    players: number;
  }>(
    `SELECT g.room_code, g.ended_at,
            (SELECT count(*)::int FROM game_draws d WHERE d.game_id = g.id) AS numbers,
            (SELECT count(*)::int FROM game_claims c
              WHERE c.game_id = g.id AND c.player_id = $1 AND c.status = 'awarded') AS prizes,
            (SELECT count(*)::int FROM game_players gp2 WHERE gp2.game_id = g.id) AS players
       FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.player_id = $1
      ORDER BY g.created_at DESC
      LIMIT 8`,
    [playerId],
  );

  const correct = Number(accuracy?.correct ?? 0);
  const totalAnswers = Number(accuracy?.total ?? 0);

  return {
    gamesPlayed: Number(summary?.['games_played'] ?? 0),
    gamesCompleted: Number(summary?.['games_completed'] ?? 0),
    prizesWon: Number(summary?.['prizes_won'] ?? 0),
    fullHouses: Number(summary?.['full_houses'] ?? 0),
    points: Number(summary?.['points'] ?? 0),
    numbersAnswered: Number(summary?.['answered'] ?? 0),
    medianResponseMs: timing?.median ? Math.round(Number(timing.median)) : null,
    fastestResponseMs: timing?.fastest ? Math.round(Number(timing.fastest)) : null,
    accuracyPct: totalAnswers > 0 ? Math.round((correct / totalAnswers) * 100) : null,
    firstPlayed: summary?.['first_played'] ? new Date(summary['first_played'] as string) : null,
    lastPlayed: summary?.['last_played'] ? new Date(summary['last_played'] as string) : null,
    rank: ranking?.rank ? Number(ranking.rank) : null,
    totalPlayers: Number(ranking?.total ?? 0),
    prizeBreakdown,
    daily,
    recentGames,
  };
}

/* ------------------------------------------------------------------ drawing */

function seconds(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Four headline figures across the top. */
function statTiles(doc: PDFKit.PDFDocument, data: ReportData, top: number): number {
  const tiles = [
    { label: 'Games played', value: String(data.gamesPlayed) },
    { label: 'Prizes won', value: String(data.prizesWon) },
    { label: 'Points', value: String(data.points) },
    { label: 'Full houses', value: String(data.fullHouses) },
  ];

  const gap = 10;
  const width = (515 - gap * 3) / 4;

  tiles.forEach((t, i) => {
    const x = 40 + i * (width + gap);
    doc.roundedRect(x, top, width, 64, 8).fill(COLOR.panel);
    doc
      .fillColor(COLOR.maroon)
      .fontSize(24)
      .font(F.bold)
      .text(safe(t.value), x, top + 12, { width, align: 'center' });
    doc
      .fillColor(COLOR.muted)
      .fontSize(9)
      .font(F.regular)
      .text(safe(t.label), x, top + 44, { width, align: 'center' });
  });

  return top + 64;
}

/** Bar chart of daily activity, drawn with rectangles. */
function activityChart(doc: PDFKit.PDFDocument, data: ReportData, top: number): number {
  const height = 110;
  const left = 40;
  const width = 515;

  doc.fillColor(COLOR.ink).fontSize(12).font(F.bold).text(safe('Numbers answered, last 14 days'), left, top);

  const chartTop = top + 20;
  const max = Math.max(...data.daily.map((d) => d.answered), 1);
  const barGap = 4;
  const barWidth = (width - barGap * (data.daily.length - 1)) / data.daily.length;

  // Baseline
  doc
    .moveTo(left, chartTop + height)
    .lineTo(left + width, chartTop + height)
    .lineWidth(1)
    .strokeColor(COLOR.line)
    .stroke();

  data.daily.forEach((d, i) => {
    const x = left + i * (barWidth + barGap);
    const h = Math.round((d.answered / max) * (height - 6));

    if (h > 0) {
      doc.roundedRect(x, chartTop + height - h, barWidth, h, 2).fill(d.prizes > 0 ? COLOR.gold : COLOR.green);
    } else {
      doc.rect(x, chartTop + height - 2, barWidth, 2).fill(COLOR.line);
    }

    // Only every other label, or they collide on a narrow page.
    if (i % 2 === 0) {
      doc
        .fillColor(COLOR.muted)
        .fontSize(6.5)
        .font(F.regular)
        .text(safe(d.day.slice(5)), x - 3, chartTop + height + 5, { width: barWidth + 6, align: 'center' });
    }
  });

  doc
    .fillColor(COLOR.muted)
    .fontSize(8)
    .text(safe(`Peak ${max} in a day - gold bars are days you won a prize`), left, chartTop + height + 18);

  return chartTop + height + 32;
}

/** Bottom of the printable area, above the footer band. */
const PAGE_BOTTOM = 780;

/**
 * Starts a new page when the next block will not fit.
 *
 * Without this every text call that lands past the page edge makes pdfkit open
 * a page of its own, which is how a one-game report became nineteen pages of
 * one line each. Called before each section and each repeated row.
 */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed <= PAGE_BOTTOM) return y;
  doc.addPage();
  return 50;
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string, top: number): number {
  top = ensureSpace(doc, top, 40);
  doc.fillColor(COLOR.ink).fontSize(12).font(F.bold).text(safe(text), 40, top);
  return top + 18;
}

function keyValues(doc: PDFKit.PDFDocument, rows: Array<[string, string]>, top: number): number {
  let y = top;
  for (const [label, value] of rows) {
    y = ensureSpace(doc, y, 20);
    doc.fillColor(COLOR.muted).fontSize(10).font(F.regular).text(safe(label), 40, y, { width: 300 });
    doc.fillColor(COLOR.ink).fontSize(10).font(F.bold).text(safe(value), 340, y, { width: 215, align: 'right' });
    y += 16;
  }
  return y;
}

/* -------------------------------------------------------------- game result */

interface GameResult {
  roomCode: string;
  numbersCalled: number;
  players: number;
  winnerName: string | null;
  youWon: boolean;
  yourPrizes: string[];
  allPrizes: Array<{ claim_type: string; winner: string }>;
}

/**
 * The just-finished game, from this player's point of view.
 *
 * The same report goes to everyone, but the banner differs: the winner is
 * congratulated, everyone else is told who won. That is the whole reason the
 * report takes a game id.
 */
async function gameResult(gameId: string, playerId: string): Promise<GameResult | null> {
  const game = await queryOne<{ room_code: string; numbers: number; players: number }>(
    `SELECT room_code,
            (SELECT count(*)::int FROM game_draws d WHERE d.game_id = games.id)   AS numbers,
            (SELECT count(*)::int FROM game_players p WHERE p.game_id = games.id) AS players
       FROM games WHERE id = $1`,
    [gameId],
  );
  if (!game) return null;

  const claims = await query<{ claim_type: string; player_id: string; display_name: string | null }>(
    `SELECT c.claim_type, c.player_id, p.display_name
       FROM game_claims c JOIN players p ON p.id = c.player_id
      WHERE c.game_id = $1 AND c.status = 'awarded'
      ORDER BY c.created_at`,
    [gameId],
  );

  // The report goes to every player, so other people's names must reveal
  // nothing about their number.
  const nameOf = (c: (typeof claims)[number]): string => publicName(c.player_id, c.display_name);

  const fullHouse = claims.find((c) => c.claim_type === 'full_house');
  const mine = claims.filter((c) => c.player_id === playerId);

  return {
    roomCode: game.room_code,
    numbersCalled: game.numbers,
    players: game.players,
    winnerName: fullHouse ? nameOf(fullHouse) : null,
    youWon: Boolean(fullHouse && fullHouse.player_id === playerId),
    yourPrizes: mine.map((c) => PRIZE_LABELS[c.claim_type] ?? c.claim_type),
    allPrizes: claims.map((c) => ({ claim_type: c.claim_type, winner: nameOf(c) })),
  };
}

/** The banner across the top of a post-game report. */
function resultBanner(doc: PDFKit.PDFDocument, result: GameResult, top: number): number {
  const height = result.allPrizes.length > 0 ? 96 + result.allPrizes.length * 13 : 96;
  doc.roundedRect(40, top, 515, height, 10).fill(result.youWon ? '#e8f6ee' : COLOR.panel);

  const headline = result.youWon
    ? 'You won the game!'
    : result.winnerName
      ? `${result.winnerName} won the game`
      : 'Game over';

  doc
    .fillColor(result.youWon ? COLOR.green : COLOR.maroon)
    .fontSize(16)
    .font(F.bold)
    .text(safe(headline), 56, top + 14, { width: 483 });

  doc
    .fillColor(COLOR.muted)
    .fontSize(10)
    .font(F.regular)
    .text(
      safe(
        `Room ${result.roomCode} - ${result.numbersCalled} numbers called - ${result.players} player${result.players === 1 ? '' : 's'}`,
      ),
      56,
      top + 36,
      { width: 483 },
    );

  doc
    .fillColor(COLOR.ink)
    .fontSize(10)
    .text(
      safe(
        result.yourPrizes.length > 0
          ? `You won: ${result.yourPrizes.join(', ')}`
          : 'You did not win a prize this time.',
      ),
      56,
      top + 54,
      { width: 483 },
    );

  let y = top + 76;
  if (result.allPrizes.length > 0) {
    doc.fillColor(COLOR.muted).fontSize(9).font(F.bold).text(safe('Prizes in this game'), 56, y);
    y += 13;
    doc.font(F.regular).fillColor(COLOR.ink).fontSize(9);
    for (const p of result.allPrizes) {
      doc.text(safe(`${PRIZE_LABELS[p.claim_type] ?? p.claim_type} - ${p.winner}`), 56, y, { width: 483 });
      y += 13;
    }
  }

  return top + height;
}

/* ------------------------------------------------------------------- render */

/**
 * Builds a player's report and files it.
 *
 * The PDF is stored before it is returned, so the copy the player receives and
 * the copy in the admin panel are the same file with the same report number on
 * it. Rebuilding it later would not reproduce it — their history has moved on.
 */
export async function buildPlayerReport(
  player: PlayerRow,
  gameId?: string,
): Promise<{ buffer: Buffer; filename: string; docNumber: string }> {
  const data = await gather(player.id);
  const result = gameId ? await gameResult(gameId, player.id) : null;

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${env.BRAND_NAME} report` } });
  F = useFonts(doc, 'latin');
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  // Header band
  doc.rect(0, 0, 595, 90).fill(COLOR.maroon);
  doc.fillColor('#ffffff').fontSize(22).font(F.bold).text(safe(env.BRAND_NAME), 40, 28);
  doc.fontSize(11).font(F.regular).text(safe(`Player report - ${displayNameOf(player)}`), 40, 56);
  doc.fontSize(8).text(safe(appTimeString()), 40, 72, { width: 515, align: 'right' });

  let y = 110;
  if (result) {
    y = ensureSpace(doc, y, 96 + result.allPrizes.length * 13 + 16);
    y = resultBanner(doc, result, y) + 16;
  }
  y = ensureSpace(doc, y, 90);
  y = statTiles(doc, data, y);

  y = sectionTitle(doc, 'Overview', y + 22);
  y = keyValues(
    doc,
    [
      ['Games joined', String(data.gamesPlayed)],
      ['Games played to the end', String(data.gamesCompleted)],
      ['Numbers answered', String(data.numbersAnswered)],
      [
        'Leaderboard position',
        data.rank ? `#${data.rank} of ${data.totalPlayers}` : 'Not ranked yet',
      ],
      ['First game', data.firstPlayed ? appDate(data.firstPlayed) : '—'],
      ['Most recent game', data.lastPlayed ? appDate(data.lastPlayed) : '—'],
    ],
    y,
  );

  y = sectionTitle(doc, 'Timing', y + 16);
  y = keyValues(
    doc,
    [
      ['Typical response time', seconds(data.medianResponseMs)],
      ['Fastest response', seconds(data.fastestResponseMs)],
      [
        'Answer accuracy',
        data.accuracyPct === null ? '—' : `${data.accuracyPct}% correct`,
      ],
    ],
    y,
  );

  y = ensureSpace(doc, y + 18, 130);
  y = activityChart(doc, data, y);

  y = sectionTitle(doc, 'Prizes won', y + 8);
  if (data.prizeBreakdown.length === 0) {
    doc.fillColor(COLOR.muted).fontSize(10).font(F.regular).text(safe('No prizes yet - your first one is coming.'), 40, y);
    y += 18;
  } else {
    y = keyValues(
      doc,
      data.prizeBreakdown.map((p) => [PRIZE_LABELS[p.claim_type] ?? p.claim_type, `${p.wins}`]),
      y,
    );
  }

  y = sectionTitle(doc, 'Recent games', y + 16);
  if (data.recentGames.length === 0) {
    doc.fillColor(COLOR.muted).fontSize(10).font(F.regular).text(safe('No games yet.'), 40, y);
  } else {
    doc.fillColor(COLOR.muted).fontSize(9).font(F.bold);
    doc.text('Room', 40, y).text('Date', 140, y).text('Players', 260, y).text('Numbers', 350, y).text('Your prizes', 450, y);
    y += 14;
    doc.moveTo(40, y - 3).lineTo(555, y - 3).strokeColor(COLOR.line).stroke();

    for (const g of data.recentGames) {
      y = ensureSpace(doc, y, 18);
      doc.fillColor(COLOR.ink).fontSize(9).font(F.regular);
      doc
        .text(safe(g.room_code), 40, y)
        .text(safe(g.ended_at ? appDate(g.ended_at) : 'in progress'), 140, y)
        .text(String(g.players), 260, y)
        .text(String(g.numbers), 350, y)
        .text(String(g.prizes), 450, y);
      y += 14;
    }
  }

  drawFooter(
    doc,
    safe(`${env.BRAND_NAME} by ServerPe App Solutions - played for entertainment only - ${env.PROMO_URL}`),
    F.regular,
    COLOR.muted,
  );

  doc.end();
  await done;

  const buffer = Buffer.concat(chunks);

  const stored = await storeDocument({
    kind: 'report',
    buffer,
    playerId: player.id,
    gameId: gameId ?? null,
    waId: player.wa_id,
    title: gameId ? 'Player report' : 'Playing history',
    dedupeKey: gameId ? `player:${gameId}:${player.id}` : undefined,
    metadata: {
      reportFor: 'player',
      gamesPlayed: data.gamesPlayed,
      prizesWon: data.prizesWon,
      generatedFor: appDate(),
    },
  });

  return { buffer, filename: stored.filename, docNumber: stored.docNumber };
}
