import { redis } from '../redis/client.js';
import { logger } from '../utils/logger.js';

/**
 * Who currently has the web board open.
 *
 * The page polls for state every few seconds, so a recent poll is a reliable
 * signal that someone is watching. That lets the draw loop stay quiet in chat
 * for players who can already see the number on their screen, and only nudge
 * the ones who cannot.
 *
 * Deliberately short-lived: if a player closes the tab or their phone sleeps,
 * the key expires within seconds and chat notifications resume on their own.
 */
const ACTIVE_TTL_SECONDS = 25;

function key(gameId: string, playerId: string): string {
  return `board:active:${gameId}:${playerId}`;
}

export async function markBoardActive(gameId: string, playerId: string): Promise<void> {
  try {
    await redis.set(key(gameId, playerId), '1', 'EX', ACTIVE_TTL_SECONDS);
  } catch (err) {
    logger.debug({ err }, 'could not record board presence');
  }
}

export async function isBoardActive(gameId: string, playerId: string): Promise<boolean> {
  try {
    return (await redis.exists(key(gameId, playerId))) === 1;
  } catch {
    // If Redis is unavailable, assume nobody is watching and keep messaging —
    // a duplicate notification is far better than a silent game.
    return false;
  }
}
