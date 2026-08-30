import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { query, queryOne } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';

/**
 * Passcode login for the admin panel.
 *
 * A browser cannot hold ADMIN_API_KEY — anyone can read it out of devtools and
 * then call the API directly, forever. So the panel exchanges the passcode for
 * a short-lived session token, and the key never leaves the server.
 *
 * A four-digit passcode is 10,000 combinations, which a script exhausts in
 * seconds. The lockout below is what actually protects the door; the passcode
 * only keeps out someone standing behind you.
 */

export interface SessionResult {
  token: string;
  expiresAt: Date;
}

export type LoginOutcome =
  | { ok: true; session: SessionResult }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'invalid'; attemptsRemaining: number }
  | { ok: false; reason: 'disabled' };

/** Tokens are stored hashed, so a leaked database dump grants nobody a session. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function attemptsKey(ip: string): string {
  return `admin:login:attempts:${ip}`;
}

function lockKey(ip: string): string {
  return `admin:login:locked:${ip}`;
}

function passcodeMatches(given: string): boolean {
  const expected = Buffer.from(env.ADMIN_PASSCODE, 'utf8');
  const actual = Buffer.from(given, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function login(
  passcode: string,
  ip: string,
  userAgent: string | null,
  label?: string,
): Promise<LoginOutcome> {
  if (!env.ADMIN_PASSCODE) return { ok: false, reason: 'disabled' };

  const lockTtl = await redis.ttl(lockKey(ip)).catch(() => -2);
  if (lockTtl > 0) return { ok: false, reason: 'locked', retryAfterSeconds: lockTtl };

  if (!passcodeMatches(passcode)) {
    // Count the failure and lock the IP out once it has had enough goes.
    let attempts = 0;
    try {
      attempts = await redis.incr(attemptsKey(ip));
      if (attempts === 1) await redis.expire(attemptsKey(ip), env.ADMIN_LOCKOUT_MINUTES * 60);
      if (attempts >= env.ADMIN_MAX_LOGIN_ATTEMPTS) {
        await redis.set(lockKey(ip), '1', 'EX', env.ADMIN_LOCKOUT_MINUTES * 60);
        await redis.del(attemptsKey(ip));
      }
    } catch (err) {
      logger.warn({ err }, 'could not record failed admin login');
    }

    logger.warn({ ip, attempts }, 'failed admin passcode attempt');
    return {
      ok: false,
      reason: 'invalid',
      attemptsRemaining: Math.max(env.ADMIN_MAX_LOGIN_ATTEMPTS - attempts, 0),
    };
  }

  await redis.del(attemptsKey(ip)).catch(() => undefined);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.ADMIN_SESSION_TTL_MINUTES * 60_000);

  await query(
    `INSERT INTO admin_sessions (token_hash, label, request_ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), label ?? null, ip || null, userAgent, expiresAt],
  );

  logger.info({ ip, expiresAt }, 'admin session created');
  return { ok: true, session: { token, expiresAt } };
}

export interface ActiveSession {
  id: string;
  label: string | null;
  expires_at: Date;
}

/** Returns the session if the token is valid, live and unrevoked. */
export async function verifySession(token: string): Promise<ActiveSession | null> {
  const row = await queryOne<ActiveSession>(
    `UPDATE admin_sessions
        SET last_used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, label, expires_at`,
    [hashToken(token)],
  );
  return row;
}

export async function revokeSession(token: string): Promise<void> {
  await query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1', [hashToken(token)]);
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export async function purgeExpiredSessions(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM admin_sessions WHERE expires_at < now() - interval '1 day' RETURNING id`,
  );
  return rows.length;
}

export async function listSessions(): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT id, label, host(request_ip) AS request_ip, user_agent,
            created_at, expires_at, last_used_at, revoked_at,
            (revoked_at IS NULL AND expires_at > now()) AS active
       FROM admin_sessions
      ORDER BY created_at DESC
      LIMIT 50`,
  );
}
