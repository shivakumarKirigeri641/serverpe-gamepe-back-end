/**
 * A small fixed-window rate limiter, applied deliberately narrowly.
 *
 * ── What is limited, and what is not ───────────────────────────────────────
 *
 * NOTHING in a running game is limited. Not answering a number, not claiming a
 * prize, not opening a board, not the live stream, not leaving. That is a rule,
 * not an oversight:
 *
 *   - Two hundred players answer the *same* number within the same second, by
 *     design. That is the game working, and it is indistinguishable from a
 *     flood to any per-IP limiter.
 *   - Players sit behind carrier NAT. A whole family, or a whole college
 *     hostel, can share one address — so an IP limit set low enough to matter
 *     would throw out real players first.
 *   - A throttled tap is a lost number, and a lost number cannot be won back.
 *     The cost of a false positive is somebody's prize.
 *
 * The concurrency that actually protects the game is elsewhere and is not
 * rate limiting at all: row locks, FOR UPDATE SKIP LOCKED in the scheduler, a
 * partial unique index arbitrating prize races, and a bounded connection pool.
 * Those bound the work per request rather than refusing requests.
 *
 * So this covers the two endpoints where a stranger can make us do work on
 * demand and where no game is waiting: the feedback form and the support form.
 * Both are writes, both are reachable with only a link, and neither is
 * time-critical to anybody.
 *
 * ── Why not express-rate-limit ────────────────────────────────────────────
 *
 * This service has four dependencies and no Redis. A dependency for forty
 * lines that guards two endpoints is a poor trade. The cost of doing it here
 * is that the window lives in one process's memory, so two instances would
 * each allow the full quota — acceptable for abuse-shaping, and noted rather
 * than hidden.
 */
import { log } from '../utils/logger.js';

/**
 * @param {object} o
 * @param {number} o.max        requests allowed per window
 * @param {number} o.windowMs   how long the window is
 * @param {string} o.name       what shows up in the log line
 */
export function rateLimit({ max = 10, windowMs = 60_000, name = 'endpoint' } = {}) {
  /** key -> { count, resetAt } */
  const hits = new Map();

  // Fixed windows leave dead entries behind once a burst stops. Swept on a
  // timer rather than on every request, so a flood does not also pay for the
  // cleanup. Unref'd: this must never hold the process open at shutdown.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  }, windowMs);
  sweep.unref?.();

  return function limiter(req, res, next) {
    // The signed token identifies a person; the IP is the fallback for anyone
    // arriving without one. Keying on the token means one player behind a
    // shared address cannot spend everybody else's quota.
    const key = req.params?.token || req.ip || 'unknown';
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      log.warn('rate limited', { name, key: String(key).slice(0, 12), count: entry.count });
      return res.status(429).json({
        error: `That is a lot of requests at once. Please try again in ${retryAfter} seconds.`,
      });
    }

    next();
  };
}
