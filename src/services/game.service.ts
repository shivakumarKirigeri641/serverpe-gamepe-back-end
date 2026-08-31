import type { PoolClient } from 'pg';
import { env, isChargingEnabled } from '../config/env.js';
import { query, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { getEngine } from '../core/registry.js';
import type { ClaimOutcome, Entry } from '../core/types.js';
import { generateRoomCode } from '../utils/ids.js';
import { logger } from '../utils/logger.js';
import {
  consumeFreeGame,
  getFreeGames,
  hasSufficientBalance,
  postLedgerEntry,
} from './wallet.service.js';

export type GameStatus = 'lobby' | 'running' | 'completed' | 'cancelled';

export interface GameRow {
  id: string;
  game_key: string;
  room_code: string;
  status: GameStatus;
  host_player_id: string | null;
  config: Record<string, unknown>;
  state: Record<string, unknown>;
  entry_fee_paise: number;
  prize_pool_paise: number;
  is_free_trial: boolean;
  plan_key: string | null;
  plan_price_paise: number;
  charged_at: Date | null;
  charged_paise: number;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  /** Target the host set at creation. A display goal, not a cap. */
  expected_players: number | null;
}

export interface EntryRow {
  id: string;
  game_id: string;
  player_id: string;
  entry_no: number;
  payload: unknown;
}

const GAME_COLUMNS = `id, game_key, room_code, status, host_player_id, config, state,
  entry_fee_paise, prize_pool_paise, is_free_trial, plan_key, plan_price_paise,
  charged_at, charged_paise, created_at, started_at, ended_at, expected_players`;

export class GameError extends Error {
  /**
   * Whether trying again could succeed.
   *
   * A mistyped room code is worth another attempt; a game already in progress
   * is not, however many times it is typed. The router uses this to decide
   * between re-arming the prompt and returning the player to the menu — without
   * it, "wait for the game to finish" was followed by "send another code",
   * which walked people straight back into the same wall.
   */
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'GameError';
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ lookups */

export async function findGameByRoomCode(roomCode: string, client?: Queryable): Promise<GameRow | null> {
  return queryOne<GameRow>(
    `SELECT ${GAME_COLUMNS} FROM games WHERE room_code = $1`,
    [roomCode.toUpperCase()],
    client,
  );
}

export async function findGameById(gameId: string, client?: Queryable): Promise<GameRow | null> {
  return queryOne<GameRow>(`SELECT ${GAME_COLUMNS} FROM games WHERE id = $1`, [gameId], client);
}

/** Locks the row for the duration of the caller's transaction. */
async function lockGame(gameId: string, client: PoolClient): Promise<GameRow | null> {
  return queryOne<GameRow>(`SELECT ${GAME_COLUMNS} FROM games WHERE id = $1 FOR UPDATE`, [gameId], client);
}

/** The one game a player is currently in, if any. */
export async function findActiveGameForPlayer(playerId: string, client?: Queryable): Promise<GameRow | null> {
  return queryOne<GameRow>(
    `SELECT g.id, g.game_key, g.room_code, g.status, g.host_player_id, g.config, g.state,
            g.entry_fee_paise, g.prize_pool_paise, g.is_free_trial,
            g.plan_key, g.plan_price_paise, g.charged_at, g.charged_paise,
            g.created_at, g.started_at, g.ended_at, g.expected_players
       FROM games g
       JOIN game_players gp ON gp.game_id = g.id AND gp.left_at IS NULL
      WHERE gp.player_id = $1 AND g.status IN ('lobby','running')
      ORDER BY g.created_at DESC
      LIMIT 1`,
    [playerId],
    client,
  );
}

export interface MemberRow {
  player_id: string;
  wa_id: string;
  display_name: string | null;
}

export async function listMembers(gameId: string, client?: Queryable): Promise<MemberRow[]> {
  return query<MemberRow>(
    `SELECT p.id AS player_id, p.wa_id, p.display_name
       FROM game_players gp JOIN players p ON p.id = gp.player_id
      WHERE gp.game_id = $1 AND gp.left_at IS NULL
      ORDER BY gp.joined_at`,
    [gameId],
    client,
  );
}

export async function countMembers(gameId: string, client?: Queryable): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM game_players WHERE game_id = $1 AND left_at IS NULL',
    [gameId],
    client,
  );
  return Number(row?.count ?? 0);
}

