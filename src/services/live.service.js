/**
 * Live updates to the browser, over Server-Sent Events.
 *
 * SSE rather than WebSockets: the traffic is one-way (server tells the board
 * what happened), it is plain HTTP so it passes through ngrok and any proxy
 * untouched, and browsers reconnect on their own. That last property is what
 * makes this survive WhatsApp's in-app browser suspending a backgrounded page.
 *
 * On reconnect the client sends Last-Event-ID and we replay from the `draws`
 * table, so nothing is ever reconstructed from what the browser remembered.
 *
 * SCALING NOTE: this registry is per-process. Running two instances would give
 * each its own set of connections. When that day comes, replace broadcast()
 * with Postgres LISTEN/NOTIFY - every other module already goes through here.
 */
import { log } from '../utils/logger.js';

/** gameId -> Set of response objects */
const rooms = new Map();

const HEARTBEAT_MS = 25_000;

export function subscribe(gameId, res) {
  const key = String(gameId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(res);

  // Proxies and mobile networks drop idle connections. A comment line every
  // 25s keeps the pipe open without producing a client-visible event.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe(gameId, res);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  log.debug('sse subscribed', { gameId: key, listeners: rooms.get(key).size });
}

export function unsubscribe(gameId, res) {
  const key = String(gameId);
  const set = rooms.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) rooms.delete(key);
}

/**
 * Push an event to everyone watching a game.
 *
 * `id` lets a reconnecting browser tell us where it left off. A write that
 * throws means the client is gone; drop it rather than letting one dead
 * socket break the fan-out for everyone else.
 */
export function broadcast(gameId, event, data, id = null) {
  const set = rooms.get(String(gameId));
  if (!set || set.size === 0) return 0;

  const frame =
    (id !== null ? `id: ${id}\n` : '') +
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`;

  let delivered = 0;
  for (const res of [...set]) {
    try {
      res.write(frame);
      delivered++;
    } catch (err) {
      log.debug('dropping dead sse client', { message: err.message });
      set.delete(res);
    }
  }
  return delivered;
}

/** Send one event to a single connection - used for the initial snapshot. */
export function sendTo(res, event, data, id = null) {
  try {
    res.write(
      (id !== null ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  } catch {
    /* client vanished mid-write */
  }
}

export function listenerCount(gameId) {
  return rooms.get(String(gameId))?.size ?? 0;
}

/**
 * Coalesced broadcast: at most one send per game per window, carrying only the
 * latest payload.
 *
 * This exists because of a measured problem. The "N of M have answered" event
 * fired once per answer, and each event was written to every open board — so a
 * game of 500 sent 250,000 socket writes for a single number, and p95 answer
 * latency went from 0.6s to 3.2s. The count is a progress indicator; nobody
 * needs every intermediate value, only a current one.
 *
 * Draws and prize claims deliberately do NOT go through this. Those are events
 * players react to, and delaying one by even a moment would be felt.
 */
const pendingCoalesced = new Map();   // key -> { data, timer }

export function broadcastCoalesced(gameId, event, data, windowMs = 400) {
  const key = `${gameId}:${event}`;
  const existing = pendingCoalesced.get(key);

  if (existing) {
    // A newer count supersedes the one waiting to go out.
    existing.data = data;
    return;
  }

  const entry = {
    data,
    timer: setTimeout(() => {
      pendingCoalesced.delete(key);
      broadcast(gameId, event, entry.data);
    }, windowMs),
  };
  entry.timer.unref?.();
  pendingCoalesced.set(key, entry);
}

/** Drops anything still waiting for a game that has ended. */
export function cancelCoalesced(gameId) {
  for (const [key, entry] of pendingCoalesced) {
    if (key.startsWith(`${gameId}:`)) {
      clearTimeout(entry.timer);
      pendingCoalesced.delete(key);
    }
  }
}

/** Closes every stream - used on shutdown so browsers reconnect promptly. */
export function closeAll() {
  for (const set of rooms.values()) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
  }
  rooms.clear();
}
