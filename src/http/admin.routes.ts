import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { EVENT, track } from '../services/analytics.service.js';
import { backfillMetrics, latestMetricsDay, runMaintenance } from '../services/maintenance.service.js';
import {
  getDailyMetrics,
  getDeliveryStats,
  getEventTypeCounts,
  getFunnel,
  getGameDetail,
  getGameMessages,
  getLeaderboard,
  getOverview,
  getPlayer,
  getPlayerActivity,
  getPlayerTimeline,
  getResponseTimeHistogram,
  listAdminAudit,
  listEvents,
  listGames,
  listPlayers,
  resolveRange,
} from '../services/reporting.service.js';
import {
  adminAudit,
  adminCors,
  adminRateLimit,
  clientIp,
  requireAdmin,
  type AdminRequest,
} from './admin-auth.js';
import { drawQueue, maintenanceQueue } from '../workers/queue.js';
import {
  consentStats,
  getDocument,
  listAllDocuments,
  listPlayerConsents,
  upsertDocument,
} from '../services/consent.service.js';

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuidString = z.string().uuid();

const rangeQuery = z.object({ from: dayString.optional(), to: dayString.optional() });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Turns a thrown ZodError into a 400 instead of a 500. */
function handle(fn: (req: AdminRequest, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await fn(req as AdminRequest, res);
      if (!res.headersSent) res.json({ data });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid parameters', issues: err.issues });
        return;
      }
      logger.error({ err, path: req.path }, 'admin request failed');
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  };
}

/**
 * Read-only analytics API for the admin panel, plus two explicit maintenance
 * actions. Nothing here can alter a game in progress.
 *
 * Every route is behind a bearer key, rate limited per IP, and audited with the
 * caller's IP and user agent.
 */
export function createAdminRouter(): Router {
  const router = Router();

  router.use(adminCors);
  router.use(adminRateLimit());
  router.use(requireAdmin);
  router.use(adminAudit);

  /* ------------------------------------------------------------- summary */

  router.get(
    '/overview',
    handle(async () => ({
      ...(await getOverview()),
      metricsFreshTo: await latestMetricsDay(),
    })),
  );

  router.get(
    '/metrics/daily',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      return getDailyMetrics(resolveRange(from, to));
    }),
  );

  router.get(
    '/funnel',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      return getFunnel(resolveRange(from, to));
    }),
  );

  router.get(
    '/engagement/response-times',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      return getResponseTimeHistogram(resolveRange(from, to));
    }),
  );

  router.get(
    '/messages/delivery',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      return getDeliveryStats(resolveRange(from, to));
    }),
  );

  /* ------------------------------------------------------------- players */

  router.get(
    '/players',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const search = z.string().max(64).optional().parse(req.query['search']);
      return listPlayers(limit, offset, search);
    }),
  );

  router.get(
    '/players/:id',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const player = await getPlayer(id);
      if (!player) return null;
      const { from, to } = rangeQuery.parse(req.query);
      return { player, activity: await getPlayerActivity(id, resolveRange(from, to)) };
    }),
  );

  router.get(
    '/players/:id/timeline',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const { limit } = pageQuery.parse(req.query);
      return getPlayerTimeline(id, limit);
    }),
  );

  /* --------------------------------------------------------------- games */

  router.get(
    '/games',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const status = z
        .enum(['lobby', 'running', 'completed', 'cancelled'])
        .optional()
        .parse(req.query['status']);
      return listGames(limit, offset, status);
    }),
  );

  router.get(
    '/games/:id',
    handle(async (req) => getGameDetail(uuidString.parse(req.params['id']))),
  );

  router.get(
    '/games/:id/messages',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const { limit } = pageQuery.parse(req.query);
      return getGameMessages(id, limit);
    }),
  );

  /* -------------------------------------------------------------- events */

  router.get(
    '/events',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const filters = z
        .object({
          type: z.string().max(64).optional(),
          playerId: uuidString.optional(),
          gameId: uuidString.optional(),
          from: dayString.optional(),
          to: dayString.optional(),
        })
        .parse(req.query);
      return listEvents(limit, offset, filters);
    }),
  );

  router.get(
    '/events/types',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      return getEventTypeCounts(resolveRange(from, to));
    }),
  );

  /* --------------------------------------------------------------- misc */

  router.get(
    '/leaderboard',
    handle(async (req) => {
      const { limit } = pageQuery.parse(req.query);
      return getLeaderboard(limit);
    }),
  );

  router.get(
    '/audit',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      return listAdminAudit(limit, offset);
    }),
  );

  router.get(
    '/queues',
    handle(async () => ({
      draw: await drawQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      maintenance: await maintenanceQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    })),
  );


  /* --------------------------------------------------------------- legal */

  // Every player-facing word of the terms lives here, editable without a deploy.
  router.get(
    '/legal/documents',
    handle(async () => listAllDocuments()),
  );

  router.get(
    '/legal/documents/:key',
    handle(async (req) => {
      const key = z.string().min(1).max(64).parse(req.params['key']);
      return getDocument(key);
    }),
  );

  /**
   * Create or update a document.
   *
   * `bumpVersion: true` invalidates every existing consent for it and forces
   * players to accept again. Fixing a typo should not do that; changing what
   * someone is agreeing to must. Only a person can tell the difference, so it
   * is always explicit.
   */
  router.put(
    '/legal/documents/:key',
    handle(async (req) => {
      const key = z.string().min(1).max(64).parse(req.params['key']);
      const input = z
        .object({
          title: z.string().min(1).max(24),
          summary: z.string().min(1).max(72),
          body: z.string().min(1).max(20000),
          display_order: z.coerce.number().int().min(0).max(999).optional(),
          requires_consent: z.boolean().optional(),
          is_active: z.boolean().optional(),
          bumpVersion: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'legal.upsert', docKey: key, bumpVersion: input.bumpVersion ?? false },
      });

      return upsertDocument({ doc_key: key, ...input });
    }),
  );

  router.get(
    '/legal/consents/stats',
    handle(async () => consentStats()),
  );

  router.get(
    '/players/:id/consents',
    handle(async (req) => listPlayerConsents(uuidString.parse(req.params['id']))),
  );

  /* ---------------------------------------------------------- actions */

  router.post(
    '/maintenance/run',
    handle(async (req) => {
      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'maintenance.run' },
      });
      await runMaintenance();
      return { ok: true };
    }),
  );

  router.post(
    '/metrics/backfill',
    handle(async (req) => {
      const { from, to } = z.object({ from: dayString, to: dayString }).parse(req.body ?? {});
      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'metrics.backfill', from, to },
      });
      return { days: await backfillMetrics(from, to) };
    }),
  );

  return router;
}