export async function listEntriesForPlayer(
  gameId: string,
  playerId: string,
  client?: Queryable,
): Promise<EntryRow[]> {
  return query<EntryRow>(
    `SELECT id, game_id, player_id, entry_no, payload
       FROM game_entries WHERE game_id = $1 AND player_id = $2 ORDER BY entry_no`,
    [gameId, playerId],
    client,
  );
}

export async function listDrawnNumbers(gameId: string, client?: Queryable): Promise<number[]> {
  const rows = await query<{ value: number }>(
    'SELECT value FROM game_draws WHERE game_id = $1 ORDER BY seq',
    [gameId],
    client,
  );
  return rows.map((r) => r.value);
}

export async function listAwardedClaims(gameId: string, client?: Queryable): Promise<string[]> {
  const rows = await query<{ claim_type: string }>(
    `SELECT claim_type FROM game_claims WHERE game_id = $1 AND status = 'awarded'`,
    [gameId],
    client,
  );
  return rows.map((r) => r.claim_type);
}

/* ----------------------------------------------------------------- creation */

export interface CreateGameOptions {
  gameKey: string;
  hostPlayerId: string;
  entryFeePaise?: number;
  configOverrides?: Record<string, unknown>;
  /** How many players the host says they are expecting. */
  expectedPlayers?: number;
  /** Plan the host chose for this room. */
  planKey?: string;
  planPricePaise?: number;
}

export async function createGame(opts: CreateGameOptions): Promise<GameRow> {
  const engine = getEngine(opts.gameKey);
  const config = { ...engine.defaultConfig(), ...(opts.configOverrides ?? {}) };
  const state = engine.createState(config as never);
  const entryFee = isChargingEnabled() ? (opts.entryFeePaise ?? env.DEFAULT_ENTRY_FEE_PAISE) : 0;

  // Room codes are short enough to collide occasionally; retry rather than
  // widening the code and hurting readability.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = generateRoomCode();
    try {
      const row = await queryOne<GameRow>(
        `INSERT INTO games
           (game_key, room_code, host_player_id, config, state, entry_fee_paise, is_free_trial,
            expected_players, plan_key, plan_price_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${GAME_COLUMNS}`,
        [
          opts.gameKey,
          roomCode,
          opts.hostPlayerId,
          config,
          state,
          entryFee,
          !isChargingEnabled(),
          opts.expectedPlayers ?? null,
          opts.planKey ?? null,
          opts.planPricePaise ?? 0,
        ],
      );
      if (row) return row;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      logger.warn({ attempt }, 'room code collision, retrying');
    }
  }
  throw new GameError('Could not allocate a room code. Please try again.');
}

/* --------------------------------------------------------------------- join */

export interface JoinResult {
  game: GameRow;
  entries: EntryRow[];
  alreadyJoined: boolean;
}

