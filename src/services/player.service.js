/**
 * Players, their place in the conversation, and their consent.
 */
import { pool, query } from '../db/pool.js';

/** Bump this when the policy text changes; everyone is asked to agree again. */
export const POLICY_VERSION = '2026-09-01';

/**
 * Every inbound message starts here. Upserting rather than select-then-insert
 * means two messages arriving together cannot create the same player twice.
 */
export async function findOrCreatePlayer(waId, displayName = null) {
  const { rows } = await query(
    `INSERT INTO players (wa_id, display_name)
          VALUES ($1, $2)
     ON CONFLICT (wa_id) DO UPDATE
            SET last_seen_at = now(),
                display_name = COALESCE(players.display_name, EXCLUDED.display_name)
      RETURNING *`,
    [waId, displayName],
  );
  return rows[0];
}

export async function getPlayerById(id) {
  const { rows } = await query('SELECT * FROM players WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Friendly name for the board and the live feed. Never leaks a full number. */
export function displayNameFor(player) {
  if (player.display_name) return player.display_name;
  const digits = String(player.wa_id);
  return `Player ${digits.slice(-4)}`;
}

// --- Conversation state ----------------------------------------------------

export async function getState(playerId) {
  const { rows } = await query('SELECT * FROM player_states WHERE player_id = $1', [playerId]);
  return rows[0] ?? { player_id: playerId, state: 'new', context: {} };
}

export async function setState(playerId, state, context = {}) {
  const { rows } = await query(
    `INSERT INTO player_states (player_id, state, context, updated_at)
          VALUES ($1, $2, $3, now())
     ON CONFLICT (player_id) DO UPDATE
            SET state = EXCLUDED.state,
                context = EXCLUDED.context,
                updated_at = now()
      RETURNING *`,
    [playerId, state, context],
  );
  return rows[0];
}

/** Merges into the existing context rather than replacing it. */
export async function patchContext(playerId, patch) {
  const current = await getState(playerId);
  return setState(current.player_id, current.state, { ...current.context, ...patch });
}

// --- Consent ---------------------------------------------------------------

export async function hasConsented(playerId, version = POLICY_VERSION) {
  const { rows } = await query(
    'SELECT 1 FROM consents WHERE player_id = $1 AND policy_version = $2 LIMIT 1',
    [playerId, version],
  );
  return rows.length > 0;
}

export async function recordConsent(playerId, version = POLICY_VERSION, source = 'whatsapp') {
  await query(
    'INSERT INTO consents (player_id, policy_version, source) VALUES ($1, $2, $3)',
    [playerId, version, source],
  );
}

// --- Message log -----------------------------------------------------------

/** Best-effort: a logging failure must never break a live game. */
export async function logMessage({ playerId, direction, waMessageId, kind, body }) {
  try {
    await query(
      `INSERT INTO messages (player_id, direction, wa_message_id, kind, body)
            VALUES ($1, $2, $3, $4, $5)`,
      [playerId ?? null, direction, waMessageId ?? null, kind ?? null, body ?? null],
    );
  } catch {
    /* ignore */
  }
}

/**
 * Records an outbound message and how it went, keyed by WhatsApp number.
 *
 * Wired to the WhatsApp client at boot. Without this the conversation view
 * shows what we meant to send but not whether it arrived, which is the one
 * thing you need when a player says they got nothing.
 */
export async function logOutbound({ to, payload, describe, result }) {
  try {
    const { rows } = await query('SELECT id FROM players WHERE wa_id = $1', [String(to)]);
    const body = payload?.type === 'text'
      ? payload.text?.body
      : (payload?.interactive?.body?.text ?? describe);

    await query(
      `INSERT INTO messages (player_id, direction, wa_message_id, kind, body, status, error)
            VALUES ($1, 'out', $2, $3, $4, $5, $6)`,
      [
        rows[0]?.id ?? null,
        result?.waMessageId ?? null,
        payload?.interactive?.type ?? payload?.type ?? null,
        body ?? null,
        result?.status ?? null,
        result?.error ?? null,
      ],
    );
  } catch {
    /* never break sending because logging failed */
  }
}

/**
 * Webhook de-duplication. Meta retries hard; returns false when this message
 * id has been seen before, so the caller drops it before any game logic runs.
 */
export async function claimMessageId(messageId) {
  if (!messageId) return true;
  const { rows } = await pool.query(
    `INSERT INTO processed_messages (message_id) VALUES ($1)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [messageId],
  );
  return rows.length > 0;
}
