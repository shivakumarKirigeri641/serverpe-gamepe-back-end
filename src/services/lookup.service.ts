import { query, queryOne } from '../db/pool.js';

/**
 * Everything known about one mobile number, in a single response.
 *
 * Support questions arrive as "this number says X" — so the lookup is keyed on
 * the number, gathers every surface at once, and is deliberately generous:
 * chasing the same person across six screens is how details get missed.
 *
 * Admin only. None of this is ever exposed to a player.
 */
export async function lookupNumber(waId: string): Promise<Record<string, unknown> | null> {
  const player = await queryOne<{ id: string }>(
    `SELECT p.id, p.wa_id, p.display_name, p.locale, p.created_at, p.last_seen_at,
            p.is_blocked, p.blocked_at, p.blocked_reason, p.blocked_by,
            host(p.last_ip) AS last_ip, p.last_region, p.last_city, p.last_country,
            p.last_user_agent, p.last_device_at
       FROM players p WHERE p.wa_id = $1`,
    [waId],
  );

  // A number can be blocked without ever having been a player.
  const block = await queryOne(
    `SELECT wa_id, reason, category, blocked_by, blocked_at, notified_at
       FROM blocked_numbers WHERE wa_id = $1`,
    [waId],
  );

  const blockHistory = await query(
    `SELECT action, reason, category, performed_by, reported_by, created_at
       FROM player_blocks WHERE wa_id = $1 ORDER BY created_at DESC`,
    [waId],
  );

  if (!player) {
    return block || blockHistory.length
      ? { found: false, waId, block, blockHistory, reason: 'Number is blocked but has never played.' }
      : null;
  }

  const id = player.id;

  const [stats, wallet, consents, games, messages, events, taps, feedback, tickets, freeGames] =
    await Promise.all([
      queryOne(
        `SELECT COALESCE(games_played,0) AS games_played, COALESCE(prizes_won,0) AS prizes_won,
                COALESCE(full_houses,0) AS full_houses, COALESCE(points,0) AS points, last_played_at
           FROM player_stats WHERE player_id = $1`,
        [id],
      ),
      queryOne(
        `SELECT balance_paise, free_games, updated_at FROM wallets WHERE player_id = $1`,
        [id],
      ),
      query(
        `SELECT c.doc_key, c.version, c.accepted_at, c.source, COALESCE(d.title, c.doc_key) AS title
           FROM player_consents c LEFT JOIN legal_documents d ON d.doc_key = c.doc_key
          WHERE c.player_id = $1 ORDER BY c.accepted_at DESC`,
        [id],
      ),
      query(
        `SELECT g.id, g.room_code, g.status, g.created_at, g.ended_at, g.plan_key,
                (g.host_player_id = $1) AS was_host,
                (SELECT count(*)::int FROM game_draws d WHERE d.game_id = g.id) AS numbers,
                (SELECT count(*)::int FROM game_draw_responses r
                  WHERE r.game_id = g.id AND r.player_id = $1) AS answered,
                (SELECT count(*)::int FROM game_claims c
                  WHERE c.game_id = g.id AND c.player_id = $1 AND c.status = 'awarded') AS prizes
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          WHERE gp.player_id = $1 ORDER BY g.created_at DESC LIMIT 50`,
        [id],
      ),
      query(
        `SELECT m.created_at, m.direction, m.kind, m.status, m.body, m.error, g.room_code
           FROM message_log m LEFT JOIN games g ON g.id = m.game_id
          WHERE m.player_id = $1 ORDER BY m.created_at DESC LIMIT 300`,
        [id],
      ),
      query(
        `SELECT occurred_at, event_type, source, properties, host(request_ip) AS request_ip, user_agent
           FROM analytics_events WHERE player_id = $1 ORDER BY occurred_at DESC LIMIT 300`,
        [id],
      ),
      // Every button and list tap, which is what "what did they actually do"
      // usually means in a support conversation.
      query(
        `SELECT created_at, body->>'actionId' AS action, body->>'text' AS label, kind
           FROM message_log
          WHERE player_id = $1 AND direction = 'inbound'
            AND (body->>'actionId' IS NOT NULL OR kind = 'flow_reply')
          ORDER BY created_at DESC LIMIT 200`,
        [id],
      ),
      query(
        `SELECT f.created_at, f.rating, f.comment, g.room_code
           FROM game_feedback f LEFT JOIN games g ON g.id = f.game_id
          WHERE f.player_id = $1 ORDER BY f.created_at DESC`,
        [id],
      ),
      query(
        `SELECT id, reference, subject, status, priority, created_at
           FROM support_tickets WHERE player_id = $1 ORDER BY created_at DESC`,
        [id],
      ),
      query(
        `SELECT granted_at, quantity, reason, granted_by, campaign
           FROM free_game_grants WHERE player_id = $1 ORDER BY granted_at DESC`,
        [id],
      ),
    ]);

  const walletHistory = await query(
    `SELECT created_at, amount_paise, kind, note, created_by FROM wallet_transactions
      WHERE player_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [id],
  );

  return {
    found: true,
    player,
    block,
    blockHistory,
    stats,
    wallet,
    walletHistory,
    freeGames,
    consents,
    games,
    messages,
    events,
    taps,
    feedback,
    tickets,
    counts: {
      games: games.length,
      messagesIn: messages.filter((m) => m['direction'] === 'inbound').length,
      messagesOut: messages.filter((m) => m['direction'] === 'outbound').length,
      taps: taps.length,
      events: events.length,
    },
  };
}

/** Number search that also matches partial digits and display names. */
export async function searchNumbers(term: string, limit: number): Promise<Record<string, unknown>[]> {
  const digits = term.replace(/[^0-9]/g, '');
  return query(
    `SELECT p.id, p.wa_id, p.display_name, p.created_at, p.last_seen_at, p.is_blocked,
            p.last_region, p.last_city,
            (SELECT count(*)::int FROM game_players gp WHERE gp.player_id = p.id) AS games
       FROM players p
      WHERE ($1 <> '' AND p.wa_id LIKE '%' || $1 || '%')
         OR p.display_name ILIKE '%' || $2 || '%'
      ORDER BY p.last_seen_at DESC
      LIMIT $3`,
    [digits, term, limit],
  );
}