export async function joinGame(roomCode: string, playerId: string, entryCount = 1): Promise<JoinResult> {
  return withTransaction(async (client) => {
    const existing = await findGameByRoomCode(roomCode, client);
    if (!existing) throw new GameError(`No game found with code *${roomCode.toUpperCase()}*.`);

    const game = await lockGame(existing.id, client);
    if (!game) {
      // Retryable: they may simply have mistyped a still-valid code.
      throw new GameError(
        'That room no longer exists. Room codes stop working once a game is over.',
      );
    }
    if (game.status !== 'lobby') {
      // Joining a game in progress is deliberately not allowed: marks are
      // derived from every number called so far, so a late arrival would
      // appear instantly caught up and could claim a prize on their first tap.
      // The refusal has to say what to do next, or they simply try again and
      // get the same wall.
      throw new GameError(
        game.status === 'running'
          ? `Room *${game.room_code}* is already playing, so nobody can be added now.

` +
            `Please wait for it to finish — the host can start a new game straight after, ` +
            `and you will be able to join that one.`
          : `Room *${game.room_code}* has finished. Ask the host to start a new game.`,
        false,
      );
    }

    const engine = getEngine(game.game_key);

    const already = await queryOne<{ player_id: string }>(
      'SELECT player_id FROM game_players WHERE game_id = $1 AND player_id = $2 AND left_at IS NULL',
      [game.id, playerId],
      client,
    );
    if (already) {
      return { game, entries: await listEntriesForPlayer(game.id, playerId, client), alreadyJoined: true };
    }

    // A player may only be in one game at a time. Without this they can join a
    // second room mid-game, and every subsequent `ticket` / `claim` / `leave`
    // silently retargets the new room while numbers still arrive from the old.
    const otherGame = await queryOne<{ room_code: string; status: GameStatus }>(
      `SELECT g.room_code, g.status
         FROM games g
         JOIN game_players gp ON gp.game_id = g.id AND gp.left_at IS NULL
        WHERE gp.player_id = $1
          AND g.status IN ('lobby','running')
          AND g.id <> $2
        LIMIT 1`,
      [playerId, game.id],
      client,
    );
    if (otherGame) {
      throw new GameError(
        otherGame.status === 'running'
          ? `You are still playing in room *${otherGame.room_code}*. Send *leave* to quit that game first.`
          : `You are already waiting in room *${otherGame.room_code}*. Send *leave* first.`,
      );
    }

    const members = await countMembers(game.id, client);
    if (members >= engine.maxPlayers) throw new GameError('That game is full.');

    const wanted = Math.min(Math.max(entryCount, 1), engine.maxEntriesPerPlayer);
    const totalFee = game.entry_fee_paise * wanted;
    if (!(await hasSufficientBalance(playerId, totalFee, client))) {
      throw new GameError('Not enough balance for the entry fee. Send *balance* to check your wallet.');
    }

    await query(
      'INSERT INTO game_players (game_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [game.id, playerId],
      client,
    );

    const entries: EntryRow[] = [];
    for (let i = 1; i <= wanted; i += 1) {
      const entry = engine.createEntry(game.state as never, i, game.config as never);
      const row = await queryOne<EntryRow>(
        `INSERT INTO game_entries (game_id, player_id, entry_no, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, game_id, player_id, entry_no, payload`,
        [game.id, playerId, entry.entryNo, JSON.stringify(entry.payload)],
        client,
      );
      if (row) entries.push(row);
    }

    if (totalFee > 0) {
      await postLedgerEntry(
        {
          playerId,
          amountPaise: -totalFee,
          kind: 'entry_fee',
          referenceType: 'game',
          referenceId: game.id,
          idempotencyKey: `entry:${game.id}:${playerId}`,
        },
        client,
      );
      await query(
        'UPDATE games SET prize_pool_paise = prize_pool_paise + $2 WHERE id = $1',
        [game.id, totalFee],
        client,
      );
    }

    const refreshed = (await lockGame(game.id, client)) ?? game;
    return { game: refreshed, entries, alreadyJoined: false };
  });
}

export interface LeaveResult {
  /** The room was closed because the last player walked out. */
  gameCancelled: boolean;
  /** Set when the leaver was the host and someone was promoted in their place. */
  newHost: MemberRow | null;
  remaining: number;
}

/**
 * Removes a player from a game.
 *
 * The host leaving is the case that matters: a lobby whose host has gone can
 * never be started by anyone, so it would sit there until the abandoned-game
 * sweeper eventually cancelled it. Instead the longest-serving remaining player
 * inherits the room, and an empty room is closed immediately.
 */
export async function leaveGame(gameId: string, playerId: string): Promise<LeaveResult> {
  return withTransaction(async (client) => {
    const game = await lockGame(gameId, client);
    if (!game) return { gameCancelled: false, newHost: null, remaining: 0 };

    await query(
      'UPDATE game_players SET left_at = now() WHERE game_id = $1 AND player_id = $2 AND left_at IS NULL',
      [gameId, playerId],
      client,
    );

    const remaining = await listMembers(gameId, client);

    // A running game that drops below the minimum cannot meaningfully continue
    // — one player alone would be dealt all 90 numbers. A lobby is different:
    // a host waiting alone for friends to arrive is normal.
    const minimum = Math.max(getEngine(game.game_key).minPlayers, env.MIN_PLAYERS_TO_START);
    const belowMinimum = game.status === 'running' && remaining.length < minimum;

    if (remaining.length === 0 || belowMinimum) {
      await query(
        `UPDATE games SET status = 'cancelled', ended_at = now()
          WHERE id = $1 AND status IN ('lobby','running')`,
        [gameId],
        client,
      );
      return { gameCancelled: true, newHost: null, remaining: remaining.length };
    }

    if (game.host_player_id === playerId) {
      const heir = remaining[0] as MemberRow; // listMembers orders by joined_at
      await query('UPDATE games SET host_player_id = $2 WHERE id = $1', [gameId, heir.player_id], client);
      return { gameCancelled: false, newHost: heir, remaining: remaining.length };
    }

    return { gameCancelled: false, newHost: null, remaining: remaining.length };
  });
}

/* -------------------------------------------------------------------- start */

