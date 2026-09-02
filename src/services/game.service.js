/**
 * Rooms: creating a game, seating players, starting the draw.
 *
 * Every write that could race takes a row lock on the game and re-checks its
 * state inside the transaction. Two players tapping Join on the last free seat
 * cannot both get in, because the capacity check and the insert happen under
 * the same lock.
 */
import { withTransaction, query, isUniqueViolation } from '../db/pool.js';
import { config } from '../config/env.js';
import { makeRng, newSeed } from '../utils/random.js';
import { generateRoomCode, normaliseRoomCode } from '../utils/code.js';
import { createSequence } from '../games/tambola/draw.js';
import { generateTicket } from '../games/tambola/ticket.js';
import { displayNameFor } from './player.service.js';
import { broadcast } from './live.service.js';

/**
 * A player's ticket is derived from the game seed and their own id, so the
 * exact same tickets can be regenerated if a round is ever disputed.
 */
function ticketFor(gameSeed, playerId) {
  return generateTicket(makeRng((Number(gameSeed) ^ (playerId * 2654435761)) >>> 0));
}

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Creates a lobby with the host already seated and holding a ticket.
 * The host is a player like any other - `is_host` only governs who may tap
 * Start, and stops mattering the moment the game is running.
 */
export async function createGame({ hostPlayerId, expectedPlayers }) {
  const { minPlayers, maxPlayers, drawIntervalSeconds } = config.game;
  if (!Number.isInteger(expectedPlayers) || expectedPlayers < minPlayers || expectedPlayers > maxPlayers) {
    throw new GameError('bad_player_count', `Player count must be between ${minPlayers} and ${maxPlayers}`);
  }

  const seed = newSeed();
  const sequence = createSequence(seed);

  return withTransaction(async (client) => {
    let game = null;
    // Room codes are short and human-readable, so collisions are possible
    // rather than impossible. Retry rather than widening the code.
    for (let attempt = 0; attempt < 10 && !game; attempt++) {
      try {
        const { rows } = await client.query(
          `INSERT INTO games (code, host_player_id, expected_players, seed, sequence, draw_interval_seconds)
                VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
          [generateRoomCode(), hostPlayerId, expectedPlayers, seed, JSON.stringify(sequence), drawIntervalSeconds],
        );
        game = rows[0];
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!game) throw new GameError('code_collision', 'Could not allocate a room code, please try again');

    await client.query(
      `INSERT INTO game_players (game_id, player_id, is_host) VALUES ($1, $2, true)`,
      [game.id, hostPlayerId],
    );
    await client.query(
      `INSERT INTO entries (game_id, player_id, ticket) VALUES ($1, $2, $3)`,
      [game.id, hostPlayerId, JSON.stringify(ticketFor(seed, hostPlayerId))],
    );

    return game;
  });
}

export async function getGameByCode(code) {
  const { rows } = await query('SELECT * FROM games WHERE code = $1', [normaliseRoomCode(code)]);
  return rows[0] ?? null;
}

export async function getGameById(id) {
  const { rows } = await query('SELECT * FROM games WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/**
 * Seats a player. Locks the game so the capacity check cannot be overtaken,
 * and is idempotent: re-tapping the invite link returns the existing seat
 * instead of erroring.
 */
export async function joinGame({ code, playerId }) {
  const result = await withTransaction(async (client) => {
    const { rows: games } = await client.query(
      'SELECT * FROM games WHERE code = $1 FOR UPDATE',
      [normaliseRoomCode(code)],
    );
    const game = games[0];
    if (!game) throw new GameError('no_such_game', 'That game code does not exist');

    const { rows: existing } = await client.query(
      'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2',
      [game.id, playerId],
    );
    if (existing.length) return { game, alreadyJoined: true };

    if (game.status === 'running') throw new GameError('already_started', 'That game has already started');
    if (game.status !== 'lobby') throw new GameError('game_over', 'That game has finished');

    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM game_players WHERE game_id = $1 AND left_at IS NULL',
      [game.id],
    );
    if (counted[0].n >= game.expected_players) {
      throw new GameError('game_full', 'That game is full');
    }

    await client.query(
      'INSERT INTO game_players (game_id, player_id) VALUES ($1, $2)',
      [game.id, playerId],
    );
    await client.query(
      'INSERT INTO entries (game_id, player_id, ticket) VALUES ($1, $2, $3)',
      [game.id, playerId, JSON.stringify(ticketFor(game.seed, playerId))],
    );

    return { game, alreadyJoined: false };
  });

  // Tell everyone already staring at the lobby that someone new arrived.
  // Broadcast after the commit, so a listener that immediately re-fetches
  // cannot read state from before the insert landed.
  if (!result.alreadyJoined) broadcast(result.game.id, 'state_stale', {});

  return result;
}

/**
 * The host taps Start. From here the server owns the game: the host becomes an
 * ordinary player and closing their browser changes nothing.
 *
 * `next_draw_at` is what the scheduler polls, so setting it is what actually
 * starts the game.
 */
export async function startGame({ gameId, playerId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
    const game = rows[0];
    if (!game) throw new GameError('no_such_game', 'That game does not exist');
    if (game.host_player_id !== playerId) throw new GameError('not_host', 'Only the host can start this game');
    if (game.status === 'running') return game;
    if (game.status !== 'lobby') throw new GameError('game_over', 'That game has already finished');

    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM game_players WHERE game_id = $1 AND left_at IS NULL',
      [gameId],
    );
    if (counted[0].n < config.game.minPlayers) {
      throw new GameError('too_few_players', `At least ${config.game.minPlayers} players are needed to start`);
    }

    // The first number is held back by a short pre-roll rather than the full
    // draw interval, so the countdown everyone sees on screen is the real
    // schedule and not an animation running alongside it.
    const { rows: started } = await client.query(
      `UPDATE games
          SET status = 'running',
              started_at = now(),
              next_draw_at = now() + make_interval(secs => $2)
        WHERE id = $1
    RETURNING *`,
      [gameId, config.game.startCountdownSeconds],
    );
    return started[0];
  });
}

/**
 * A player leaves.
 *
 * If that takes a running game below the minimum, the game is abandoned rather
 * than left limping: a "game" with one player is not a game, and letting the
 * numbers keep coming would be worse than stopping cleanly.
 *
 * @returns {{game, remaining, aborted}} aborted is true when this leave ended it
 */
export async function leaveGame({ gameId, playerId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
    const game = rows[0];
    if (!game) throw new GameError('no_such_game', 'That game does not exist');

    await client.query(
      `UPDATE game_players SET left_at = now()
        WHERE game_id = $1 AND player_id = $2 AND left_at IS NULL`,
      [gameId, playerId],
    );

    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM game_players WHERE game_id = $1 AND left_at IS NULL',
      [gameId],
    );
    const remaining = counted[0].n;

    // Only a game that is actually being played can be abandoned. A lobby that
    // empties out is left alone for the expiry sweep - nobody is waiting on it.
    const shouldAbort =
      game.status === 'running' && remaining < config.game.minPlayers;

    if (shouldAbort) {
      await client.query(
        `UPDATE games
            SET status = 'abandoned', ended_at = now(),
                ended_reason = 'abandoned', next_draw_at = NULL
          WHERE id = $1`,
        [gameId],
      );
    }

    return { game, remaining, aborted: shouldAbort };
  });
}

/** Everything the lobby screen needs, in one round trip. */
export async function getLobby(gameId) {
  const game = await getGameById(gameId);
  if (!game) return null;

  const { rows: players } = await query(
    `SELECT p.id, p.wa_id, p.display_name, gp.is_host, gp.joined_at
       FROM game_players gp
       JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1 AND gp.left_at IS NULL
      ORDER BY gp.joined_at`,
    [gameId],
  );

  return {
    game,
    players: players.map((p) => ({
      id: p.id,
      name: displayNameFor(p),
      isHost: p.is_host,
      joinedAt: p.joined_at,
    })),
    joined: players.length,
    expected: game.expected_players,
    canStart: players.length >= config.game.minPlayers,
  };
}

export async function getEntry(gameId, playerId) {
  const { rows } = await query(
    'SELECT ticket FROM entries WHERE game_id = $1 AND player_id = $2',
    [gameId, playerId],
  );
  return rows[0]?.ticket ?? null;
}

export async function isPlayerInGame(gameId, playerId) {
  const { rows } = await query(
    'SELECT 1 FROM game_players WHERE game_id = $1 AND player_id = $2 AND left_at IS NULL',
    [gameId, playerId],
  );
  return rows.length > 0;
}

/**
 * The game a player is currently in, if any. One active game per player keeps
 * the WhatsApp conversation unambiguous.
 */
export async function findActiveGameForPlayer(playerId) {
  const { rows } = await query(
    `SELECT g.*
       FROM games g
       JOIN game_players gp ON gp.game_id = g.id
      WHERE gp.player_id = $1
        AND gp.left_at IS NULL
        AND g.status IN ('lobby','running')
      ORDER BY g.created_at DESC
      LIMIT 1`,
    [playerId],
  );
  return rows[0] ?? null;
}
