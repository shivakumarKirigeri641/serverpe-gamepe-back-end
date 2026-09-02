/**
 * Admin authentication.
 *
 * The panel exchanges the passcode for a session token once, and sends that
 * token on every later request. The long-lived passcode never travels again
 * after login, and is never stored anywhere but .env.
 *
 * Only a SHA-256 hash of each token is stored, so a leaked database backup
 * yields no working sessions. Comparison is constant-time - a passcode check
 * that returns early on the first wrong character is measurably guessable.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { requestInfo } from '../utils/request-info.js';

const hash = (token) => createHash('sha256').update(token).digest('hex');

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hash both first so the compared buffers are always 32 bytes.
  return timingSafeEqual(
    createHash('sha256').update(bufA).digest(),
    createHash('sha256').update(bufB).digest(),
  );
}

/**
 * How many failures this address has racked up inside the lockout window, and
 * how long it must wait. Counted per IP rather than globally so one attacker
 * cannot lock out the real operator.
 */
export async function loginLockState(req) {
  const { ip } = requestInfo(req);
  const { rows } = await query(
    `SELECT count(*)::int AS failures, max(attempted_at) AS last_attempt
       FROM admin_login_attempts
      WHERE request_ip IS NOT DISTINCT FROM $1
        AND succeeded = false
        AND attempted_at > now() - make_interval(mins => $2)`,
    [ip, config.admin.lockoutMinutes],
  );

  const failures = rows[0].failures;
  const locked = failures >= config.admin.maxLoginAttempts;
  let retryAfterSeconds = 0;

  if (locked && rows[0].last_attempt) {
    const unlockAt = new Date(rows[0].last_attempt).getTime() + config.admin.lockoutMinutes * 60_000;
    retryAfterSeconds = Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
  }

  return {
    locked,
    failures,
    attemptsRemaining: Math.max(0, config.admin.maxLoginAttempts - failures),
    retryAfterSeconds,
  };
}

async function recordAttempt(req, succeeded) {
  const { ip } = requestInfo(req);
  await query(
    'INSERT INTO admin_login_attempts (request_ip, succeeded) VALUES ($1, $2)',
    [ip, succeeded],
  );
}

/**
 * @returns {Promise<{ok:true, token, expiresAt} | {ok:false, reason, ...}>}
 */
export async function login(req, { passcode, label }) {
  if (!config.admin.passcode) {
    return { ok: false, reason: 'Admin access is not configured (ADMIN_PASSCODE is unset)', status: 503 };
  }

  const lock = await loginLockState(req);
  if (lock.locked) {
    return {
      ok: false, status: 429,
      reason: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`,
      retryAfterSeconds: lock.retryAfterSeconds,
    };
  }

  if (!constantTimeEquals(passcode, config.admin.passcode)) {
    await recordAttempt(req, false);
    const after = await loginLockState(req);
    log.warn('admin login failed', { ip: requestInfo(req).ip, attemptsRemaining: after.attemptsRemaining });
    return {
      ok: false, status: 401,
      reason: 'That passcode is not correct',
      attemptsRemaining: after.attemptsRemaining,
    };
  }

  await recordAttempt(req, true);

  const token = randomBytes(32).toString('base64url');
  const info = requestInfo(req);
  const { rows } = await query(
    `INSERT INTO admin_sessions (token_hash, label, request_ip, user_agent, expires_at)
          VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
       RETURNING id, expires_at`,
    [hash(token), label ?? null, info.ip, info.userAgent, config.admin.sessionTtlMinutes],
  );

  log.info('admin signed in', { ip: info.ip, label });
  return { ok: true, token, expiresAt: rows[0].expires_at, sessionId: rows[0].id };
}

/** Validates a bearer token and slides its last-used timestamp. */
export async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await query(
    `UPDATE admin_sessions
        SET last_used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, label, created_at, expires_at`,
    [hash(token)],
  );
  return rows[0] ?? null;
}

export async function revokeSession(token) {
  await query(
    'UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hash(token)],
  );
}

/** Sessions for the Settings screen. Tokens are never included. */
export async function listSessions() {
  const { rows } = await query(
    `SELECT id, label, request_ip, user_agent, created_at, last_used_at, expires_at,
            (revoked_at IS NULL AND expires_at > now()) AS active
       FROM admin_sessions
      ORDER BY last_used_at DESC
      LIMIT 100`,
  );
  return rows;
}

/** Housekeeping: drop long-dead sessions and stale attempt records. */
export async function purgeExpired() {
  const a = await query(`DELETE FROM admin_sessions WHERE expires_at < now() - interval '7 days'`);
  const b = await query(`DELETE FROM admin_login_attempts WHERE attempted_at < now() - interval '7 days'`);
  return { sessions: a.rowCount, attempts: b.rowCount };
}

/**
 * Express middleware. Accepts the session token, or the long-lived
 * ADMIN_API_KEY for scripts and monitoring that cannot hold a session.
 */
export function requireAdmin() {
  return async function guard(req, res, next) {
    try {
      const header = req.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

      if (config.admin.apiKey && token && constantTimeEquals(token, config.admin.apiKey)) {
        req.admin = { label: 'api-key', viaApiKey: true };
        return next();
      }

      const session = await resolveSession(token);
      if (!session) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });

      req.admin = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}
