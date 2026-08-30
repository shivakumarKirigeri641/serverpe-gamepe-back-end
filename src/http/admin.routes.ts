import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { queryOne } from '../db/pool.js';
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
import { listSessions, login, revokeSession } from '../services/admin-session.service.js';
import { playersByRegion } from '../services/geo.service.js';
import { lookupNumber, searchNumbers } from '../services/lookup.service.js';
import { previewPurge, purgeData } from '../services/purge.service.js';
import { documentStats, listDocuments, readDocument } from '../services/document.service.js';
import { getTrialSummary } from '../services/trial.service.js';
import {
  createOrder,
  listPaymentEvents,
  listPayments,
  paymentSummary,
  paymentsConfigured,
  paymentsLive,
  splitGst,
} from '../services/payment.service.js';
import {
  blockHistory,
  blockNumber,
  listBlocked,
  unblockNumber,
} from '../services/moderation.service.js';
import {
  getBusinessProfile,
  revenueByDay,
  updateBusinessProfile,
} from '../services/business.service.js';
import { feedbackSummary, listFeedback } from '../services/feedback.service.js';
import {
  adjustWallet,
  grantFreeGames,
  listFreeGameGrants,
  listWallets,
  walletHistory,
  walletTotals,
} from '../services/wallet.service.js';
import {
  getComparisons,
  getConversation,
  getLivePlayers,
  getLiveSnapshot,
  listConversations,
} from '../services/live.service.js';
import {
  addTicketMessage,
  createTicket,
  getTicket,
  listTickets,
  ticketStats,
  updateTicket,
} from '../services/support.service.js';
import {
  consentStats,
  getDocument,
  listAllDocuments,
  listPlayerConsents,
  upsertDocument,
} from '../services/consent.service.js';

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const uuidString = z.string().uuid();

/**
 * Typed to confirm a purge. Deliberately awkward to produce by accident, and
 * deliberately says what it does rather than "yes".
 */
