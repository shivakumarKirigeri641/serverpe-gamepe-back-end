import { query, type Queryable } from '../db/pool.js';
import { appWeekStart } from '../utils/time.js';
import { publicName } from './player.service.js';

/**
 * Points are the trial-period reward. Full House is worth more than the small
 * prizes so the leaderboard reflects real wins rather than early-five luck.
 */
export const POINTS_BY_CLAIM: Readonly<Record<string, number>> = {
  early_five: 5,
  top_line: 10,
  middle_line: 10,
  bottom_line: 10,
  four_corners: 10,
  full_house: 25,
};

export const POINTS_FOR_PLAYING = 1;

/** Monday of the current week, in the application timezone. */
export function weekStart(date: Date = new Date()): string {
  return appWeekStart(date);
}

async function bumpWeekly(
  playerId: string,
  fields: { games?: number; prizes?: number; points?: number },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO player_stats_weekly (player_id, week_start, games_played, prizes_won, points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (player_id, week_start) DO UPDATE
       SET games_played = player_stats_weekly.games_played + EXCLUDED.games_played,
           prizes_won   = player_stats_weekly.prizes_won   + EXCLUDED.prizes_won,
           points       = player_stats_weekly.points       + EXCLUDED.points`,
    [playerId, weekStart(), fields.games ?? 0, fields.prizes ?? 0, fields.points ?? 0],
    client,
  );
}

export async function recordGamePlayed(playerId: string, client?: Queryable): Promise<void> {
  await query(
    `INSERT INTO player_stats (player_id, games_played, points, last_played_at)
     VALUES ($1, 1, $2, now())
     ON CONFLICT (player_id) DO UPDATE
       SET games_played   = player_stats.games_played + 1,
           points         = player_stats.points + $2,
           last_played_at = now(),
           updated_at     = now()`,
    [playerId, POINTS_FOR_PLAYING],
    client,
  );
  await bumpWeekly(playerId, { games: 1, points: POINTS_FOR_PLAYING }, client);
}

export async function recordPrizeWon(playerId: string, claimType: string, client?: Queryable): Promise<void> {
  const points = POINTS_BY_CLAIM[claimType] ?? 5;
  const isFullHouse = claimType === 'full_house' ? 1 : 0;

  await query(
    `INSERT INTO player_stats (player_id, prizes_won, full_houses, points, last_played_at)
     VALUES ($1, 1, $2, $3, now())
     ON CONFLICT (player_id) DO UPDATE
       SET prizes_won     = player_stats.prizes_won + 1,
           full_houses    = player_stats.full_houses + $2,
           points         = player_stats.points + $3,
           last_played_at = now(),
           updated_at     = now()`,
    [playerId, isFullHouse, points],
    client,
  );
  await bumpWeekly(playerId, { prizes: 1, points }, client);
}

export interface StatsRow {
  games_played: number;
  prizes_won: number;
  full_houses: number;
  points: number;
}

export async function getStats(playerId: string, client?: Queryable): Promise<StatsRow> {
  const rows = await query<StatsRow>(
    'SELECT games_played, prizes_won, full_houses, points FROM player_stats WHERE player_id = $1',
    [playerId],
    client,
  );
  return rows[0] ?? { games_played: 0, prizes_won: 0, full_houses: 0, points: 0 };
}

export interface LeaderboardRow {
  player_id: string;
  display_name: string | null;
  wa_id: string;
  points: number;
  prizes_won: number;
}

export async function getWeeklyLeaderboard(limit = 10, client?: Queryable): Promise<LeaderboardRow[]> {
  return query<LeaderboardRow>(
    `SELECT w.player_id, p.display_name, p.wa_id, w.points, w.prizes_won
       FROM player_stats_weekly w
       JOIN players p ON p.id = w.player_id
      WHERE w.week_start = $1
      ORDER BY w.points DESC, w.prizes_won DESC
      LIMIT $2`,
    [weekStart(), limit],
    client,
  );
}

/** "Ravi" if they have a profile name, otherwise an anonymous tag. */
export function leaderboardName(row: LeaderboardRow): string {
  return publicName(row.player_id, row.display_name);
}
