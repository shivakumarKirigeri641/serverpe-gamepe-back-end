import { query, queryOne } from '../db/pool.js';
import { env, trialEnd } from '../config/env.js';
import { appDate } from '../utils/time.js';

/**
 * How the free trial is going.
 *
 * The first window exists to answer one question — do enough people turn up to
 * be worth charging? — so this is that question with numbers attached, not a
 * general analytics screen. It says how many signed up, how many came back,
 * how many actually finished a game, and how many days are left to decide in.
 *
 * "Customers" is deliberately counted three ways. A number that only counts
 * everyone who ever said hi flatters the trial: somebody who messaged once and
 * never played is not evidence of demand, and deciding to extend on that basis
 * would be deciding on the wrong number.
 */

export interface TrialSummary {
  endsAt: string;
  endsOn: string;
  daysRemaining: number;
  daysElapsed: number;
  isOver: boolean;
  monetizationEnabled: boolean;

  counts: {
    /** Everyone who has ever messaged the bot. The loosest measure. */
    signups: number;
    /** Accepted the terms — a real intent to play. */
    consented: number;
    /** Joined at least one game. */
    played: number;
    /** Hosted at least one room: the people a paid plan would be sold to. */
    hosts: number;
    /** Played on more than one day. The number that actually predicts revenue. */
    returning: number;
    gamesStarted: number;
    gamesCompleted: number;
  };

  /** Signups per day, so a flat line is visible rather than inferred. */
  daily: Array<{ day: string; signups: number; played: number; games: number }>;
}

export async function getTrialSummary(): Promise<TrialSummary> {
  const end = trialEnd();
  const now = new Date();
  const msPerDay = 86_400_000;

  const counts = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM players)                                        AS signups,
       (SELECT count(DISTINCT player_id) FROM player_consents)               AS consented,
       (SELECT count(DISTINCT player_id) FROM game_players)                  AS played,
       (SELECT count(DISTINCT host_player_id) FROM games
         WHERE host_player_id IS NOT NULL)                                   AS hosts,
       -- More than one distinct day with a game: one evening of curiosity is
       -- not the same as a habit, and only the second predicts a renewal.
       (SELECT count(*) FROM (
          SELECT gp.player_id
            FROM game_players gp JOIN games g ON g.id = gp.game_id
           GROUP BY gp.player_id
          HAVING count(DISTINCT (g.created_at AT TIME ZONE $1)::date) > 1
        ) r)                                                                 AS returning,
       (SELECT count(*) FROM games WHERE started_at IS NOT NULL)             AS games_started,
       (SELECT count(*) FROM games WHERE status = 'completed')               AS games_completed`,
    [env.APP_TIMEZONE],
  );

  const daily = await query<{ day: string; signups: number; played: number; games: number }>(
    `WITH days AS (
       SELECT generate_series(
                (now() AT TIME ZONE $1)::date - interval '13 days',
                (now() AT TIME ZONE $1)::date,
                interval '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*)::int FROM players p
              WHERE (p.created_at AT TIME ZONE $1)::date = d.day)            AS signups,
            (SELECT count(DISTINCT gp.player_id)::int
               FROM game_players gp JOIN games g ON g.id = gp.game_id
              WHERE (g.created_at AT TIME ZONE $1)::date = d.day)            AS played,
            (SELECT count(*)::int FROM games g
              WHERE (g.created_at AT TIME ZONE $1)::date = d.day)            AS games
       FROM days d ORDER BY d.day`,
    [env.APP_TIMEZONE],
  );

  const daysRemaining = Math.max(Math.ceil((end.getTime() - now.getTime()) / msPerDay), 0);

  return {
    endsAt: trialEnd().toISOString(),
    endsOn: appDate(end),
    daysRemaining,
    daysElapsed: Math.max(
      Math.ceil((now.getTime() - (end.getTime() - 7 * msPerDay)) / msPerDay),
      0,
    ),
    isOver: now > end,
    monetizationEnabled: env.MONETIZATION_ENABLED,
    counts: {
      signups: Number(counts?.['signups'] ?? 0),
      consented: Number(counts?.['consented'] ?? 0),
      played: Number(counts?.['played'] ?? 0),
      hosts: Number(counts?.['hosts'] ?? 0),
      returning: Number(counts?.['returning'] ?? 0),
      gamesStarted: Number(counts?.['games_started'] ?? 0),
      gamesCompleted: Number(counts?.['games_completed'] ?? 0),
    },
    daily,
  };
}