export async function startGame(gameId: string, byPlayerId: string): Promise<GameRow> {
  return withTransaction(async (client) => {
    const game = await lockGame(gameId, client);
    // Buttons stay tappable forever in WhatsApp history, so Start is routinely
    // pressed on a game that ended hours ago. Each case says what happened and
    // what to do instead, rather than a bare refusal.
    if (!game) {
      throw new GameError(
        'That room has expired and its details are gone. Send *play* to set up a new game.',
      );
    }
    if (game.status === 'running') {
      throw new GameError(`Room *${game.room_code}* is already running. Open your board to play.`);
    }
    if (game.status === 'completed') {
      throw new GameError(`Room *${game.room_code}* has finished. Send *play* to start a new game.`);
    }
    if (game.status !== 'lobby') {
      throw new GameError(
        `Room *${game.room_code}* was closed before it started. Send *play* to set up a new game.`,
      );
    }
    if (game.host_player_id !== byPlayerId) {
      throw new GameError('Only the host can start this game.');
    }

    const engine = getEngine(game.game_key);
    const members = await countMembers(game.id, client);

    // The host counts as a player, so a minimum of 2 means the host plus one
    // other. The platform floor and the engine's own minimum both apply.
    // Checked at Start, charged at the first number: the host learns about a
    // shortfall before their friends are waiting, but is not billed for a game
    // that never begins.
    if (game.plan_price_paise > 0 && game.host_player_id) {
      const comps = await getFreeGames(game.host_player_id, client);
      const affordable =
        comps > 0 || (await hasSufficientBalance(game.host_player_id, game.plan_price_paise, client));
      if (!affordable) {
        throw new GameError(
          'Not enough credits to start this game. Send *balance* to check your wallet, then top up.',
        );
      }
    }

    const minimum = Math.max(engine.minPlayers, env.MIN_PLAYERS_TO_START);
    if (members < minimum) {
      const short = minimum - members;
      throw new GameError(
        `Need ${minimum} players to start — waiting for ${short} more. Share code *${game.room_code}*.`,
      );
    }

    const updated = await queryOne<GameRow>(
      `UPDATE games SET status = 'running', started_at = now() WHERE id = $1 RETURNING ${GAME_COLUMNS}`,
      [game.id],
      client,
    );
    if (!updated) throw new GameError('Could not start the game.');
    return updated;
  });
}

export async function endGame(
  gameId: string,
  status: 'completed' | 'cancelled' = 'completed',
): Promise<void> {
  await query('UPDATE games SET status = $2, ended_at = now() WHERE id = $1 AND ended_at IS NULL', [
    gameId,
    status,
  ]);
}

/* --------------------------------------------------------------------- draw */

export interface DrawOutcome {
  game: GameRow;
  value: number | null;
  seq: number;
  finished: boolean;
}

/**
 * Advances one game by a single number. Row-locked so concurrent workers can
 * never double-draw, and the draw is persisted in the same transaction as the
 * state cursor so a crash mid-tick cannot desynchronise them.
 *
 * `expectedSeq` guards against a stale timeout job firing after the tick was
 * already advanced early by every player answering.
 */
/**
 * What a room of this many players costs, in the same product the host bought.
 *
 * Looked up rather than derived, because bands are a commercial decision that
 * changes from the admin panel. A host who bought a day pass is priced against
 * day passes; a single game against single games.
 */
async function priceForSeated(
  seated: number,
  planKey: string | null,
  client: Queryable,
): Promise<number | null> {
  if (!planKey) return null;

  const row = await queryOne<{ price_paise: number }>(
    `SELECT p.price_paise
       FROM plans p
      WHERE p.is_active
        AND p.kind = (SELECT kind FROM plans WHERE plan_key = $2)
        AND $1 BETWEEN p.min_players AND p.max_players
      LIMIT 1`,
    [Math.max(seated, 1), planKey],
    client,
  );
  return row?.price_paise ?? null;
}