const PURGE_PHRASE = 'DELETE ALL PLAYER DATA';

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

  /* ---------------------------------------------------------------- login */

  // Deliberately before requireAdmin: this is how a browser gets a token in
  // the first place. Rate limited and locked out per IP in the service.
  router.post('/session', async (req: Request, res: Response) => {
    const parsed = z
      .object({ passcode: z.string().min(1).max(64), label: z.string().max(64).optional() })
      .safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({ error: 'Passcode required' });
      return;
    }

    const outcome = await login(
      parsed.data.passcode,
      clientIp(req) ?? 'unknown',
      req.header('user-agent') ?? null,
      parsed.data.label,
    );

    if (outcome.ok) {
      res.json({ data: { token: outcome.session.token, expiresAt: outcome.session.expiresAt } });
      return;
    }
    if (outcome.reason === 'locked') {
      res
        .status(429)
        .json({ error: 'Too many attempts. Try again later.', retryAfterSeconds: outcome.retryAfterSeconds });
      return;
    }
    if (outcome.reason === 'disabled') {
      res.status(503).json({ error: 'Admin login is not configured.' });
      return;
    }
    res.status(401).json({ error: 'Incorrect passcode', attemptsRemaining: outcome.attemptsRemaining });
  });

  router.post('/session/logout', async (req: Request, res: Response) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) await revokeSession(token);
    res.json({ data: { ok: true } });
  });

  router.use(requireAdmin);
  router.use(adminAudit);

  router.get('/session/me', handle(async (req) => ({ actor: req.adminActor ?? 'admin' })));
  router.get('/sessions', handle(async () => listSessions()));

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


  /* -------------------------------------------------------------- revenue */

  router.get(
    '/revenue',
    handle(async (req) => {
      const { from, to } = rangeQuery.parse(req.query);
      const range = resolveRange(from, to);
      const [profile, daily] = await Promise.all([
        getBusinessProfile(),
        revenueByDay(range.from, range.to),
      ]);

      const totals = daily.reduce<{ grossPaise: number; netPaise: number; gstPaise: number; games: number }>(
        (acc, d) => ({
          grossPaise: acc.grossPaise + Number(d['grossPaise'] ?? 0),
          netPaise: acc.netPaise + Number(d['netPaise'] ?? 0),
          gstPaise: acc.gstPaise + Number(d['gstPaise'] ?? 0),
          games: acc.games + Number(d['games'] ?? 0),
        }),
        { grossPaise: 0, netPaise: 0, gstPaise: 0, games: 0 },
      );

      return {
        range,
        gstRatePct: profile ? profile.gst_rate_bp / 100 : 0,
        pricesIncludeGst: profile?.prices_include_gst ?? true,
        totals,
        daily,
      };
    }),
  );

  /* ------------------------------------------------------------- business */

  router.get(
    '/business',
    handle(async () => getBusinessProfile()),
  );

  router.put(
    '/business',
    handle(async (req) => {
      const input = z
        .object({
          legal_name: z.string().min(1).max(200).optional(),
          trade_name: z.string().min(1).max(200).optional(),
          owner_name: z.string().min(1).max(200).optional(),
          support_email: z.string().email().optional(),
          support_phone: z.string().max(40).nullable().optional(),
          gstin: z.string().max(20).nullable().optional(),
          pan: z.string().max(20).nullable().optional(),
          address_line1: z.string().max(200).optional(),
          address_line2: z.string().max(200).nullable().optional(),
          city: z.string().max(100).optional(),
          state: z.string().max(100).nullable().optional(),
          postal_code: z.string().max(20).nullable().optional(),
          country: z.string().max(100).optional(),
          website: z.string().max(200).nullable().optional(),
          gst_rate_bp: z.coerce.number().int().min(0).max(10000).optional(),
          prices_include_gst: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'business.update', fields: Object.keys(input) },
      });

      return updateBusinessProfile(input);
    }),
  );

  /* ------------------------------------------------------------- feedback */

  router.get(
    '/feedback',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      return { summary: await feedbackSummary(), items: await listFeedback(limit, offset) };
    }),
  );


  /* ------------------------------------------------------------- live ops */

  router.get(
    '/live',
    handle(async () => getLiveSnapshot()),
  );

  router.get(
    '/live/players',
    handle(async () => getLivePlayers()),
  );

  router.get(
    '/comparisons',
    handle(async () => getComparisons()),
  );

  /* -------------------------------------------------------- conversations */

  router.get(
    '/conversations',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const filter = z.enum(['hosts', 'players', 'all']).optional().parse(req.query['filter']);
      return listConversations(limit, offset, filter);
    }),
  );

  router.get(
    '/conversations/:id',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const { limit } = pageQuery.parse(req.query);
      return getConversation(id, limit);
    }),
  );

  /* -------------------------------------------------------------- support */

  router.get(
    '/support/tickets',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const status = z
        .enum(['open', 'in_progress', 'waiting_on_player', 'resolved', 'closed'])
        .optional()
        .parse(req.query['status']);
      return { stats: await ticketStats(), items: await listTickets(limit, offset, status) };
    }),
  );

  router.get(
    '/support/tickets/:id',
    handle(async (req) => getTicket(uuidString.parse(req.params['id']))),
  );

  router.post(
    '/support/tickets',
    handle(async (req) => {
      const input = z
        .object({
          playerId: uuidString.nullable().optional(),
          waId: z.string().max(20).nullable().optional(),
          gameId: uuidString.nullable().optional(),
          subject: z.string().min(1).max(200),
          body: z.string().min(1).max(5000),
          category: z.string().max(64).nullable().optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
        })
        .parse(req.body ?? {});
      return createTicket(input);
    }),
  );

  router.patch(
    '/support/tickets/:id',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const changes = z
        .object({
          status: z.enum(['open', 'in_progress', 'waiting_on_player', 'resolved', 'closed']).optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          assigned_to: z.string().max(64).nullable().optional(),
          category: z.string().max(64).nullable().optional(),
        })
        .parse(req.body ?? {});

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'support.update', ticketId: id, changes },
      });

      return updateTicket(id, changes);
    }),
  );

  router.post(
    '/support/tickets/:id/messages',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const body = z.object({ body: z.string().min(1).max(5000) }).parse(req.body ?? {});
      return addTicketMessage(id, 'admin', body.body, req.adminActor ?? 'admin');
    }),
  );


  /* -------------------------------------------------------------- credits */

  router.get(
    '/wallets',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      return { totals: await walletTotals(), items: await listWallets(limit, offset) };
    }),
  );

  router.get(
    '/wallets/:id',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const { limit } = pageQuery.parse(req.query);
      return { player: await getPlayer(id), history: await walletHistory(id, limit) };
    }),
  );

  /**
   * Moves credit into or out of a wallet.
   *
   * The note is required, not optional: goodwill for a fault and a promotional
   * credit are the same movement of money, and six months later only the note
   * tells them apart.
   */
  router.post(
    '/wallets/:id/adjust',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const input = z
        .object({
          amountPaise: z.coerce.number().int().refine((n) => n !== 0, 'Amount cannot be zero'),
          kind: z.enum(['topup', 'goodwill', 'promo_credit', 'refund', 'adjustment']),
          note: z.string().min(3).max(500),
        })
        .parse(req.body ?? {});

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        playerId: id,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: {
          action: 'wallet.adjust',
          amountPaise: input.amountPaise,
          kind: input.kind,
          note: input.note,
        },
      });

      return adjustWallet(id, input.amountPaise, input.kind, input.note, req.adminActor ?? 'admin');
    }),
  );


  /**
   * Gives a player one or more free games.
   *
   * Counted in games rather than rupees: a comp was never paid for, so adding
   * its value to the wallet would overstate both revenue and the money owed
   * back to players.
   */
  router.post(
    '/wallets/:id/free-games',
    handle(async (req) => {
      const id = uuidString.parse(req.params['id']);
      const input = z
        .object({
          quantity: z.coerce.number().int().min(-20).max(20).refine((n) => n !== 0, 'Cannot be zero'),
          reason: z.string().min(3).max(500),
          campaign: z.string().max(64).optional(),
        })
        .parse(req.body ?? {});

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        playerId: id,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'wallet.free_games', ...input },
      });

      return grantFreeGames(id, input.quantity, input.reason, req.adminActor ?? 'admin', input.campaign);
    }),
  );

  router.get(
    '/free-games',
    handle(async (req) => {
      const { limit } = pageQuery.parse(req.query);
      return listFreeGameGrants(limit);
    }),
  );



  /* --------------------------------------------------------------- lookup */

  router.get(
    '/lookup/search',
    handle(async (req) => {
      const term = z.string().min(2).max(64).parse(req.query['q']);
      const { limit } = pageQuery.parse(req.query);
      return searchNumbers(term, limit);
    }),
  );

  /** Everything known about one number, in one response. */
  router.get(
    '/lookup/:waId',
    handle(async (req) => {
      const waId = z
        .string()
        .min(6)
        .max(20)
        .transform((v) => v.replace(/[^0-9]/g, ''))
        .parse(req.params['waId']);

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: req.adminActor ?? null,
        waId,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'lookup', waId },
      });

      return lookupNumber(waId);
    }),
  );

  /* ----------------------------------------------------------- moderation */

  router.get(
    '/regions',
    handle(async () => playersByRegion()),
  );

  router.get(
    '/blocked',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      return listBlocked(limit, offset);
    }),
  );

  router.get(
    '/blocked/:waId/history',
    handle(async (req) => blockHistory(z.string().min(6).max(20).parse(req.params['waId']))),
  );

  /**
   * Blocks a number.
   *
   * Keyed on the number rather than the player row, so it holds even if the
   * record is deleted and the number returns. A reason is required: a block
   * with no stated cause cannot be defended if it is appealed.
   */
  router.post(
    '/blocked',
    handle(async (req) => {
      const input = z
        .object({
          waId: z.string().min(6).max(20).regex(/^[0-9]+$/, 'digits only, no + or spaces'),
          reason: z.string().min(3).max(500),
          category: z.string().max(64).optional(),
          reportedBy: z.string().max(64).optional(),
        })
        .parse(req.body ?? {});

      return blockNumber({ ...input, performedBy: req.adminActor ?? 'admin' });
    }),
  );

  /**
   * Blocks or unblocks many numbers in one action.
   *
   * A report rarely names one number — it names a group who were doing the same
   * thing in the same room. Doing them one at a time means a half-applied block
   * if the panel is closed midway, and a different reason typed on each.
   *
   * Each number is applied independently so one bad entry in a pasted list does
   * not discard the rest; the response says exactly which ones failed.
   */
  router.post(
    '/blocked/bulk',
    handle(async (req) => {
      const input = z
        .object({
          waIds: z.array(z.string().min(6).max(20)).min(1).max(500),
          action: z.enum(['block', 'unblock']),
          reason: z.string().min(3).max(500),
          category: z.string().max(64).optional(),
          reportedBy: z.string().max(64).optional(),
        })
        .parse(req.body ?? {});

      const actor = req.adminActor ?? 'admin';
      const digits = [...new Set(input.waIds.map((w) => w.replace(/[^0-9]/g, '')))].filter(
        (w) => w.length >= 10,
      );

      const applied: string[] = [];
      const failed: { waId: string; error: string }[] = [];

      for (const waId of digits) {
        try {
          if (input.action === 'block') {
            await blockNumber({
              waId,
              reason: input.reason,
              category: input.category,
              reportedBy: input.reportedBy,
              performedBy: actor,
            });
          } else {
            await unblockNumber(waId, input.reason, actor);
          }
          applied.push(waId);
        } catch (err) {
          failed.push({ waId, error: err instanceof Error ? err.message : 'failed' });
        }
      }

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: actor,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: {
          action: `moderation.bulk_${input.action}`,
          count: applied.length,
          failed: failed.length,
        },
      });

      return { action: input.action, applied, failed, skipped: input.waIds.length - digits.length };
    }),
  );

  router.delete(
    '/blocked/:waId',
    handle(async (req) => {
      const waId = z.string().min(6).max(20).parse(req.params['waId']);
      const reason = z.string().min(3).max(500).parse(
        (req.body as { reason?: string } | undefined)?.reason ?? 'Unblocked by admin',
      );
      return unblockNumber(waId, reason, req.adminActor ?? 'admin');
    }),
  );

  /* --------------------------------------------------------- payments */

  /**
   * Payments, and whether the integration is even switched on.
   *
   * The status block is here because "no payments yet" and "payments are
   * misconfigured" look identical from an empty table, and only one of them is
   * a problem.
   */
  router.get(
    '/payments',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const [payments, summary, events] = await Promise.all([
        listPayments(limit, offset),
        paymentSummary(),
        listPaymentEvents(50),
      ]);
      return {
        status: {
          enabled: paymentsLive(),
          configured: paymentsConfigured(),
          gstPercent: env.GST_PERCENT,
          gstInclusive: env.GST_INCLUSIVE,
          webhookSecretSet: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
          keyMode: env.RAZORPAY_KEY_ID.startsWith('rzp_live') ? 'live' : 'test',
        },
        summary,
        payments,
        events,
      };
    }),
  );

  /** What a given amount splits into, for checking the GST setting is right. */
  router.get(
    '/payments/quote',
    handle(async (req) => {
      const amount = z.coerce.number().int().min(100).parse(req.query['amountPaise']);
      return { amountPaise: amount, ...splitGst(amount) };
    }),
  );

  /**
   * Creates an order by hand.
   *
   * Admin-only for now, because there is no player-facing payment surface yet.
   * It exists so the whole path — order, checkout, webhook, wallet credit — can
   * be exercised end to end against Razorpay test keys before a single player
   * is shown a price.
   */
  router.post(
    '/payments/order',
    handle(async (req) => {
      const input = z
        .object({
          waId: z.string().min(6).max(20),
          amountPaise: z.number().int().min(100),
          planKey: z.string().max(64).optional(),
          creditsPaise: z.number().int().min(0).optional(),
        })
        .parse(req.body ?? {});

      const player = await queryOne<{ id: string }>(
        'SELECT id FROM players WHERE wa_id = $1',
        [input.waId.replace(/[^0-9]/g, '')],
      );
      if (!player) throw new Error('No player with that number');

      return createOrder({
        playerId: player.id,
        waId: input.waId,
        planKey: input.planKey ?? null,
        amountPaise: input.amountPaise,
        creditsPaise: input.creditsPaise,
      });
    }),
  );

  /* ------------------------------------------------------------ trial */

  router.get(
    '/trial',
    handle(async () => getTrialSummary()),
  );

  /* -------------------------------------------------------- documents */

  router.get(
    '/documents',
    handle(async (req) => {
      const { limit, offset } = pageQuery.parse(req.query);
      const kind = z.enum(['report', 'invoice']).optional().parse(req.query['kind']);
      const [documents, stats] = await Promise.all([
        listDocuments(kind, limit, offset),
        documentStats(),
      ]);
      return { documents, stats };
    }),
  );

  /**
   * Streams a stored PDF.
   *
   * Sent inline rather than as an attachment so it opens in the browser's own
   * viewer — checking a report usually means glancing at it, not filing it.
   */
  router.get('/documents/:id/file', async (req: AdminRequest, res: Response) => {
    const id = uuidString.safeParse(req.params['id']);
    if (!id.success) {
      res.status(400).json({ error: 'bad document id' });
      return;
    }

    const file = await readDocument(id.data);
    if (!file) {
      res.status(404).json({ error: 'document not found' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.setHeader('Content-Length', String(file.buffer.byteLength));
    res.send(file.buffer);
  });

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

  router.get(
    '/maintenance/purge',
    handle(async () => previewPurge()),
  );

  /**
   * Deletes every player and game record, keeping the reference tables.
   *
   * Irreversible, so it is gated on typing the phrase rather than on a button
   * alone — a confirm dialog is one stray double-click, a typed phrase is not.
   * The audit entry is written after the wipe, since the audit table is one of
   * the things being cleared.
   */
  router.post(
    '/maintenance/purge',
    handle(async (req) => {
      z.object({ confirm: z.literal(PURGE_PHRASE, { errorMap: () => ({ message: `type "${PURGE_PHRASE}" to confirm` }) }) })
        .parse(req.body ?? {});

      const actor = req.adminActor ?? 'admin';
      const result = await purgeData(actor);

      await track({
        type: EVENT.ADMIN_REQUEST,
        source: 'admin',
        adminActor: actor,
        requestIp: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
        properties: { action: 'maintenance.purge', ...result },
      });

      return result;
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
