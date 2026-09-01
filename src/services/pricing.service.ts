import { query, queryOne } from '../db/pool.js';
import { env, trialEnd } from '../config/env.js';
import { splitGst } from './payment.service.js';

/**
 * Turning a room size into a price.
 *
 * A host never picks a plan by name — they say how many friends are coming, and
 * the band follows. So the only question this answers is: for N players, what
 * are the two things they can buy and what does each cost?
 *
 * Both options are returned together because the comparison is the offer. At
 * most sizes the day pass is a modest step up for unlimited games, and that is
 * the reason to choose it; showing one price at a time hides the argument.
 */

export interface PricedPlan {
  planKey: string;
  name: string;
  tagline: string;
  kind: 'single' | 'unlimited_24h';
  durationHours: number | null;
  minPlayers: number;
  maxPlayers: number;
  /** What the player is charged, GST included or added per GST_INCLUSIVE. */
  amountPaise: number;
  basePaise: number;
  gstPaise: number;
}

export interface PricingForRoom {
  players: number;
  bandLabel: string;
  single: PricedPlan | null;
  unlimited: PricedPlan | null;
  /** Percent saved by the day pass against two single games. Null if not both. */
  savingPercent: number | null;
  /** True when the trial is running, in which case nothing is charged. */
  free: boolean;
}

interface PlanRow {
  plan_key: string;
  name: string;
  tagline: string;
  kind: string;
  duration_hours: number | null;
  min_players: number;
  max_players: number;
  price_paise: number;
}

function price(row: PlanRow): PricedPlan {
  const { basePaise, gstPaise, totalPaise } = splitGst(row.price_paise);
  return {
    planKey: row.plan_key,
    name: row.name,
    tagline: row.tagline,
    kind: row.kind as 'single' | 'unlimited_24h',
    durationHours: row.duration_hours,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    amountPaise: totalPaise,
    basePaise,
    gstPaise,
  };
}

/**
 * The band a room size falls into, and what it costs.
 *
 * Rooms larger than the top band fall back to it rather than being refused: a
 * host asking for 1,500 players is better served by the biggest plan and a
 * clear cap than by an error telling them their party is too big.
 */
export async function priceForPlayers(players: number): Promise<PricingForRoom> {
  const wanted = Math.max(players, 1);

  const rows = await query<PlanRow>(
    `SELECT plan_key, name, tagline, kind, duration_hours, min_players, max_players, price_paise
       FROM plans
      WHERE is_active AND is_selectable AND kind IN ('single', 'unlimited_24h')
        AND $1 BETWEEN min_players AND max_players
      ORDER BY kind`,
    [wanted],
  );

  const fallback = rows.length
    ? rows
    : await query<PlanRow>(
        `SELECT plan_key, name, tagline, kind, duration_hours, min_players, max_players, price_paise
           FROM plans
          WHERE is_active AND is_selectable AND kind IN ('single', 'unlimited_24h')
            AND max_players = (SELECT max(max_players) FROM plans WHERE is_active AND is_selectable)
          ORDER BY kind`,
      );

  const single = fallback.find((r) => r.kind === 'single');
  const unlimited = fallback.find((r) => r.kind === 'unlimited_24h');

  const band = single ?? unlimited;
  const bandLabel = band ? `${band.min_players}–${band.max_players} players` : 'any size';

  // Measured against two single games, because that is the decision a host is
  // actually making: one round now, or an evening of them.
  const savingPercent =
    single && unlimited && single.price_paise > 0
      ? Math.round((1 - unlimited.price_paise / (single.price_paise * 2)) * 100)
      : null;

  return {
    players: wanted,
    bandLabel,
    single: single ? price(single) : null,
    unlimited: unlimited ? price(unlimited) : null,
    savingPercent: savingPercent && savingPercent > 0 ? savingPercent : null,
    free: !isChargingLive(),
  };
}

/**
 * Is anyone actually being charged today?
 *
 * Two switches, both of which must be on: the trial has to be over and payments
 * enabled. Either one off means rooms are free, and the checkout is never
 * offered — which is why this is asked here rather than assumed by the caller.
 */
export function isChargingLive(): boolean {
  const trialOver = new Date() > trialEnd();
  return env.MONETIZATION_ENABLED && env.PAYMENTS_ENABLED && trialOver;
}

/** A day pass that has not expired, if the host holds one. */
export async function activePass(playerId: string): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT id, plan_key, max_players, expires_at, games_used
       FROM player_passes
      WHERE player_id = $1 AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`,
    [playerId],
  );
}

/** Records the day pass a payment bought. */
export async function grantPass(
  playerId: string,
  planKey: string,
  maxPlayers: number,
  hours: number,
  paymentId: string | null,
): Promise<void> {
  await query(
    `INSERT INTO player_passes (player_id, plan_key, max_players, expires_at, payment_id)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)`,
    [playerId, planKey, maxPlayers, String(hours), paymentId],
  );
}