export async function performDraw(gameId: string, expectedSeq?: number): Promise<DrawOutcome | null> {
  return withTransaction(async (client) => {
    const game = await lockGame(gameId, client);
    if (!game || game.status !== 'running') return null;

    const engine = getEngine(game.game_key);
    const cursor = Number((game.state as { cursor?: number }).cursor ?? 0);
    if (expectedSeq !== undefined && cursor !== expectedSeq) return null;

    const result = engine.draw(game.state as never, game.config as never);

    if (result.value === null) {
      await query(`UPDATE games SET status = 'completed', ended_at = now() WHERE id = $1`, [game.id], client);
      return { game, value: null, seq: result.seq, finished: true };
    }

    await query(
      'INSERT INTO game_draws (game_id, seq, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [game.id, result.seq, result.value],
      client,
    );

    // The host pays when the game actually delivers something — the first
    // number — not when they press Start. A room nobody joined, or one
    // abandoned before it began, therefore costs nothing and the credit stays
    // in their wallet for the next attempt.
    if (result.seq === 1 && !game.charged_at && game.plan_price_paise > 0 && game.host_player_id) {
      // A comped game is spent first, so a free game given for a fault is used
      // before the host's own money.
      const usedComp = await consumeFreeGame(game.host_player_id, client);

      if (usedComp) {
        await query(
          `UPDATE games SET charged_at = now(), charged_paise = 0, paid_with = 'free_game'
            WHERE id = $1`,
          [game.id],
          client,
        );
        return {
          game: (await lockGame(game.id, client)) ?? game,
          value: result.value,
          seq: result.seq,
          finished: engine.isFinished(result.state as never, await listAwardedClaims(game.id, client)),
        };
      }

      // Charge for the room that actually happened, not the one that was
      // estimated.
      //
      // A host guesses "26-50" and pays for that band, then seventeen people
      // turn up. Holding the game hostage until fifty arrive would be absurd,
      // and keeping the difference would be charging for empty chairs. So the
      // price is recomputed from the players actually seated when the first
      // number is called — the same moment the charge has always happened —
      // and never exceeds what the host was quoted.
      //
      // The overpayment simply stays in their wallet as credit, which is what
      // the refunds policy already promises: credits are the unit, and unspent
      // credit is available for the next game.
      const seated = await countMembers(game.id, client);
      const actual = await priceForSeated(seated, game.plan_key, client);
      const chargePaise = Math.min(game.plan_price_paise, actual ?? game.plan_price_paise);

      const charged = await postLedgerEntry(
        {
          playerId: game.host_player_id,
          amountPaise: -chargePaise,
          kind: 'game_charge',
          referenceType: 'game',
          referenceId: game.id,
          idempotencyKey: `game:${game.id}`,
          note:
            chargePaise < game.plan_price_paise
              ? `room ${game.room_code} - ${seated} players, charged for the smaller band`
              : `${game.plan_key ?? 'plan'} - room ${game.room_code}`,
        },
        client,
      );

      if (charged) {
        await query(
          `UPDATE games SET charged_at = now(), charged_paise = $2, paid_with = 'credits'
            WHERE id = $1`,
          [game.id, game.plan_price_paise],
          client,
        );
      }
    }

    const awarded = await listAwardedClaims(game.id, client);
    const finished = engine.isFinished(result.state as never, awarded);

    const updated = await queryOne<GameRow>(
      `UPDATE games
          SET state = $2,
              status = CASE WHEN $3::boolean THEN 'completed' ELSE status END,
              ended_at = CASE WHEN $3::boolean THEN now() ELSE ended_at END
        WHERE id = $1
        RETURNING ${GAME_COLUMNS}`,
      [game.id, result.state, finished],
      client,
    );

    return { game: updated ?? game, value: result.value, seq: result.seq, finished };
  });
}

/* --------------------------------------------------- per-draw acknowledgement */

/**
 * Records a player's "I have it" / "not on my ticket" tap. Marks are derived
 * from the draw log, not from this — the tap is presence and engagement data,
 * and the signal that lets the tick advance before its timeout.
 */
export async function recordDrawResponse(
  gameId: string,
  seq: number,
  playerId: string,
  hasNumber: boolean,
): Promise<void> {
  await query(
    `INSERT INTO game_draw_responses (game_id, seq, player_id, has_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_id, seq, player_id) DO NOTHING`,
    [gameId, seq, playerId, hasNumber],
  );
}

/** True once every seated player has answered the current number. */
export async function allPlayersResponded(gameId: string, seq: number): Promise<boolean> {
  const row = await queryOne<{ pending: string }>(
    `SELECT count(*)::text AS pending
       FROM game_players gp
      WHERE gp.game_id = $1
        AND gp.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM game_draw_responses r
           WHERE r.game_id = gp.game_id AND r.player_id = gp.player_id AND r.seq = $2
        )`,
    [gameId, seq],
  );
  return Number(row?.pending ?? 1) === 0;
}

/**
 * How many acknowledgements arrived across the most recent `window` numbers.
 *
 * Zero means nobody in the room is paying attention any more.
 */
