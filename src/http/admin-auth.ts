import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';

export interface AdminRequest extends Request {
  adminActor?: string;
}

/** Constant-time compare so the key can't be probed a character at a time. */
function keyMatches(provided: string): boolean {
  const expected = Buffer.from(env.ADMIN_API_KEY, 'utf8');
  const given = Buffer.from(provided, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** The real client IP, honouring one proxy hop (ngrok, a load balancer). */
export function clientIp(req: Request): string | null {
  const forwarded = req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  const raw = first || req.socket.remoteAddress || null;
  if (!raw) return null;
  // Postgres inet rejects the IPv4-mapped IPv6 form Node hands back on Windows.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Bearer-token gate for the admin API.
 *
 * With no ADMIN_API_KEY configured the whole admin surface is refused rather
 * than left open — an unset secret must never mean "no authentication".
 */
export function requireAdmin(req: AdminRequest, res: Response, next: NextFunction): void {
  if (!env.ADMIN_API_KEY) {
    res.status(503).json({ error: 'Admin API is disabled. Set ADMIN_API_KEY to enable it.' });
    return;
  }

  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token || !keyMatches(token)) {
    logger.warn({ ip: clientIp(req), path: req.path }, 'rejected admin request');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Optional label so the audit trail can distinguish two people sharing a key.
  req.adminActor = req.header('x-admin-actor')?.slice(0, 64) || 'admin';
  next();
}

/**
 * Fixed-window rate limit, keyed on IP. Redis-backed so it survives a restart
 * and works if you ever run more than one instance.
 */
export function adminRateLimit(maxRequests = 120, windowSeconds = 60) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = clientIp(req) ?? 'unknown';
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `ratelimit:admin:${ip}:${bucket}`;

    try {
      const hits = await redis.incr(key);
      if (hits === 1) await redis.expire(key, windowSeconds);
      if (hits > maxRequests) {
        res.status(429).json({ error: 'Too many requests' });
        return;
      }
    } catch (err) {
      // Never let a Redis blip lock out the admin panel.
      logger.warn({ err }, 'admin rate limit check failed, allowing request');
    }
    next();
  };
}

/**
 * Records every admin call with IP and user agent.
 *
 * This is the one place in the system where device data genuinely exists —
 * these requests come from a real browser, unlike WhatsApp traffic.
 */
export function adminAudit(req: AdminRequest, res: Response, next: NextFunction): void {
  const startedAt = Date.now();

  res.on('finish', () => {
    void query(
      `INSERT INTO admin_audit_log (actor, method, path, status_code, duration_ms, request_ip, user_agent, query)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        req.adminActor ?? 'anonymous',
        req.method,
        req.originalUrl.split('?')[0] ?? req.path,
        res.statusCode,
        Date.now() - startedAt,
        clientIp(req),
        req.header('user-agent')?.slice(0, 512) ?? null,
        JSON.stringify(req.query ?? {}),
      ],
    ).catch((err) => logger.warn({ err }, 'failed to write admin audit row'));
  });

  next();
}

/** Locks browser access to the origins you name; other callers use the key directly. */
export function adminCors(req: Request, res: Response, next: NextFunction): void {
  const allowed = env.ADMIN_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req.header('origin');

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Actor');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(origin && allowed.includes(origin) ? 204 : 403);
    return;
  }
  next();
}
