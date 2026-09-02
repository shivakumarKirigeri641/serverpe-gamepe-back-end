/**
 * Who did what, from where, on which device.
 *
 * Two things are recorded:
 *   - board_sessions: one row per (player, game, device), updated on each hit
 *   - analytics_events: the append-only audit trail
 *
 * A hard limitation worth stating plainly: WhatsApp traffic reaches us through
 * Meta's servers, so it carries NO client address and NO device. Everything
 * here is populated only once a player opens their board in a browser. A
 * player who never opens the board has device columns that stay null forever.
 * That is the transport, not a gap in the code.
 *
 * Every function here is best-effort. Tracking must never be the reason a
 * player cannot answer a number, so failures are logged and swallowed.
 */
import { query } from '../db/pool.js';
import { log } from '../utils/logger.js';
import { requestInfo, describeClient } from '../utils/request-info.js';
import { resolveSessionLocation } from './geo.service.js';

/**
 * Upserts the session for this device and refreshes the player's last-known
 * device columns, which is what the admin panel's "Where & device" block reads.
 *
 * @returns {Promise<number|null>} the session id, or null if tracking failed
 */
export async function touchSession(req, { gameId, playerId, isStreamOpen = false }) {
  const info = requestInfo(req);

  try {
    const { rows } = await query(
      `INSERT INTO board_sessions (
         game_id, player_id, ip, user_agent, device_type, os, os_version,
         browser, browser_version, in_app_browser, in_app_host, language, referer,
         stream_opens
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (game_id, player_id, md5(coalesce(ip,'') || coalesce(user_agent,'')))
       DO UPDATE SET
         hits         = board_sessions.hits + 1,
         stream_opens = board_sessions.stream_opens + $14,
         last_seen_at = now()
       RETURNING id`,
      [
        gameId, playerId, info.ip, info.userAgent, info.deviceType, info.os, info.osVersion,
        info.browser, info.browserVersion, info.isInAppBrowser, info.inAppHost,
        info.language, info.referer, isStreamOpen ? 1 : 0,
      ],
    );

    await query(
      `UPDATE players
          SET last_ip = $2, last_user_agent = $3, last_device_type = $4,
              last_os = $5, last_browser = $6,
              last_device_at = now(), last_seen_at = now()
        WHERE id = $1`,
      [playerId, info.ip, info.userAgent, info.deviceType, info.os, info.browser],
    );

    const sessionId = rows[0]?.id ?? null;

    // Fire-and-forget: the city is filled in a moment later, off the request
    // path, so a slow geo provider can never delay the board loading.
    resolveSessionLocation({ sessionId, playerId, ip: info.ip });

    return sessionId;
  } catch (err) {
    log.warn('could not record board session', { playerId, gameId, message: err.message });
    return null;
  }
}

/**
 * Appends one row to the audit trail.
 *
 * `req` is optional - system events (a draw, a game ending) have no request
 * behind them and simply carry no address.
 */
export async function recordEvent({
  type, source = 'board', playerId = null, gameId = null,
  sessionId = null, properties = {}, req = null,
}) {
  const info = req ? requestInfo(req) : null;
  try {
    await query(
      `INSERT INTO analytics_events
         (event_type, source, player_id, game_id, session_id, request_ip, user_agent, properties)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [type, source, playerId, gameId, sessionId, info?.ip ?? null, info?.userAgent ?? null, properties],
    );
  } catch (err) {
    log.warn('could not record event', { type, message: err.message });
  }
}

/** Both, in one call - what a board request almost always wants. */
export async function trackBoardRequest(req, { gameId, playerId, type, properties = {}, isStreamOpen = false }) {
  const sessionId = await touchSession(req, { gameId, playerId, isStreamOpen });
  await recordEvent({ type, source: 'board', playerId, gameId, sessionId, properties, req });

  if (type === 'board_open') {
    log.info('board opened', {
      gameId, playerId, client: describeClient(requestInfo(req)),
    });
  }
  return sessionId;
}
