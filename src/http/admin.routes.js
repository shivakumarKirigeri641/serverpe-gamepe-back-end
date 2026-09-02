/**
 * The admin API.
 *
 * Two conventions the panel depends on:
 *   - every success is wrapped as { data: ... }
 *   - every failure is { error: "<sentence>" } with a real status code
 *
 * Everything except POST /session requires a bearer token.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { query } from '../db/pool.js';
import { requestInfo } from '../utils/request-info.js';
import { geoStatus } from '../services/geo.service.js';
import { listenerCount } from '../services/live.service.js';
import {
  login, revokeSession, listSessions, requireAdmin, purgeExpired,
} from '../services/admin-session.service.js';
import * as data from '../services/admin-data.service.js';
import { POLICY_VERSION } from '../services/player.service.js';
import * as settings from '../services/settings.service.js';
import * as support from '../services/support.service.js';
import * as alerts from '../services/notification.service.js';
import { verifyMail, mailConfigured } from '../services/mailer.service.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ok = (res, payload) => res.json({ data: payload });

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * Guards every ":id" route.
 *
 * Number('abc') and Number(undefined) are both NaN, and handing NaN to
 * Postgres raises an error that surfaces as a bare 500. The panel asks for
 * /players/undefined whenever a link is built before its data has loaded, so
 * this is a routine request, not an attack - it deserves a clear 400.
 */
function idParam(req, res, next) {
  const raw = req.params.id;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ error: `"${raw}" is not a valid id` });
  }
  req.id = n;
  next();
}