export async function countRecentResponses(
  gameId: string,
  currentSeq: number,
  window: number,
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM game_draw_responses
      WHERE game_id = $1 AND seq > $2`,
    [gameId, Math.max(currentSeq - window, 0)],
  );
  return Number(row?.count ?? 0);
}

/* -------------------------------------------------------------------- claim */

export interface ClaimResult {
  outcome: ClaimOutcome;
  prizePaise: number;
  gameFinished: boolean;
  entryNo?: number;
}

/**
 * Validates a claim against every board the player holds and awards the first
 * one that satisfies the pattern. The partial unique index on
 * (game_id, claim_type) for awarded rows is the real guard against two players
 * winning the same prize on simultaneous taps.
 */
export async function submitClaim(gameId: string, playerId: string, claimType: string): Promise<ClaimResult> {
  return withTransaction(async (client) => {
    const game = await lockGame(gameId, client);
    if (!game) throw new GameError('That game no longer exists.');
    if (game.status !== 'running') throw new GameError('The game is not running.');

    const engine = getEngine(game.game_key);
    const drawn = await listDrawnNumbers(game.id, client);
    const awarded = await listAwardedClaims(game.id, client);

    const penalise = (game.config as { penaliseFalseClaims?: boolean }).penaliseFalseClaims ?? false;
    if (penalise) {
      const bogey = await queryOne<{ count: string }>(
        `SELECT count(*)::text AS count FROM game_claims
          WHERE game_id = $1 AND player_id = $2 AND status = 'rejected'`,
        [game.id, playerId],
        client,
      );
      if (Number(bogey?.count ?? 0) > 0) {
        throw new GameError('You have a bogey claim in this game and can no longer claim prizes.');
      }
    }

    const entries = await listEntriesForPlayer(game.id, playerId, client);
    if (entries.length === 0) {
      throw new GameError(`You are not holding a ${engine.entryNoun} in this game.`);
    }

    let winning: { entry: EntryRow; outcome: ClaimOutcome } | null = null;
    let lastFailure: ClaimOutcome | null = null;

    for (const row of entries) {
      const entry: Entry = { entryNo: row.entry_no, payload: row.payload };
      const outcome = engine.validateClaim(entry as never, claimType, { drawn, alreadyAwarded: awarded });
      if (outcome.ok) {
        winning = { entry: row, outcome };
        break;
      }
      lastFailure = outcome;
    }

    const drawSeq = drawn.length;

    if (!winning) {
      const failure = lastFailure ?? { ok: false as const, claimType, reason: 'Claim not valid.' };
      await query(
        `INSERT INTO game_claims (game_id, player_id, claim_type, status, reason, draw_seq)
         VALUES ($1, $2, $3, 'rejected', $4, $5)`,
        [game.id, playerId, claimType, 'reason' in failure ? failure.reason : null, drawSeq],
        client,
      );
      return { outcome: failure, prizePaise: 0, gameFinished: false };
    }

    const definition = engine.claims().find((c) => c.key === claimType);
    const prizePaise = definition ? Math.floor(game.prize_pool_paise * definition.prizeShare) : 0;

    try {
      await query(
        `INSERT INTO game_claims (game_id, player_id, entry_id, claim_type, status, draw_seq, prize_paise)
         VALUES ($1, $2, $3, $4, 'awarded', $5, $6)`,
        [game.id, playerId, winning.entry.id, claimType, drawSeq, prizePaise],
        client,
      );
    } catch (err) {
      // Another transaction won the race for this prize.
      if ((err as { code?: string }).code === '23505') {
        return {
          outcome: { ok: false, claimType, reason: 'That prize has just been won by another player.' },
          prizePaise: 0,
          gameFinished: false,
        };
      }
      throw err;
    }

    if (prizePaise > 0) {
      await postLedgerEntry(
        {
          playerId,
          amountPaise: prizePaise,
          kind: 'prize',
          referenceType: 'game',
          referenceId: game.id,
          idempotencyKey: `prize:${game.id}:${claimType}`,
        },
        client,
      );
    }

    const nowAwarded = [...awarded, claimType];
    const gameFinished = engine.isFinished(game.state as never, nowAwarded);
    if (gameFinished) {
      await query(`UPDATE games SET status = 'completed', ended_at = now() WHERE id = $1`, [game.id], client);
    }

    return { outcome: winning.outcome, prizePaise, gameFinished, entryNo: winning.entry.entry_no };
  });
}
