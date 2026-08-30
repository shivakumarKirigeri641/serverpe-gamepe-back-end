import { query } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Approximate location from an IP address.
 *
 * Only ever called for a board-page visit, which is the single place a real
 * browser reaches us — WhatsApp traffic arrives from Meta's servers and carries
 * no player IP at all. Admin-only: no player ever sees another player's
 * location, and neither does the board.
 *
 * Deliberately best-effort. IP geolocation is approximate at the best of times
 * — a mobile connection often resolves to the operator's gateway city rather
 * than the person's — so this is a hint for support, never a fact to act on.
 */

const CACHE_PREFIX = 'geo:';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface GeoResult {
  region: string | null;
  city: string | null;
  country: string | null;
}

const EMPTY: GeoResult = { region: null, city: null, country: null };

/** Private and loopback ranges never resolve, so do not waste a lookup. */
function isPrivate(ip: string): boolean {
  return (
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  );
}

async function lookup(ip: string): Promise<GeoResult> {
  if (!env.GEO_LOOKUP_ENABLED || isPrivate(ip)) return EMPTY;

  try {
    const cached = await redis.get(`${CACHE_PREFIX}${ip}`);
    if (cached) return JSON.parse(cached) as GeoResult;
  } catch {
    // cache miss is not a failure
  }

  try {
    // ip-api.com's free endpoint: no key, rate limited, http only. Kept behind
    // a flag so it can be swapped for a paid provider without touching callers.
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`, {
      signal: AbortSignal.timeout(2500),
    });
    const json = (await res.json()) as {
      status?: string;
      country?: string;
      regionName?: string;
      city?: string;
    };

    const result: GeoResult =
      json.status === 'success'
        ? { region: json.regionName ?? null, city: json.city ?? null, country: json.country ?? null }
        : EMPTY;

    await redis.set(`${CACHE_PREFIX}${ip}`, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return result;
  } catch (err) {
    logger.debug({ err, ip }, 'geo lookup failed');
    return EMPTY;
  }
}

/**
 * Records where and on what a player opened their board.
 *
 * Never blocks the request: the board renders first, this catches up after.
 */
export async function recordDeviceContext(
  playerId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  if (!ip && !userAgent) return;

  try {
    const geo = ip ? await lookup(ip) : EMPTY;

    await query(
      `UPDATE players
          SET last_ip = COALESCE($2::inet, last_ip),
              last_user_agent = COALESCE($3, last_user_agent),
              last_region = COALESCE($4, last_region),
              last_city = COALESCE($5, last_city),
              last_country = COALESCE($6, last_country),
              last_device_at = now()
        WHERE id = $1`,
      [playerId, ip, userAgent?.slice(0, 512) ?? null, geo.region, geo.city, geo.country],
    );
  } catch (err) {
    logger.warn({ err, playerId }, 'could not record device context');
  }
}

/** Where players are opening boards from — admin only. */
export async function playersByRegion(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT COALESCE(last_region, 'Unknown') AS region,
            COALESCE(last_country, 'Unknown') AS country,
            count(*)::int AS players
       FROM players
      WHERE last_device_at IS NOT NULL
      GROUP BY 1, 2
      ORDER BY players DESC`,
  );
}