export function adminRoutes() {
  const router = Router();

  // ─── auth ────────────────────────────────────────────────────────────────

  router.post('/session', wrap(async (req, res) => {
    const result = await login(req, {
      passcode: String(req.body?.passcode ?? ''),
      label: req.body?.label ? String(req.body.label).slice(0, 60) : null,
    });

    if (!result.ok) {
      return res.status(result.status ?? 401).json({
        error: result.reason,
        attemptsRemaining: result.attemptsRemaining,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    ok(res, { token: result.token, expiresAt: result.expiresAt });
  }));

  // Everything below this line needs a valid session.
  router.use(requireAdmin());

  router.post('/session/logout', wrap(async (req, res) => {
    const header = req.get('authorization') || '';
    if (header.startsWith('Bearer ')) await revokeSession(header.slice(7).trim());
    ok(res, { ok: true });
  }));

  router.get('/sessions', wrap(async (_req, res) => ok(res, await listSessions())));

  // ─── dashboard ───────────────────────────────────────────────────────────

  router.get('/overview',    wrap(async (_q, res) => ok(res, await data.overview())));
  router.get('/comparisons', wrap(async (_q, res) => ok(res, await data.comparisons())));

  router.get('/metrics/daily', wrap(async (req, res) =>
    ok(res, await data.dailyMetrics({ days: int(req.query.days, 30) }))));

  // ─── live ────────────────────────────────────────────────────────────────

  router.get('/live', wrap(async (_req, res) => {
    const snapshot = await data.live();
    // How many browsers are actually holding a stream open right now. Only
    // this process knows, so it is attached here rather than queried.
    for (const g of snapshot.games) g.watchers = listenerCount(g.id);
    ok(res, snapshot);
  }));

  router.get('/live/players', wrap(async (_q, res) => ok(res, await data.livePlayers())));

  // ─── players ─────────────────────────────────────────────────────────────

  router.get('/players', wrap(async (req, res) =>
    ok(res, await data.listPlayers({
      limit: int(req.query.limit, 100),
      q: req.query.query || req.query.q || null,
    }))));

  router.get('/players/:id', idParam, wrap(async (req, res) => {
    const player = await data.playerDetail(req.id);
    if (!player) return res.status(404).json({ error: 'No such player' });
    ok(res, {
      detail: player,
      consents: await data.playerConsents(player.id),
      timeline: await data.playerTimeline(player.id, 60),
      sessions: await data.playerSessions(player.id),
      games: await data.playerGames(player.id),
      // Wallets are part of monetisation, which is dormant during the free
      // trial. Reported honestly rather than faked with zeroes.
      wallet: null,
    });
  }));

  router.get('/players/:id/consents', idParam, wrap(async (req, res) =>
    ok(res, await data.playerConsents(req.id))));

  router.get('/players/:id/timeline', idParam, wrap(async (req, res) =>
    ok(res, await data.playerTimeline(req.id, int(req.query.limit, 60)))));

  // ─── lookup ──────────────────────────────────────────────────────────────

  router.get('/lookup/search', wrap(async (req, res) =>
    ok(res, await data.lookupSearch(String(req.query.q ?? ''), int(req.query.limit, 25)))));

  router.get('/lookup/:waId', wrap(async (req, res) => {
    const found = await data.lookupByWaId(String(req.params.waId));
    if (!found) return res.status(404).json({ error: 'No player with that number' });
    ok(res, found);
  }));

  // ─── games ───────────────────────────────────────────────────────────────

  router.get('/games', wrap(async (req, res) =>
    ok(res, await data.listGames({
      limit: int(req.query.limit, 100),
      status: req.query.status || null,
    }))));

  router.get('/games/:id', idParam, wrap(async (req, res) => {
    const found = await data.gameDetail(req.id);
    if (!found) return res.status(404).json({ error: 'No such game' });
    ok(res, found);
  }));

  router.get('/games/:id/timeline', idParam, wrap(async (req, res) =>
    ok(res, await data.gameTimeline(req.id, int(req.query.limit, 400)))));

  // ─── game audit ──────────────────────────────────────────────────────────

  router.get('/audit/hosts', wrap(async (req, res) =>
    ok(res, await data.auditHosts({
      range: String(req.query.range ?? '7d'),
      search: req.query.search || null,
    }))));

  router.get('/audit/activity', wrap(async (req, res) =>
    ok(res, await data.auditActivity({ range: String(req.query.range ?? '7d') }))));

  router.get('/audit/games/:id', idParam, wrap(async (req, res) => {
    const found = await data.auditGame(req.id);
    if (!found) return res.status(404).json({ error: 'No such game' });
    ok(res, found);
  }));

  // ─── operations health ───────────────────────────────────────────────────

  router.get('/ops/health', wrap(async (req, res) =>
    ok(res, await data.opsHealth({ range: String(req.query.range ?? '7d') }))));

  router.get('/ops/heatmap', wrap(async (req, res) =>
    ok(res, await data.playHeatmap({ days: int(req.query.days, 30) }))));

  // ─── hosts ───────────────────────────────────────────────────────────────

  router.get('/hosts', wrap(async (req, res) =>
    ok(res, await data.listHosts({
      limit: int(req.query.limit, 100),
      offset: int(req.query.offset, 0) || 0,
      search: req.query.search || null,
    }))));

  router.get('/hosts/:id', idParam, wrap(async (req, res) => {
    const found = await data.hostDetail(req.id);
    if (!found) return res.status(404).json({ error: 'No such host' });
    ok(res, found);
  }));

  // ─── events ──────────────────────────────────────────────────────────────

  // Returns the ARRAY, not { events, types }. The panel fetches this and
  // /events/types separately and combines them itself, so wrapping the list in
  // an object made data.events.map() blow up the whole page.
  router.get('/events', wrap(async (req, res) =>
    ok(res, await data.listEvents({
      limit: int(req.query.limit, 200),
      type: req.query.type || null,
    }))));

  router.get('/events/types', wrap(async (req, res) =>
    ok(res, await data.eventTypes({ days: int(req.query.days, 30) }))));

  // ─── conversations ───────────────────────────────────────────────────────

  router.get('/conversations', wrap(async (req, res) =>
    ok(res, await data.listConversations({
      limit: int(req.query.limit, 100),
      filter: req.query.filter || null,
    }))));

  router.get('/conversations/:id', idParam, wrap(async (req, res) => {
    const thread = await data.conversation(req.id, int(req.query.limit, 200));
    if (!thread.player) return res.status(404).json({ error: 'No such player' });
    ok(res, thread);
  }));

  // ─── analytics ───────────────────────────────────────────────────────────

  router.get('/funnel', wrap(async (req, res) =>
    ok(res, await data.funnel({ days: int(req.query.days, 30) }))));

  router.get('/engagement/response-times', wrap(async (req, res) =>
    ok(res, await data.responseTimes({ days: int(req.query.days, 30) }))));

  router.get('/messages/delivery', wrap(async (req, res) =>
    ok(res, await data.messageDelivery({ days: int(req.query.days, 30) }))));

  router.get('/legal/consents/stats', wrap(async (_q, res) => ok(res, await data.consentStats())));

  // ─── feedback ────────────────────────────────────────────────────────────

  router.get('/feedback', wrap(async (req, res) =>
    ok(res, await data.listFeedback({ limit: int(req.query.limit, 100) }))));

  router.post('/feedback/:id/approve', idParam, wrap(async (req, res) => {
    await query(
      `UPDATE feedback SET approved_at = now(), approved_by = $2, display_as = $3 WHERE id = $1`,
      [req.id, req.admin?.label ?? 'admin', req.body?.displayAs ?? null],
    );
    ok(res, { ok: true });
  }));

  router.post('/feedback/:id/unapprove', idParam, wrap(async (req, res) => {
    await query(
      'UPDATE feedback SET approved_at = NULL, approved_by = NULL WHERE id = $1',
      [req.id],
    );
    ok(res, { ok: true });
  }));

  // ─── moderation ──────────────────────────────────────────────────────────

  router.get('/blocked', wrap(async (req, res) =>
    ok(res, await data.listBlocked({ limit: int(req.query.limit, 500) }))));

  router.get('/blocked/:waId/history', wrap(async (req, res) =>
    ok(res, await data.blockHistory(String(req.params.waId)))));

  router.post('/blocked', wrap(async (req, res) => {
    const waId = String(req.body?.wa_id ?? req.body?.waId ?? '').replace(/\D/g, '');
    if (!waId) return res.status(400).json({ error: 'A WhatsApp number is required' });
    await blockOne(waId, req);
    ok(res, { ok: true, blocked: [waId] });
  }));

  router.post('/blocked/bulk', wrap(async (req, res) => {
    const numbers = (Array.isArray(req.body?.numbers) ? req.body.numbers : [])
      .map((n) => String(n).replace(/\D/g, ''))
      .filter(Boolean);
    if (numbers.length === 0) return res.status(400).json({ error: 'No valid numbers supplied' });
    for (const waId of numbers) await blockOne(waId, req);
    ok(res, { ok: true, blocked: numbers });
  }));

  router.delete('/blocked/:waId', wrap(async (req, res) => {
    const waId = String(req.params.waId).replace(/\D/g, '');
    await query('DELETE FROM blocked_numbers WHERE wa_id = $1', [waId]);
    await query(
      `INSERT INTO block_history (wa_id, action, reason, performed_by)
            VALUES ($1, 'unblocked', $2, $3)`,
      [waId, req.body?.reason ?? null, req.admin?.label ?? 'admin'],
    );
    log.info('number unblocked', { waId, by: req.admin?.label });
    ok(res, { ok: true });
  }));

  async function blockOne(waId, req) {
    await query(
      `INSERT INTO blocked_numbers (wa_id, reason, category, blocked_by)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (wa_id) DO UPDATE
            SET reason = EXCLUDED.reason, category = EXCLUDED.category,
                blocked_by = EXCLUDED.blocked_by, blocked_at = now()`,
      [waId, req.body?.reason ?? null, req.body?.category ?? null, req.admin?.label ?? 'admin'],
    );
    await query(
      `INSERT INTO block_history (wa_id, action, reason, category, performed_by, reported_by)
            VALUES ($1, 'blocked', $2, $3, $4, $5)`,
      [waId, req.body?.reason ?? null, req.body?.category ?? null,
       req.admin?.label ?? 'admin', req.body?.reported_by ?? null],
    );
    log.info('number blocked', { waId, by: req.admin?.label });
  }

  // ─── settings ────────────────────────────────────────────────────────────

  router.get('/settings', wrap(async (_req, res) => {
    const { rows: tables } = await query(`
      SELECT relname AS table, n_live_tup::int AS rows
        FROM pg_stat_user_tables ORDER BY n_live_tup DESC`);

    ok(res, {
      business: data.businessProfile(config),
      docs: data.legalDocuments(config, POLICY_VERSION),
      // Read by the trial-date form on this screen.
      ...settings.trialState(),
      trial: await trialState(),
      game: config.game,
      whatsapp: {
        live: config.whatsapp.live,
        apiVersion: config.whatsapp.apiVersion,
        webhookPath: config.whatsapp.webhookPath,
        allowedRecipients: config.whatsapp.allowedRecipients,
      },
      geo: geoStatus(),
      consent: await data.consentStats(),
      sessions: await listSessions(),
      queues: await data.queueStats(),
    });
  }));

  router.get('/trial', wrap(async (req, res) => {
    const [state, report] = await Promise.all([
      trialState(),
      data.trialReport({ days: int(req.query.days, 30) }),
    ]);
    ok(res, {
      ...report,
      daysRemaining: state.days_left,
      // Rendered straight into a sentence by the panel, so it is formatted
      // here rather than shipped as a raw ISO timestamp.
      endsOn: new Date(state.free_trial_ends_at).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: config.timezone,
      }),
      endsAt: state.free_trial_ends_at,
      isOver: !state.active,
      monetizationEnabled: state.monetization_enabled,
    });
  }));

  router.get('/settings/trial', wrap(async (_q, res) => ok(res, settings.trialState())));

  /**
   * Saves the free-trial end date, or resets it to the .env default when
   * `endsAt` is null. Persisted rather than held in memory, so it survives a
   * restart - a trial date that quietly reverted on deploy would be worse than
   * not being editable at all.
   */
  router.put('/settings/trial', wrap(async (req, res) => {
    const endsAt = req.body?.endsAt ?? null;
    try {
      const state = await settings.setTrialEndsAt(endsAt, req.admin?.label ?? 'admin');
      ok(res, state);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // ─── deferred subsystems ─────────────────────────────────────────────────
  //
  // Payments, wallets, ticketing and notifications do not exist: the platform
  // is free during the trial and none of them has been built. These endpoints
  // answer with real, empty structures and an explicit `available: false`,
  // rather than 404ing and filling the panel's console with errors.
  //
  // Nothing here is invented. During a free trial the revenue genuinely is
  // zero and there genuinely are no wallets - the numbers are accurate, and
  // the flag says why.

  const notBuilt = (extra = {}) => ({ available: false, reason: 'Not enabled during the free trial', ...extra });

  router.get('/revenue', wrap(async (_q, res) => ok(res, notBuilt({
    daily: [],
    totals: { grossPaise: 0, netPaise: 0, gstPaise: 0, games: 0 },
    gstRatePct: 0,
    pricesIncludeGst: true,
  }))));

  router.get('/wallets', wrap(async (_q, res) => ok(res, notBuilt({
    items: [],
    totals: {
      total_balance_paise: 0, wallets_with_credit: 0,
      free_games_outstanding: 0, wallets: 0,
    },
  }))));

  router.get('/wallets/:id', idParam, wrap(async (_q, res) =>
    ok(res, notBuilt({ wallet: null, transactions: [] }))));

  // ─── support ─────────────────────────────────────────────────────────────

  router.get('/support/tickets', wrap(async (req, res) =>
    ok(res, await support.listTickets({
      limit: int(req.query.limit, 100),
      status: req.query.status || null,
    }))));

  router.get('/support/tickets/:id', idParam, wrap(async (req, res) => {
    const found = await support.getTicket(req.id);
    if (!found) return res.status(404).json({ error: 'No such ticket' });
    ok(res, found);
  }));

  /** Status or priority. A status change the player cares about is sent to them. */
  router.patch('/support/tickets/:id', idParam, wrap(async (req, res) => {
    try {
      const updated = await support.updateTicket(req.id, {
        status: req.body?.status,
        priority: req.body?.priority,
      }, req.admin?.label ?? 'admin');
      if (!updated) return res.status(404).json({ error: 'No such ticket' });
      ok(res, updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  /** An operator's reply. Recorded here, delivered on WhatsApp. */
  router.post('/support/tickets/:id/messages', idParam, wrap(async (req, res) => {
    const body = String(req.body?.body ?? '').trim();
    if (!body) return res.status(400).json({ error: 'A reply cannot be empty' });

    const updated = await support.replyToTicket(req.id, {
      body: body.slice(0, 2000),
      by: req.admin?.label ?? 'admin',
    });
    if (!updated) return res.status(404).json({ error: 'No such ticket' });
    ok(res, updated);
  }));

  router.get('/support/mail-check', wrap(async (_q, res) => ok(res, await verifyMail())));

  router.get('/documents', wrap(async (_q, res) => ok(res, [])));

  // ─── operator alerts ─────────────────────────────────────────────────────

  router.get('/notifications', wrap(async (_q, res) => ok(res, {
    status: alerts.status(),
    settings: await alerts.listSettings(),
    pending: (await alerts.digestPreview()).pending,
    preview: await alerts.digestPreview(),
    log: await alerts.recentLog(20),
  })));

  /** Turn one alert to instant, batched, or off. Takes effect immediately. */
  router.patch('/notifications/:key', wrap(async (req, res) => {
    try {
      const settings = await alerts.setMode(
        String(req.params.key),
        String(req.body?.mode ?? ''),
        req.admin?.label ?? 'admin',
      );
      ok(res, settings);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  /** Proves the SMTP credentials work without sending anything. */
  router.post('/notifications/verify', wrap(async (_q, res) => ok(res, await verifyMail())));

  /** Sends whatever is waiting, now, rather than at the next digest. */
  router.post('/notifications/send', wrap(async (req, res) =>
    ok(res, await alerts.sendDigest({ force: req.body?.force === true }))));

  // ─── maintenance window ──────────────────────────────────────────────────

  router.get('/maintenance', wrap(async (_q, res) => ok(res, settings.maintenance())));

  /**
   * Schedule, edit or lift planned downtime.
   *
   * Takes effect immediately across every surface: the WhatsApp bot starts
   * replying with the notice, and the marketing site reads the same state from
   * its public endpoint. No restart, no deploy.
   */
  router.put('/maintenance', wrap(async (req, res) => {
    try {
      const next = await settings.setMaintenance({
        enabled: req.body?.enabled,
        force: req.body?.force,
        from: req.body?.from,
        to: req.body?.to,
        message: req.body?.message,
      }, req.admin?.label ?? 'admin');

      log.warn('maintenance window changed', {
        by: req.admin?.label, active: next.active, from: next.from, to: next.to,
      });
      ok(res, next);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  router.get('/business', wrap(async (_q, res) => ok(res, data.businessProfile(config))));

  router.get('/legal/documents', wrap(async (_q, res) =>
    ok(res, data.legalDocuments(config, POLICY_VERSION))));

  router.get('/queues', wrap(async (_q, res) => ok(res, await data.queueStats())));

  /**
   * Two very different operations behind one button:
   *
   *   { scope: 'old' }  (default)  trims logs older than `days`
   *   { scope: 'all', confirm: 'DELETE ALL GAME DATA' }  empties every game
   *                                table, keeping moderation and admin records
   *
   * The full wipe needs the exact confirmation phrase. A destructive action
   * that fires on a single flag is one mis-click from erasing everything.
   */
  /** What a cleanup would delete. The panel shows this before asking. */
  router.get('/maintenance/purge', wrap(async (_q, res) => ok(res, await data.wipePreview())));

  router.post('/maintenance/purge', wrap(async (req, res) => {
    // The panel's own confirmation phrase. Anything else - including a missing
    // one - is refused: this erases every player and game on the platform.
    if (req.body?.confirm !== undefined || req.body?.scope === 'all') {
      if (req.body?.confirm !== data.PURGE_PHRASE) {
        return res.status(400).json({
          error: `Type "${data.PURGE_PHRASE}" exactly to confirm`,
          keptTables: data.PROTECTED_TABLES,
        });
      }

      const before = await data.wipePreview();
      const result = await data.wipeGameData();
      const rowsDeleted = Object.values(result.deleted).reduce((a, b) => a + b, 0);

      log.warn('FULL DATA WIPE', {
        by: req.admin?.label, ip: requestInfo(req).ip, rowsDeleted,
      });

      return ok(res, {
        rowsDeleted,
        tablesCleared: Object.keys(result.deleted).length,
        // No Redis and no job queue in this build - the draw scheduler polls
        // Postgres. Reported as zero so the panel's summary reads correctly.
        redisKeysDeleted: 0,
        drawJobsDropped: 0,
        keptTables: result.kept,
        deleted: result.deleted,
        totalBefore: before.totalRows,
      });
    }

    const days = int(req.body?.days, 90);
    const messages = await query(
      `DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [days]);
    const events = await query(
      `DELETE FROM analytics_events WHERE occurred_at < now() - make_interval(days => $1)`, [days]);
    const processed = await query(
      `DELETE FROM processed_messages WHERE received_at < now() - interval '7 days'`);
    const admin = await purgeExpired();

    log.warn('maintenance purge', { days, by: req.admin?.label });
    ok(res, {
      messages: messages.rowCount, events: events.rowCount,
      processed_messages: processed.rowCount, ...admin,
    });
  }));

  // ─── diagnostics ─────────────────────────────────────────────────────────

  router.get('/whoami', wrap(async (req, res) =>
    ok(res, { admin: req.admin, client: requestInfo(req) })));

  return router;
}

async function trialState() {
  const state = settings.trialState();
  const { rows } = await query('SELECT count(*)::int AS games FROM games');
  return {
    free_trial_ends_at: state.freeTrialEndsAt,
    days_left: state.daysRemaining,
    active: !state.isOver,
    monetization_enabled: state.monetizationEnabled,
    games_played: rows[0].games,
  };
}
