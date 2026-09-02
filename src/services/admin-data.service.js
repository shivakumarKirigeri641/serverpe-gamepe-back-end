/**
 * Every read the admin panel makes, in one place.
 *
 * These are reporting queries, not game logic - they only ever SELECT. Keeping
 * them together means the panel's data contract is inspectable in one file
 * rather than scattered across route handlers.
 *
 * Field names match what the panel already renders, so the shapes here are a
 * contract, not a preference.
 */
import { query } from '../db/pool.js';
import { CLAIMS } from '../games/tambola/claims.js';

/** Players never see each other's numbers; the operator's own panel does. */
const NAME = `COALESCE(p.display_name, 'Player ' || right(p.wa_id, 4))`;

// ─── Dashboard ─────────────────────────────────────────────────────────────

export async function overview() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM players)                                          AS total_players,
      (SELECT count(*) FROM games)                                            AS total_games,
      (SELECT count(*) FROM games WHERE status = 'finished')                  AS games_completed,
      (SELECT count(*) FROM messages WHERE direction = 'out')                 AS messages_out,
      (SELECT count(*) FROM messages WHERE direction = 'in')                  AS messages_in,
      (SELECT count(*) FROM messages WHERE direction = 'out'
                                       AND status = 'failed')                 AS messages_failed,
      (SELECT count(*) FROM analytics_events)                                 AS events_recorded,
      (SELECT count(*) FROM claims WHERE status = 'awarded')                  AS prizes_awarded,
      (SELECT count(*) FROM board_sessions)                                   AS board_sessions,
      (SELECT count(*) FROM blocked_numbers)                                  AS blocked
  `);
  return numify(rows[0]);
}

/**
 * Today vs yesterday, and this week vs last. The panel keys off `metric`, so
 * these labels must not drift.
 */
export async function comparisons() {
  const daily = await comparePeriod('1 day');
  const weekly = await comparePeriod('7 days');
  return { daily, weekly };
}

async function comparePeriod(span) {
  const { rows } = await query(`
    WITH bounds AS (
      SELECT now() - $1::interval AS now_from,
             now() - ($1::interval * 2) AS prev_from,
             now() - $1::interval AS prev_to
    )
    SELECT 'Active players' AS metric,
           (SELECT count(DISTINCT player_id) FROM analytics_events, bounds
             WHERE occurred_at >= now_from)                                       AS now,
           (SELECT count(DISTINCT player_id) FROM analytics_events, bounds
             WHERE occurred_at >= prev_from AND occurred_at < prev_to)            AS before
    UNION ALL
    SELECT 'Games created',
           (SELECT count(*) FROM games, bounds WHERE created_at >= now_from),
           (SELECT count(*) FROM games, bounds WHERE created_at >= prev_from AND created_at < prev_to)
    UNION ALL
    SELECT 'New players',
           (SELECT count(*) FROM players, bounds WHERE created_at >= now_from),
           (SELECT count(*) FROM players, bounds WHERE created_at >= prev_from AND created_at < prev_to)
    UNION ALL
    SELECT 'Prizes won',
           (SELECT count(*) FROM claims, bounds WHERE status='awarded' AND created_at >= now_from),
           (SELECT count(*) FROM claims, bounds WHERE status='awarded' AND created_at >= prev_from AND created_at < prev_to)
    UNION ALL
    SELECT 'Messages sent',
           (SELECT count(*) FROM messages, bounds WHERE direction='out' AND created_at >= now_from),
           (SELECT count(*) FROM messages, bounds WHERE direction='out' AND created_at >= prev_from AND created_at < prev_to)
  `, [span]);

  return rows.map((r) => {
    const now = Number(r.now);
    const before = Number(r.before);
    return {
      metric: r.metric,
      now,
      before,
      // null, not 0: "no change" and "nothing to compare against" are
      // different facts, and the panel renders them differently.
      changePct: before === 0 ? (now === 0 ? 0 : null) : Math.round(((now - before) / before) * 100),
    };
  });
}

/** One row per day, oldest first - the shape recharts wants. */
export async function dailyMetrics({ days = 30 } = {}) {
  const { rows } = await query(`
    WITH span AS (
      SELECT generate_series(
        (now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1),
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        '1 day'
      )::date AS day
    )
    SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
      (SELECT count(DISTINCT player_id) FROM analytics_events e
        WHERE (e.occurred_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)        AS active_players,
      (SELECT count(*) FROM players p
        WHERE (p.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)         AS new_players,
      (SELECT count(*) FROM games g
        WHERE (g.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)         AS games_started,
      (SELECT count(*) FROM games g
        WHERE g.status='finished'
          AND (g.ended_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)           AS games_completed,
      (SELECT count(*) FROM claims c
        WHERE c.status='awarded'
          AND (c.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)         AS claims_awarded,
      (SELECT count(*) FROM draw_answers a
        WHERE a.answer <> 'no_response'
          AND (a.answered_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)        AS acknowledgements
    FROM span s ORDER BY s.day
  `, [days]);
  return rows.map(numify);
}

// ─── Live ──────────────────────────────────────────────────────────────────

export async function live() {
  const counts = await query(`
    SELECT
      (SELECT count(*) FROM games WHERE status='running')                       AS games_running,
      (SELECT count(*) FROM games WHERE status='lobby')                         AS games_in_lobby,
      (SELECT count(*) FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE g.status='running' AND gp.left_at IS NULL)                        AS players_in_game,
      (SELECT count(*) FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE g.status='lobby' AND gp.left_at IS NULL)                          AS players_waiting,
      (SELECT count(DISTINCT player_id) FROM analytics_events
        WHERE occurred_at > now() - interval '5 minutes')                       AS active_5m,
      (SELECT count(*) FROM messages
        WHERE direction='in' AND created_at > now() - interval '1 hour')        AS said_hi_1h,
      (SELECT count(*) FROM messages
        WHERE direction='out' AND created_at > now() - interval '1 hour')       AS sent_1h,
      (SELECT count(*)::int FROM support_tickets
        WHERE status IN ('open','in_progress'))                                  AS tickets_open
  `);

  const games = await query(`
    SELECT g.id, g.code AS room_code, g.status, g.expected_players,
           g.cursor AS numbers_drawn,
           ${NAME} AS host_name, p.wa_id AS host_wa_id,
           (SELECT count(*) FROM game_players gp
             WHERE gp.game_id=g.id AND gp.left_at IS NULL)                       AS players,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.status='awarded')                        AS prizes_awarded,
           (SELECT d.value FROM draws d WHERE d.game_id=g.id
             ORDER BY d.seq DESC LIMIT 1)                                        AS last_number,
           (SELECT d.drawn_at FROM draws d WHERE d.game_id=g.id
             ORDER BY d.seq DESC LIMIT 1)                                        AS last_draw_at,
           g.created_at, g.started_at
      FROM games g JOIN players p ON p.id = g.host_player_id
     WHERE g.status IN ('running','lobby')
     ORDER BY g.status, g.created_at DESC
  `);

  // The live activity feed - what just happened, across every game.
  const recent = await query(`
    SELECT e.occurred_at, e.event_type, p.wa_id, ${NAME} AS display_name,
           g.code AS room_code
      FROM analytics_events e
      LEFT JOIN players p ON p.id = e.player_id
      LEFT JOIN games   g ON g.id = e.game_id
     WHERE e.occurred_at > now() - interval '30 minutes'
     ORDER BY e.occurred_at DESC
     LIMIT 40
  `);

  return {
    counts: numify(counts.rows[0]),
    games: games.rows.map(numify),
    recent: recent.rows,
  };
}

/** Everyone currently seated in a live or waiting game. */
export async function livePlayers() {
  const { rows } = await query(`
    SELECT p.id, p.wa_id, ${NAME} AS display_name,
           g.code AS room_code, g.status, gp.is_host,
           (SELECT count(*) FROM draw_answers a
             WHERE a.game_id=g.id AND a.player_id=p.id AND a.answer<>'no_response') AS answered,
           (SELECT max(a.answered_at) FROM draw_answers a
             WHERE a.game_id=g.id AND a.player_id=p.id)                             AS last_answer_at
      FROM game_players gp
      JOIN games g   ON g.id = gp.game_id
      JOIN players p ON p.id = gp.player_id
     WHERE g.status IN ('running','lobby') AND gp.left_at IS NULL
     ORDER BY g.code, gp.joined_at
  `);
  return rows.map(numify);
}

// ─── Players ───────────────────────────────────────────────────────────────

export async function listPlayers({ limit = 100, q = null } = {}) {
  const { rows } = await query(`
    SELECT p.id, p.wa_id, ${NAME} AS display_name, p.locale,
           p.created_at, p.last_seen_at,
           p.last_ip, p.last_user_agent, p.last_device_at,
           p.last_city, p.last_region, p.last_country,
           (b.wa_id IS NOT NULL) AS is_blocked,
           (SELECT count(*) FROM game_players gp WHERE gp.player_id=p.id)        AS games_played,
           (SELECT count(*) FROM claims c
             WHERE c.player_id=p.id AND c.status='awarded')                      AS prizes_won,
           (SELECT count(*) FROM claims c
             WHERE c.player_id=p.id AND c.status='awarded'
               AND c.claim_type='full_house')                                    AS full_houses
      FROM players p
      LEFT JOIN blocked_numbers b ON b.wa_id = p.wa_id
     WHERE ($2::text IS NULL
            OR p.wa_id ILIKE '%'||$2||'%'
            OR p.display_name ILIKE '%'||$2||'%')
     ORDER BY p.last_seen_at DESC
     LIMIT $1
  `, [limit, q]);
  return rows.map(numify);
}

export async function playerDetail(id) {
  const { rows } = await query(`
    SELECT p.*, ${NAME} AS display_name,
           (b.wa_id IS NOT NULL) AS is_blocked,
           (SELECT count(*) FROM game_players gp WHERE gp.player_id=p.id)   AS games_played,
           (SELECT count(*) FROM games g WHERE g.host_player_id=p.id)       AS games_hosted,
           (SELECT count(*) FROM claims c
             WHERE c.player_id=p.id AND c.status='awarded')                 AS prizes_won,
           (SELECT count(*) FROM claims c
             WHERE c.player_id=p.id AND c.status='awarded'
               AND c.claim_type='full_house')                               AS full_houses,
           (SELECT count(*) FROM draw_answers a
             WHERE a.player_id=p.id AND a.was_correct)                      AS correct_answers,
           (SELECT count(*) FROM draw_answers a WHERE a.player_id=p.id)     AS total_answers
      FROM players p
      LEFT JOIN blocked_numbers b ON b.wa_id = p.wa_id
     WHERE p.id = $1
  `, [id]);
  if (!rows[0]) return null;

  const player = numify(rows[0]);
  // Points are derived, not stored: a stored counter would drift the first
  // time a game was replayed or a claim reversed.
  player.points = player.prizes_won * 10 + player.correct_answers;
  return player;
}

export async function playerConsents(id) {
  const { rows } = await query(`
    SELECT policy_version AS version, agreed_at AS accepted_at, source,
           'Terms, Privacy & Fair Play' AS title
      FROM consents WHERE player_id = $1 ORDER BY agreed_at DESC
  `, [id]);
  return rows;
}

export async function playerTimeline(id, limit = 60) {
  const { rows } = await query(`
    SELECT e.occurred_at, e.event_type, e.source, e.request_ip, e.properties,
           g.code AS room_code
      FROM analytics_events e
      LEFT JOIN games g ON g.id = e.game_id
     WHERE e.player_id = $1
     ORDER BY e.occurred_at DESC
     LIMIT $2
  `, [id, limit]);
  return rows;
}

/** The board devices a player has used - the "Where & device" detail. */
export async function playerSessions(id) {
  const { rows } = await query(`
    SELECT bs.*, g.code AS room_code
      FROM board_sessions bs
      LEFT JOIN games g ON g.id = bs.game_id
     WHERE bs.player_id = $1
     ORDER BY bs.last_seen_at DESC
     LIMIT 50
  `, [id]);
  return rows.map(numify);
}

// ─── Lookup ────────────────────────────────────────────────────────────────

export async function lookupSearch(term, limit = 25) {
  const { rows } = await query(`
    SELECT p.id, p.wa_id, ${NAME} AS display_name, p.last_seen_at
      FROM players p
     WHERE p.wa_id ILIKE '%'||$1||'%' OR p.display_name ILIKE '%'||$1||'%'
     ORDER BY p.last_seen_at DESC LIMIT $2
  `, [term, limit]);
  return rows;
}

export async function lookupByWaId(waId) {
  const { rows } = await query('SELECT id FROM players WHERE wa_id = $1', [waId]);
  if (!rows[0]) return null;
  const id = rows[0].id;

  const [player, consents, events, games, sessions, messages] = await Promise.all([
    playerDetail(id),
    playerConsents(id),
    playerTimeline(id, 100),
    playerGames(id),
    playerSessions(id),
    conversation(id, 50),
  ]);

  return { player, consents, events, games, sessions, messages: messages.messages };
}

export async function playerGames(id, limit = 50) {
  const { rows } = await query(`
    SELECT g.id, g.code AS room_code, g.status, g.created_at, g.ended_at,
           gp.is_host, g.cursor AS numbers_called, g.expected_players,
           (SELECT count(*) FROM game_players x
             WHERE x.game_id=g.id AND x.left_at IS NULL)                  AS players,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.player_id=$1 AND c.status='awarded') AS prizes_won
      FROM game_players gp JOIN games g ON g.id = gp.game_id
     WHERE gp.player_id = $1
     ORDER BY g.created_at DESC LIMIT $2
  `, [id, limit]);
  return rows.map(numify);
}

// ─── Games ─────────────────────────────────────────────────────────────────

export async function listGames({ limit = 100, status = null } = {}) {
  const { rows } = await query(`
    SELECT g.id, g.code AS room_code, g.status, g.game_key, g.plan_key,
           g.charged_paise, g.expected_players, g.cursor AS numbers_drawn,
           g.created_at, g.started_at, g.ended_at, g.ended_reason,
           g.host_player_id, ${NAME} AS host_name, p.wa_id AS host_wa_id,
           (SELECT count(*) FROM game_players gp
             WHERE gp.game_id=g.id AND gp.left_at IS NULL)                AS players,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.status='awarded')                 AS prizes_awarded,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.status='rejected')                AS claims_rejected
      FROM games g JOIN players p ON p.id = g.host_player_id
     WHERE ($2::text IS NULL OR g.status = $2)
     ORDER BY g.created_at DESC LIMIT $1
  `, [limit, status]);
  return rows.map(numify);
}

export async function gameDetail(id) {
  const games = await listGames({ limit: 1 });
  void games;
  const { rows } = await query(`
    SELECT g.*, ${NAME} AS host_name, p.wa_id AS host_wa_id
      FROM games g JOIN players p ON p.id = g.host_player_id
     WHERE g.id = $1
  `, [id]);
  if (!rows[0]) return null;

  const game = rows[0];
  // The full 90-number sequence is an internal artefact and huge; the panel
  // reads the `draws` table instead.
  delete game.sequence;

  const [players, draws, claims] = await Promise.all([
    query(`
      SELECT p.id, p.wa_id, ${NAME} AS display_name, gp.is_host, gp.joined_at, gp.left_at,
             (SELECT count(*) FROM draw_answers a
               WHERE a.game_id=$1 AND a.player_id=p.id AND a.answer<>'no_response') AS answered,
             (SELECT count(*) FROM draw_answers a
               WHERE a.game_id=$1 AND a.player_id=p.id AND a.was_correct)           AS correct
        FROM game_players gp JOIN players p ON p.id=gp.player_id
       WHERE gp.game_id=$1 ORDER BY gp.joined_at`, [id]),
    query('SELECT seq, value, drawn_at FROM draws WHERE game_id=$1 ORDER BY seq', [id]),
    query(`
      SELECT c.claim_type, c.status, c.seq AS draw_seq, c.reason, c.created_at,
             ${NAME} AS display_name, p.wa_id
        FROM claims c JOIN players p ON p.id=c.player_id
       WHERE c.game_id=$1 ORDER BY c.created_at`, [id]),
  ]);

  return {
    game: numify(game),
    players: players.rows.map(numify),
    draws: draws.rows.map(numify),
    claims: claims.rows,
    prizes: CLAIMS.map((c) => ({
      key: c.key,
      label: c.label,
      winner: claims.rows.find((x) => x.claim_type === c.key && x.status === 'awarded')?.display_name ?? null,
    })),
  };
}

/** Draws and claims interleaved, for the game replay view. */
export async function gameTimeline(id, limit = 400) {
  const { rows } = await query(`
    SELECT * FROM (
      SELECT d.drawn_at AS at, 'draw' AS kind, d.seq,
             d.value::text AS detail, NULL AS wa_id, NULL AS display_name
        FROM draws d WHERE d.game_id = $1
      UNION ALL
      SELECT c.created_at, 'claim_'||c.status, c.seq,
             c.claim_type, p.wa_id, ${NAME}
        FROM claims c JOIN players p ON p.id=c.player_id WHERE c.game_id = $1
      UNION ALL
      SELECT gp.joined_at, 'join', NULL, NULL, p.wa_id, ${NAME}
        FROM game_players gp JOIN players p ON p.id=gp.player_id WHERE gp.game_id = $1
    ) t ORDER BY at LIMIT $2
  `, [id, limit]);
  return rows.map(numify);
}

// ─── Game audit ────────────────────────────────────────────────────────────

/**
 * A time window, as SQL.
 *
 * The panel asks for "last 24 hours" or "this week" rather than dates, so the
 * bucket size for the accompanying chart is derived from the range instead of
 * being a second thing the operator has to choose - an hourly chart over 90
 * days is unreadable, and a daily chart over one hour is a single bar.
 */
export function rangeToInterval(range) {
  const map = {
    '1h': { interval: '1 hour', bucket: 'minute', label: 'Last hour' },
    '6h': { interval: '6 hours', bucket: 'hour', label: 'Last 6 hours' },
    '24h': { interval: '24 hours', bucket: 'hour', label: 'Last 24 hours' },
    '7d': { interval: '7 days', bucket: 'day', label: 'Last 7 days' },
    '30d': { interval: '30 days', bucket: 'day', label: 'Last 30 days' },
    '90d': { interval: '90 days', bucket: 'week', label: 'Last 90 days' },
  };
  return map[range] ?? map['7d'];
}

/**
 * Games grouped under the host who ran them, for a time window.
 *
 * This is the audit entry point: pick a host's number, see their games, open
 * one and read every player's ticket and every tap.
 */
export async function auditHosts({ range = '7d', search = null } = {}) {
  const { interval } = rangeToInterval(range);
  const { rows } = await query(`
    SELECT p.id AS host_id, p.wa_id AS host_wa_id, ${NAME} AS host_name,
           p.last_city, p.last_country,
           count(g.id)::int                                        AS games,
           count(g.id) FILTER (WHERE g.status='finished')::int      AS finished,
           count(g.id) FILTER (WHERE g.status='abandoned')::int     AS abandoned,
           max(g.created_at)                                        AS last_game_at,
           sum(g.cursor)::int                                       AS numbers_called,
           (SELECT count(DISTINCT gp.player_id)::int FROM game_players gp
             WHERE gp.game_id IN (SELECT id FROM games WHERE host_player_id = p.id
                                    AND created_at > now() - $1::interval)) AS distinct_players
      FROM games g
      JOIN players p ON p.id = g.host_player_id
     WHERE g.created_at > now() - $1::interval
       AND ($2::text IS NULL OR p.wa_id ILIKE '%'||$2||'%' OR p.display_name ILIKE '%'||$2||'%')
     GROUP BY p.id, p.wa_id, p.display_name, p.last_city, p.last_country
     ORDER BY max(g.created_at) DESC
  `, [interval, search]);

  const hosts = rows.map(numify);

  // Their games, in one round trip rather than one query per host.
  const ids = hosts.map((h) => h.host_id);
  if (ids.length === 0) return [];

  const { rows: games } = await query(`
    SELECT g.id, g.host_player_id, g.code AS room_code, g.status, g.created_at,
           g.started_at, g.ended_at, g.ended_reason, g.expected_players,
           g.cursor AS numbers_called,
           (SELECT count(*)::int FROM game_players gp
             WHERE gp.game_id = g.id AND gp.left_at IS NULL)          AS players,
           (SELECT count(*)::int FROM claims c
             WHERE c.game_id = g.id AND c.status='awarded')           AS prizes_awarded,
           EXTRACT(EPOCH FROM (COALESCE(g.ended_at, now()) - g.created_at))/60 AS minutes
      FROM games g
     WHERE g.host_player_id = ANY($1) AND g.created_at > now() - $2::interval
     ORDER BY g.created_at DESC
  `, [ids, interval]);

  const byHost = new Map(hosts.map((h) => [h.host_id, { ...h, games: [] }]));
  for (const g of games) {
    byHost.get(g.host_player_id)?.games.push({
      ...numify(g), minutes: Math.round(Number(g.minutes)),
    });
  }
  return [...byHost.values()];
}

/**
 * The full audit of one game: every player, their ticket, and what they did
 * with every single number.
 *
 * This is the thing to open when someone disputes a result. It answers "was
 * that number really called, did they really tap that, and was the prize
 * validly awarded" without anyone having to read the database by hand.
 */
export async function auditGame(gameId) {
  const { rows: games } = await query(`
    SELECT g.*, ${NAME} AS host_name, p.wa_id AS host_wa_id
      FROM games g JOIN players p ON p.id = g.host_player_id
     WHERE g.id = $1
  `, [gameId]);
  if (!games[0]) return null;

  const game = games[0];
  const sequence = game.sequence;
  delete game.sequence;   // 90 numbers of internal detail the page never shows

  const [draws, people, claims] = await Promise.all([
    query('SELECT seq, value, drawn_at FROM draws WHERE game_id=$1 ORDER BY seq', [gameId]),
    query(`
      SELECT p.id, p.wa_id, ${NAME} AS display_name, gp.is_host, gp.joined_at, gp.left_at,
             p.last_ip, p.last_device_type, p.last_os, p.last_browser,
             p.last_city, p.last_region, p.last_country,
             e.ticket
        FROM game_players gp
        JOIN players p ON p.id = gp.player_id
        LEFT JOIN entries e ON e.game_id = gp.game_id AND e.player_id = gp.player_id
       WHERE gp.game_id = $1 ORDER BY gp.is_host DESC, gp.joined_at`, [gameId]),
    query(`
      SELECT c.player_id, c.claim_type, c.status, c.seq, c.reason, c.created_at
        FROM claims c WHERE c.game_id = $1 ORDER BY c.created_at`, [gameId]),
  ]);

  const { rows: answers } = await query(`
    SELECT a.player_id, a.seq, a.answer, a.was_correct, a.answered_at,
           EXTRACT(EPOCH FROM (a.answered_at - d.drawn_at)) AS took_seconds
      FROM draw_answers a
      JOIN draws d ON d.game_id = a.game_id AND d.seq = a.seq
     WHERE a.game_id = $1`, [gameId]);

  const answersByPlayer = new Map();
  for (const a of answers) {
    if (!answersByPlayer.has(a.player_id)) answersByPlayer.set(a.player_id, new Map());
    answersByPlayer.get(a.player_id).set(a.seq, a);
  }

  const players = people.rows.map((p) => {
    const mine = answersByPlayer.get(p.id) ?? new Map();
    const trail = draws.rows.map((d) => {
      const a = mine.get(d.seq);
      const onTicket = p.ticket ? p.ticket.numbers.includes(d.value) : null;
      return {
        seq: d.seq,
        value: d.value,
        drawnAt: d.drawn_at,
        onTicket,
        answer: a?.answer ?? 'no_response',
        wasCorrect: a?.was_correct ?? null,
        answeredAt: a?.answered_at ?? null,
        tookSeconds: a?.took_seconds == null ? null : Math.max(0, Number(a.took_seconds)),
      };
    });

    const answered = trail.filter((t) => t.answer !== 'no_response').length;
    const correct = trail.filter((t) => t.wasCorrect === true).length;
    const times = trail.filter((t) => t.tookSeconds != null).map((t) => t.tookSeconds);

    return {
      id: p.id,
      wa_id: p.wa_id,
      display_name: p.display_name,
      is_host: p.is_host,
      joined_at: p.joined_at,
      left_at: p.left_at,
      device: {
        ip: p.last_ip, type: p.last_device_type, os: p.last_os, browser: p.last_browser,
        place: [p.last_city, p.last_region, p.last_country].filter(Boolean).join(', ') || null,
      },
      ticket: p.ticket,
      trail,
      stats: {
        answered,
        correct,
        wrong: trail.filter((t) => t.wasCorrect === false).length,
        missed: trail.length - answered,
        accuracyPct: answered ? Math.round((correct / answered) * 100) : 0,
        avgSeconds: times.length
          ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1))
          : null,
      },
      claims: claims.rows.filter((c) => c.player_id === p.id),
    };
  });

  return {
    game: numify(game),
    totalNumbers: Array.isArray(sequence) ? sequence.length : 90,
    draws: draws.rows.map(numify),
    players,
    prizes: CLAIMS.map((c) => {
      const won = claims.rows.find((x) => x.claim_type === c.key && x.status === 'awarded');
      const winner = won ? players.find((p) => p.id === won.player_id) : null;
      return { key: c.key, label: c.label, winner: winner?.display_name ?? null, seq: won?.seq ?? null };
    }),
  };
}

/** Activity bucketed for the audit screen's chart. */
export async function auditActivity({ range = '7d' } = {}) {
  const { interval, bucket } = rangeToInterval(range);
  // Each game is stamped with its bucket first, then aggregated. Correlating a
  // subquery against the outer GROUP BY (to count distinct players per bucket)
  // is not valid SQL - joining the seats in and counting them here is.
  const { rows } = await query(`
    WITH stamped AS (
      SELECT g.id, g.status, g.cursor,
             date_trunc($2, g.created_at AT TIME ZONE 'Asia/Kolkata') AS at
        FROM games g
       WHERE g.created_at > now() - $1::interval
    )
    SELECT to_char(s.at, CASE $2 WHEN 'minute' THEN 'HH24:MI'
                                 WHEN 'hour'   THEN 'DD Mon HH24:00'
                                 ELSE 'DD Mon' END)          AS bucket,
           s.at                                              AS sort_at,
           count(DISTINCT s.id)::int                          AS games,
           count(DISTINCT s.id) FILTER (WHERE s.status='finished')::int AS finished,
           COALESCE(sum(DISTINCT s.cursor), 0)::int           AS numbers,
           count(DISTINCT gp.player_id)::int                  AS players
      FROM stamped s
      LEFT JOIN game_players gp ON gp.game_id = s.id
     GROUP BY s.at
     ORDER BY s.at
  `, [interval, bucket]);
  return rows.map(numify);
}

// ─── Hosts ─────────────────────────────────────────────────────────────────

export async function listHosts({ limit = 100, offset = 0, search = null } = {}) {
  const { rows } = await query(`
    SELECT p.id, p.wa_id, ${NAME} AS display_name, p.created_at, p.last_seen_at,
           count(g.id)                                              AS games_hosted,
           count(g.id) FILTER (WHERE g.status='finished')            AS games_completed,
           count(g.id) FILTER (WHERE g.status='abandoned')           AS games_abandoned,
           min(g.created_at)                                         AS first_hosted_at,
           max(g.created_at)                                         AS last_hosted_at,
           (SELECT count(DISTINCT gp.player_id) FROM game_players gp
             WHERE gp.game_id IN (SELECT id FROM games WHERE host_player_id=p.id)
               AND gp.player_id <> p.id)                             AS distinct_players,
           (SELECT count(*) FROM game_players gp
             WHERE gp.game_id IN (SELECT id FROM games WHERE host_player_id=p.id)
               AND gp.player_id <> p.id)                             AS players_brought,
           (SELECT count(*) FROM game_players gp JOIN games g2 ON g2.id=gp.game_id
             WHERE gp.player_id=p.id AND g2.host_player_id <> p.id)  AS games_as_guest
      FROM players p JOIN games g ON g.host_player_id = p.id
     WHERE ($3::text IS NULL OR p.wa_id ILIKE '%'||$3||'%' OR p.display_name ILIKE '%'||$3||'%')
     GROUP BY p.id, p.wa_id, p.display_name, p.created_at, p.last_seen_at
     ORDER BY count(g.id) DESC
     LIMIT $1 OFFSET $2
  `, [limit, offset, search]);
  return rows.map(numify);
}

export async function hostDetail(id) {
  const host = await playerDetail(id);
  if (!host) return null;
  const { rows } = await query(`
    SELECT g.id, g.code AS room_code, g.status, g.created_at, g.expected_players,
           g.cursor AS numbers_called,
           EXTRACT(EPOCH FROM (COALESCE(g.ended_at, now()) - g.created_at))/60 AS minutes,
           (SELECT count(*) FROM game_players gp
             WHERE gp.game_id=g.id AND gp.left_at IS NULL)             AS players,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.status='awarded')              AS prizes_awarded,
           (SELECT count(*) FROM claims c
             WHERE c.game_id=g.id AND c.status='rejected')             AS claims_rejected
      FROM games g WHERE g.host_player_id = $1 ORDER BY g.created_at DESC LIMIT 100
  `, [id]);
  return { host, games: rows.map((r) => ({ ...numify(r), minutes: Math.round(Number(r.minutes)) })) };
}

// ─── Events ────────────────────────────────────────────────────────────────

export async function listEvents({ limit = 200, type = null } = {}) {
  const { rows } = await query(`
    SELECT e.id, e.occurred_at, e.event_type, e.source, e.request_ip,
           e.properties, p.wa_id, ${NAME} AS display_name, g.code AS room_code
      FROM analytics_events e
      LEFT JOIN players p ON p.id = e.player_id
      LEFT JOIN games   g ON g.id = e.game_id
     WHERE ($2::text IS NULL OR e.event_type = $2)
     ORDER BY e.occurred_at DESC LIMIT $1
  `, [limit, type]);
  return rows;
}

export async function eventTypes({ days = 30 } = {}) {
  const { rows } = await query(`
    SELECT event_type, count(*)::int AS count
      FROM analytics_events
     WHERE occurred_at > now() - make_interval(days => $1)
     GROUP BY event_type ORDER BY count DESC
  `, [days]);
  return rows;
}

// ─── Conversations ─────────────────────────────────────────────────────────

export async function listConversations({ limit = 100, filter = null } = {}) {
  const { rows } = await query(`
    SELECT p.id, p.wa_id, ${NAME} AS display_name,
           max(m.created_at)                                        AS last_message_at,
           count(*) FILTER (WHERE m.direction='in')                 AS received,
           count(*) FILTER (WHERE m.direction='out')                AS sent,
           EXISTS(SELECT 1 FROM games g WHERE g.host_player_id=p.id) AS has_hosted,
           EXISTS(SELECT 1 FROM game_players gp JOIN games g ON g.id=gp.game_id
                   WHERE gp.player_id=p.id AND g.status IN ('lobby','running')) AS in_game
      FROM messages m JOIN players p ON p.id = m.player_id
     GROUP BY p.id, p.wa_id, p.display_name
     HAVING ($2::text IS NULL
             OR ($2 = 'hosts'   AND EXISTS(SELECT 1 FROM games g WHERE g.host_player_id=p.id))
             OR ($2 = 'in_game' AND EXISTS(SELECT 1 FROM game_players gp JOIN games g ON g.id=gp.game_id
                                            WHERE gp.player_id=p.id AND g.status IN ('lobby','running')))
             OR ($2 NOT IN ('hosts','in_game')))
     ORDER BY max(m.created_at) DESC LIMIT $1
  `, [limit, filter]);
  return rows.map(numify);
}

export async function conversation(playerId, limit = 200) {
  const [player, messages] = await Promise.all([
    query(`SELECT p.id, p.wa_id, ${NAME} AS display_name, p.created_at, p.last_seen_at
             FROM players p WHERE p.id = $1`, [playerId]),
    query(`SELECT m.id, m.direction, m.kind, m.body, m.status, m.error,
                  m.created_at, g.code AS room_code
             FROM messages m LEFT JOIN games g ON g.id = m.game_id
            WHERE m.player_id = $1 ORDER BY m.created_at DESC LIMIT $2`, [playerId, limit]),
  ]);
  return { player: player.rows[0] ?? null, messages: messages.rows.reverse() };
}

// ─── Analytics ─────────────────────────────────────────────────────────────

/**
 * Where people drop out, from first message to a won prize.
 *
 * Returns an OBJECT keyed by step, because the panel looks each step up by
 * name (funnel[key]) rather than iterating a list - that way adding a step
 * here cannot silently reorder the chart there.
 *
 * Every step counts DISTINCT players, so the drop between two steps is real
 * attrition rather than a change in how busy people were.
 */
export async function funnel({ days = 30 } = {}) {
  const { rows } = await query(`
    SELECT
      (SELECT count(DISTINCT player_id) FROM messages
        WHERE direction='in' AND created_at > now() - make_interval(days => $1))   AS messaged_bot,
      (SELECT count(DISTINCT player_id) FROM consents
        WHERE agreed_at > now() - make_interval(days => $1))                       AS saw_menu,
      (SELECT count(DISTINCT host_player_id) FROM games
        WHERE created_at > now() - make_interval(days => $1))                      AS created_room,
      (SELECT count(DISTINCT gp.player_id) FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE g.created_at > now() - make_interval(days => $1))                    AS joined_room,
      (SELECT count(DISTINCT gp.player_id) FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE g.status IN ('running','finished')
          AND g.created_at > now() - make_interval(days => $1))                    AS started_game,
      (SELECT count(DISTINCT a.player_id) FROM draw_answers a
        WHERE a.answer <> 'no_response'
          AND a.answered_at > now() - make_interval(days => $1))                   AS answered_a_number,
      (SELECT count(DISTINCT player_id) FROM claims
        WHERE status='awarded' AND created_at > now() - make_interval(days => $1))  AS won_a_prize
  `, [days]);

  return numify(rows[0]);
}

/**
 * How quickly players answer a called number, as a histogram.
 *
 * Returns buckets rather than an average because the average hides the thing
 * you actually want to see: whether there is a tail of people who are barely
 * keeping up. Ordered fastest-first, which is what the chart's colour ramp
 * assumes.
 */
export async function responseTimes({ days = 30 } = {}) {
  const { rows } = await query(`
    WITH answered AS (
      SELECT EXTRACT(EPOCH FROM (a.answered_at - d.drawn_at)) AS secs
        FROM draw_answers a
        JOIN draws d ON d.game_id = a.game_id AND d.seq = a.seq
       WHERE a.answer <> 'no_response'
         AND a.answered_at > now() - make_interval(days => $1)
         AND a.answered_at >= d.drawn_at
    ), bucketed AS (
      SELECT CASE
               WHEN secs < 2  THEN '0-2s'
               WHEN secs < 4  THEN '2-4s'
               WHEN secs < 6  THEN '4-6s'
               WHEN secs < 8  THEN '6-8s'
               WHEN secs < 10 THEN '8-10s'
               ELSE '10s+'
             END AS bucket
        FROM answered
    )
    SELECT b.bucket, count(x.bucket)::int AS responses
      FROM (VALUES ('0-2s',1),('2-4s',2),('4-6s',3),('6-8s',4),('8-10s',5),('10s+',6)) AS b(bucket, ord)
      LEFT JOIN bucketed x ON x.bucket = b.bucket
     GROUP BY b.bucket, b.ord
     ORDER BY b.ord
  `, [days]);
  return rows.map(numify);
}

export async function messageDelivery({ days = 30 } = {}) {
  const { rows } = await query(`
    SELECT COALESCE(status, 'unknown') AS status, count(*)::int AS count
      FROM messages
     WHERE direction='out' AND created_at > now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 2 DESC
  `, [days]);
  return rows;
}

export async function consentStats() {
  const { rows } = await query(`
    SELECT 'terms' AS doc_key, 'Terms, Privacy & Fair Play' AS title,
           (SELECT max(policy_version) FROM consents)                       AS current_version,
           (SELECT count(DISTINCT player_id) FROM consents)                 AS accepted_any_version,
           (SELECT count(DISTINCT player_id) FROM consents
             WHERE policy_version = (SELECT max(policy_version) FROM consents)) AS accepted_current
  `);
  return rows.map(numify);
}

// ─── Free trial ────────────────────────────────────────────────────────────

/**
 * The trial screen's own funnel and daily shape.
 *
 * Separate from funnel() because this one is measured over the whole trial,
 * not a rolling window - the question is "has the trial worked", not "how are
 * we doing this month".
 */
export async function trialReport({ days = 30 } = {}) {
  const { rows: counts } = await query(`
    SELECT
      (SELECT count(DISTINCT player_id) FROM messages WHERE direction='in')   AS signups,
      (SELECT count(DISTINCT player_id) FROM consents)                        AS consented,
      (SELECT count(DISTINCT gp.player_id) FROM game_players gp)              AS played,
      (SELECT count(DISTINCT host_player_id) FROM games)                      AS hosts,
      (SELECT count(*) FROM games)                                            AS "gamesStarted",
      (SELECT count(*) FROM games WHERE status='finished')                    AS "gamesCompleted",
      -- "Came back" = played on more than one distinct day. The single most
      -- honest signal that the game is actually fun.
      (SELECT count(*) FROM (
         SELECT gp.player_id
           FROM game_players gp JOIN games g ON g.id = gp.game_id
          GROUP BY gp.player_id
         HAVING count(DISTINCT (g.created_at AT TIME ZONE 'Asia/Kolkata')::date) > 1
       ) t)                                                                   AS returning
  `);

  const { rows: daily } = await query(`
    WITH span AS (
      SELECT generate_series(
        (now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1),
        (now() AT TIME ZONE 'Asia/Kolkata')::date, '1 day')::date AS day
    )
    SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM players p
        WHERE (p.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)           AS signups,
      (SELECT count(DISTINCT gp.player_id) FROM game_players gp JOIN games g ON g.id=gp.game_id
        WHERE (g.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)           AS played,
      (SELECT count(*) FROM games g
        WHERE (g.created_at AT TIME ZONE 'Asia/Kolkata')::date = s.day)           AS games
    FROM span s ORDER BY s.day
  `, [days]);

  return { counts: numify(counts[0]), daily: daily.map(numify) };
}

// ─── Business profile & legal documents ────────────────────────────────────

/**
 * Held in app_settings-style rows would be over-engineering while there is one
 * operator and one brand, so this reads from configuration. The panel's form
 * is read-only against it until there is a reason to make it editable.
 */
export function businessProfile(config) {
  const b = config.business;

  // `address` is always an OBJECT, never null. The marketing site reads
  // business.address.line1 directly to build its footer and its JSON-LD, and a
  // null here crashed the whole homepage. Empty strings render as nothing,
  // which is the honest result when the details have not been filled in.
  return {
    // snake_case for the admin panel, camelCase for the public site: both read
    // this same object, and neither should have to translate.
    legal_name: b.legalName,
    legalName: b.legalName,
    brand_name: config.brandName,
    brandName: config.brandName,
    whatsapp_number: config.whatsapp.businessNumber,
    whatsappNumber: config.whatsapp.businessNumber,
    support_email: b.supportEmail,
    supportEmail: b.supportEmail,
    email: b.supportEmail,
    gst_number: b.gstin,
    gstin: b.gstin,
    place_of_supply: b.placeOfSupply,
    timezone: config.timezone,
    address: {
      line1: b.address.line1,
      line2: b.address.line2,
      city: b.address.city,
      state: b.address.state,
      postalCode: b.address.postalCode,
      country: b.address.country,
    },
  };
}

/**
 * The policies page is rendered from code today rather than stored as editable
 * documents, so this describes what actually exists instead of returning an
 * empty list that reads as "something is broken".
 */
export function legalDocuments(config, policyVersion) {
  return [
    {
      doc_key: 'terms',
      title: 'Terms, Privacy & Fair Play',
      summary: 'Shown in WhatsApp before a player can join, and linked from every consent card.',
      version: policyVersion,
      is_active: true,
      requires_consent: true,
      url: `${config.publicRoot}/policies`,
      editable: false,
    },
  ];
}

// ─── Feedback ──────────────────────────────────────────────────────────────

export async function listFeedback({ limit = 100 } = {}) {
  const { rows } = await query(`
    SELECT f.id, f.rating, f.comment, f.created_at, f.approved_at, f.approved_by,
           f.display_as, p.wa_id, ${NAME} AS display_name, g.code AS room_code
      FROM feedback f
      JOIN players p ON p.id = f.player_id
      LEFT JOIN games g ON g.id = f.game_id
     ORDER BY f.created_at DESC LIMIT $1
  `, [limit]);

  const summary = await query(`
    SELECT count(*)::int AS responses,
           count(*) FILTER (WHERE comment IS NOT NULL AND comment <> '')::int AS comments,
           round(avg(rating)::numeric, 2) AS average_rating
      FROM feedback
  `);

  return { items: rows, summary: numify(summary.rows[0]) };
}

// ─── Moderation ────────────────────────────────────────────────────────────

export async function listBlocked({ limit = 500 } = {}) {
  const { rows } = await query(`
    SELECT b.wa_id, b.reason, b.category, b.blocked_by, b.blocked_at, b.notified_at,
           ${NAME} AS display_name
      FROM blocked_numbers b
      LEFT JOIN players p ON p.wa_id = b.wa_id
     ORDER BY b.blocked_at DESC LIMIT $1
  `, [limit]);
  return rows;
}

export async function blockHistory(waId) {
  const { rows } = await query(
    'SELECT * FROM block_history WHERE wa_id = $1 ORDER BY created_at DESC',
    [waId],
  );
  return { rows };
}

/**
 * The "queues" panel.
 *
 * There is no Redis and no job server in this build - the draw scheduler polls
 * Postgres with FOR UPDATE SKIP LOCKED. So rather than reporting an empty
 * queue that does not exist, this reports the real equivalents: what the
 * scheduler is about to do, and how outbound messages actually went.
 *
 * Shape matters: the panel renders { group: { label: number } }, and every
 * value has to be a plain number or it prints NaN.
 */
export async function queueStats() {
  const { rows } = await query(`
    SELECT
      (SELECT count(*)::int FROM games WHERE status='running')                       AS running,
      (SELECT count(*)::int FROM games
        WHERE status='running' AND next_draw_at <= now())                            AS due_now,
      (SELECT count(*)::int FROM games WHERE status='lobby')                         AS waiting_to_start,
      (SELECT count(*)::int FROM draws WHERE drawn_at > now() - interval '1 hour')    AS drawn_last_hour,

      (SELECT count(*)::int FROM messages WHERE direction='out' AND status='sent')    AS sent,
      (SELECT count(*)::int FROM messages WHERE direction='out' AND status='failed')  AS failed,
      (SELECT count(*)::int FROM messages WHERE direction='out' AND status='blocked') AS blocked,
      (SELECT count(*)::int FROM messages WHERE direction='out' AND status IS NULL)   AS unknown,

      (SELECT count(*)::int FROM processed_messages)                                  AS seen,
      (SELECT count(*)::int FROM processed_messages
        WHERE received_at > now() - interval '1 hour')                                AS last_hour
  `);
  const r = rows[0];

  return {
    draws: {
      running: r.running,
      due_now: r.due_now,
      waiting_to_start: r.waiting_to_start,
      drawn_last_hour: r.drawn_last_hour,
    },
    messages: {
      sent: r.sent, failed: r.failed, blocked: r.blocked, unknown: r.unknown,
    },
    webhooks: { seen: r.seen, last_hour: r.last_hour },
  };
}

// ─── Operations health ─────────────────────────────────────────────────────

/**
 * The things that quietly go wrong, which no other screen would surface.
 *
 * Each of these was chosen because it is a leading indicator: it tells you
 * something is degrading while you can still fix it, rather than reporting
 * that yesterday was bad.
 */
export async function opsHealth({ range = '7d' } = {}) {
  const { interval } = rangeToInterval(range);

  const [funnelGap, reconnects, drift, delivery, unclaimed, devices, abandoned] = await Promise.all([
    // 1. Seated but never opened their board. These players got a link and
    //    never arrived - the single biggest silent drop-off in the product.
    query(`
      SELECT count(*)::int AS seated,
             count(*) FILTER (WHERE bs.player_id IS NULL)::int AS never_opened
        FROM game_players gp
        JOIN games g ON g.id = gp.game_id
        LEFT JOIN LATERAL (
          SELECT 1 AS player_id FROM board_sessions b
           WHERE b.game_id = gp.game_id AND b.player_id = gp.player_id LIMIT 1
        ) bs ON true
       WHERE g.created_at > now() - $1::interval`, [interval]),

    // 2. Boards that kept reconnecting. A high stream_opens count on one
    //    session is the WhatsApp in-app browser suspending, not a bug.
    query(`
      SELECT count(*)::int                                   AS sessions,
             count(*) FILTER (WHERE stream_opens > 3)::int    AS flapping,
             count(*) FILTER (WHERE in_app_browser)::int      AS in_app,
             COALESCE(round(avg(stream_opens)::numeric, 1), 0) AS avg_reconnects
        FROM board_sessions
       WHERE first_seen_at > now() - $1::interval`, [interval]),

    // 3. Draw pacing. If actual gaps exceed the configured interval the
    //    scheduler is falling behind, which players feel as a stuttering game.
    query(`
      SELECT COALESCE(round(avg(gap)::numeric, 2), 0) AS avg_gap_seconds,
             COALESCE(round(max(gap)::numeric, 2), 0) AS worst_gap_seconds,
             count(*) FILTER (WHERE gap > 30)::int     AS stalls
        FROM (
          SELECT EXTRACT(EPOCH FROM (drawn_at - lag(drawn_at)
                 OVER (PARTITION BY game_id ORDER BY seq))) AS gap
            FROM draws WHERE drawn_at > now() - $1::interval
        ) t WHERE gap IS NOT NULL`, [interval]),

    // 4. Messages we could not deliver.
    query(`
      SELECT count(*)::int                                  AS sent,
             count(*) FILTER (WHERE status='failed')::int    AS failed,
             count(*) FILTER (WHERE status='blocked')::int   AS blocked
        FROM messages
       WHERE direction='out' AND created_at > now() - $1::interval`, [interval]),

    // 5. Prizes nobody claimed. A high rate means players are not noticing
    //    they have won - a UI problem wearing a gameplay costume.
    query(`
      SELECT count(*)::int * 6                                AS possible,
             (SELECT count(*)::int FROM claims c JOIN games g2 ON g2.id=c.game_id
               WHERE c.status='awarded' AND g2.ended_at > now() - $1::interval) AS awarded
        FROM games WHERE status='finished' AND ended_at > now() - $1::interval`, [interval]),

    // 6. What people actually play on, so the board is tested on the right thing.
    query(`
      SELECT COALESCE(device_type,'unknown') AS device_type, count(*)::int AS count
        FROM board_sessions WHERE first_seen_at > now() - $1::interval
       GROUP BY 1 ORDER BY 2 DESC`, [interval]),

    // 7. Rooms created that never started. Hosts giving up before play.
    query(`
      SELECT count(*)::int                                        AS created,
             count(*) FILTER (WHERE status='lobby')::int           AS still_waiting,
             count(*) FILTER (WHERE started_at IS NULL
                                AND status <> 'lobby')::int        AS never_started
        FROM games WHERE created_at > now() - $1::interval`, [interval]),
  ]);

  const u = numify(unclaimed.rows[0]);
  return {
    range,
    boardsNeverOpened: numify(funnelGap.rows[0]),
    connections: numify(reconnects.rows[0]),
    drawPacing: numify(drift.rows[0]),
    delivery: numify(delivery.rows[0]),
    prizes: {
      possible: u.possible,
      awarded: u.awarded,
      unclaimedPct: u.possible ? Math.round(((u.possible - u.awarded) / u.possible) * 100) : 0,
    },
    devices: devices.rows.map(numify),
    rooms: numify(abandoned.rows[0]),
  };
}

/**
 * When people actually play, as an hour-by-weekday grid.
 *
 * The most actionable single chart for an operator: it says when to be
 * available, when to run a promotion, and when it is safe to deploy.
 */
export async function playHeatmap({ days = 30 } = {}) {
  const { rows } = await query(`
    SELECT EXTRACT(DOW  FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS weekday,
           EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
           count(*)::int AS games
      FROM games
     WHERE created_at > now() - make_interval(days => $1)
     GROUP BY 1, 2`, [days]);
  return rows.map(numify);
}

// ─── Maintenance ───────────────────────────────────────────────────────────

/**
 * Tables wiped by a full cleanup, in dependency order so foreign keys never
 * block the delete.
 *
 * Everything here is GAME data. What is deliberately NOT in this list:
 *
 *   blocked_numbers, block_history  a moderation record. Someone blocked for
 *                                   abuse must not come back because an
 *                                   operator tidied the database.
 *   admin_sessions                  you would sign yourself out mid-cleanup.
 *   admin_login_attempts            the lockout counter is a security control.
 *
 * Policies and lookup data are not tables at all - the policies page is
 * rendered from code and lookup reads the player tables - so there is nothing
 * of theirs to protect here.
 */
const WIPE_ORDER = [
  'analytics_events',
  'board_sessions',
  'feedback',
  'claims',
  'draw_answers',
  'draws',
  'entries',
  'game_players',
  'games',
  'messages',
  'processed_messages',
  'consents',
  'player_states',
  'players',
];

export const PROTECTED_TABLES = [
  'blocked_numbers', 'block_history', 'admin_sessions', 'admin_login_attempts', 'app_settings',
];

/** The exact words an operator must type. Matches the panel's own constant. */
export const PURGE_PHRASE = 'DELETE ALL PLAYER DATA';

/**
 * What a cleanup would delete, before doing it.
 *
 * Counted live rather than estimated: an operator about to erase everything
 * deserves the real number, not an approximation.
 */
export async function wipePreview() {
  const counts = async (tables) => {
    const out = [];
    for (const table of tables) {
      const { rows } = await query(`SELECT count(*)::int AS n FROM ${table}`);
      out.push({ table, rows: rows[0].n });
    }
    return out;
  };

  const wipe = await counts(WIPE_ORDER);
  const keep = await counts(PROTECTED_TABLES);

  return {
    wipe,
    keep,
    totalRows: wipe.reduce((a, t) => a + t.rows, 0),
    // No Redis in this build - the scheduler runs on Postgres SKIP LOCKED.
    // Reported as zero rather than omitted, so the panel renders honestly.
    redisKeys: 0,
    phrase: PURGE_PHRASE,
  };
}

/**
 * Empties every game table. Irreversible, so the caller must ask for it
 * explicitly; there is no "probably meant this" path into here.
 *
 * Runs as one transaction: a half-wiped database with orphaned games would be
 * worse than either outcome.
 */
export async function wipeGameData() {
  const client = await (await import('../db/pool.js')).pool.connect();
  const deleted = {};
  try {
    await client.query('BEGIN');
    for (const table of WIPE_ORDER) {
      const res = await client.query(`DELETE FROM ${table}`);
      deleted[table] = res.rowCount;
    }
    // Ids restart from 1, so a fresh database looks fresh rather than
    // carrying on from game #97.
    for (const table of WIPE_ORDER) {
      await client.query(`ALTER SEQUENCE IF EXISTS ${table}_id_seq RESTART WITH 1`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { deleted, kept: PROTECTED_TABLES };
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Postgres returns count() as bigint, which pg gives back as a string. The
 * panel does arithmetic on these, and "12" + 1 === "121" is exactly the kind
 * of bug that only shows up on a dashboard nobody checks.
 */
function numify(row) {
  if (!row) return row;
  const out = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && /^-?\d+$/.test(v) && !/(_at|_id|wa_id|code|ip|version)$/.test(k)) {
      out[k] = Number(v);
    }
  }
  return out;
}
