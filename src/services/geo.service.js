/**
 * City and state from an IP address.
 *
 * Server-side only - the player is never asked for location permission and no
 * browser geolocation API is involved. All we do is look up the address the
 * request already arrived from.
 *
 * Three rules this module lives by:
 *
 *   1. NEVER block a request. Lookups are fired after the response has gone
 *      out. A slow or dead geo provider must not delay a player answering a
 *      number.
 *   2. Cache hard. The same handful of players reconnect constantly, and every
 *      free provider has a tight rate limit.
 *   3. Fail silently. No city is a perfectly acceptable outcome; a thrown
 *      error here is not.
 *
 * Accuracy caveat, which the admin panel already tells operators: a mobile
 * connection usually resolves to the carrier's gateway, so the city can be a
 * few hundred kilometres out. Treat it as a hint, never as evidence.
 */
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { query } from '../db/pool.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // a day; cities do not move
const MAX_CACHE = 5000;
const TIMEOUT_MS = 3000;

const cache = new Map();   // ip -> { at, value }

/** Private, loopback and link-local ranges never have a public location. */
function isPrivate(ip) {
  return (
    !ip ||
    ip === '::1' ||
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^f[cd][0-9a-f]{2}:/i.test(ip)
  );
}

const PROVIDERS = {
  /** https, no key, ~1000/day. The sensible default for this volume. */
  'ipapi.co': {
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: (j) => (j?.error ? null : { city: j.city, region: j.region, country: j.country_name }),
  },
  /** http only on the free tier, 45/min. Higher limit, weaker transport. */
  'ip-api.com': {
    url: (ip) => `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city`,
    parse: (j) => (j?.status !== 'success' ? null : { city: j.city, region: j.regionName, country: j.country }),
  },
  /** Needs GEO_API_KEY. Generous free tier, best data. */
  'ipinfo.io': {
    url: (ip, key) => `https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(key)}`,
    parse: (j) => (!j?.city ? null : { city: j.city, region: j.region, country: j.country }),
  },
};

/**
 * @returns {Promise<{city,region,country}|null>} null when disabled, private,
 *          rate-limited, or simply unknown.
 */
export async function lookupIp(ip) {
  if (!config.geo.enabled || isPrivate(ip)) return null;

  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const provider = PROVIDERS[config.geo.provider];
  if (!provider) {
    log.warn('unknown geo provider', { provider: config.geo.provider });
    return null;
  }
  if (config.geo.provider === 'ipinfo.io' && !config.geo.apiKey) {
    log.warn('ipinfo.io needs GEO_API_KEY');
    return null;
  }

  try {
    const res = await fetch(provider.url(ip, config.geo.apiKey), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // 429 is the common one. Cache the miss anyway so a rate limit does not
      // turn into a retry storm.
      log.debug('geo lookup rejected', { ip, status: res.status });
      remember(ip, null);
      return null;
    }
    const value = provider.parse(await res.json());
    remember(ip, value);
    return value;
  } catch (err) {
    log.debug('geo lookup failed', { ip, message: err.message });
    remember(ip, null);
    return null;
  }
}

function remember(ip, value) {
  // Crude eviction, but this cache is a rate-limit shield, not a data store.
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(ip, { at: Date.now(), value });
}

/**
 * Resolves a session's location and writes it back, after the fact.
 *
 * Deliberately fire-and-forget: called with no await from the request path, so
 * the player's page has already rendered by the time this runs.
 */
export function resolveSessionLocation({ sessionId, playerId, ip }) {
  if (!config.geo.enabled || !ip || isPrivate(ip)) return;

  setImmediate(async () => {
    try {
      const place = await lookupIp(ip);
      if (!place || !place.city) return;

      if (sessionId) {
        await query(
          'UPDATE board_sessions SET city = $2, region = $3, country = $4 WHERE id = $1',
          [sessionId, place.city, place.region, place.country],
        );
      }
      if (playerId) {
        await query(
          'UPDATE players SET last_city = $2, last_region = $3, last_country = $4 WHERE id = $1',
          [playerId, place.city, place.region, place.country],
        );
      }
    } catch (err) {
      log.debug('could not store location', { message: err.message });
    }
  });
}

/** For the admin panel's diagnostics. */
export function geoStatus() {
  return {
    enabled: config.geo.enabled,
    provider: config.geo.provider,
    cached: cache.size,
    needsKey: config.geo.provider === 'ipinfo.io' && !config.geo.apiKey,
  };
}
