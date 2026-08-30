import { query, queryOne } from '../db/pool.js';
import { generateRoomCode } from '../utils/ids.js';

/** Support tickets raised by players or opened by an admin on their behalf. */

export type TicketStatus = 'open' | 'in_progress' | 'waiting_on_player' | 'resolved' | 'closed';

export interface TicketInput {
  playerId?: string | null;
  waId?: string | null;
  gameId?: string | null;
  subject: string;
  body: string;
  category?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export async function createTicket(input: TicketInput): Promise<Record<string, unknown> | null> {
  // Short human-quotable reference, the same alphabet as room codes so it is
  // unambiguous when read aloud on a call.
  const reference = `T-${generateRoomCode(6)}`;

  const ticket = await queryOne(
    `INSERT INTO support_tickets (reference, player_id, wa_id, game_id, subject, body, category, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'normal'))
     RETURNING *`,
    [
      reference,
      input.playerId ?? null,
      input.waId ?? null,
      input.gameId ?? null,
      input.subject.slice(0, 200),
      input.body.slice(0, 5000),
      input.category ?? null,
      input.priority ?? null,
    ],
  );

  if (ticket) {
    await query(
      `INSERT INTO support_ticket_messages (ticket_id, author, body) VALUES ($1, 'player', $2)`,
      [ticket['id'], input.body.slice(0, 5000)],
    );
  }
  return ticket;
}

export async function listTickets(
  limit: number,
  offset: number,
  status?: TicketStatus,
): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT t.id, t.reference, t.subject, t.status, t.priority, t.category,
            t.created_at, t.updated_at, t.resolved_at, t.assigned_to,
            p.wa_id, p.display_name, g.room_code,
            (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS messages
       FROM support_tickets t
       LEFT JOIN players p ON p.id = t.player_id
       LEFT JOIN games g   ON g.id = t.game_id
      WHERE ($3::text IS NULL OR t.status = $3)
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, status ?? null],
  );
}

export async function getTicket(id: string): Promise<Record<string, unknown> | null> {
  const ticket = await queryOne(
    `SELECT t.*, p.wa_id, p.display_name, g.room_code
       FROM support_tickets t
       LEFT JOIN players p ON p.id = t.player_id
       LEFT JOIN games g   ON g.id = t.game_id
      WHERE t.id = $1`,
    [id],
  );
  if (!ticket) return null;

  const messages = await query(
    `SELECT author, author_name, body, created_at
       FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at`,
    [id],
  );
  return { ticket, messages };
}

export async function updateTicket(
  id: string,
  changes: { status?: TicketStatus; priority?: string; assigned_to?: string | null; category?: string | null },
): Promise<Record<string, unknown> | null> {
  return queryOne(
    `UPDATE support_tickets
        SET status      = COALESCE($2, status),
            priority    = COALESCE($3, priority),
            assigned_to = COALESCE($4, assigned_to),
            category    = COALESCE($5, category),
            resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE resolved_at END,
            updated_at  = now()
      WHERE id = $1
      RETURNING *`,
    [id, changes.status ?? null, changes.priority ?? null, changes.assigned_to ?? null, changes.category ?? null],
  );
}

export async function addTicketMessage(
  ticketId: string,
  author: 'player' | 'admin',
  body: string,
  authorName?: string,
): Promise<Record<string, unknown> | null> {
  const message = await queryOne(
    `INSERT INTO support_ticket_messages (ticket_id, author, author_name, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ticketId, author, authorName ?? null, body.slice(0, 5000)],
  );
  await query('UPDATE support_tickets SET updated_at = now() WHERE id = $1', [ticketId]);
  return message;
}

export async function ticketStats(): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'open')::int              AS open,
            count(*) FILTER (WHERE status = 'in_progress')::int       AS in_progress,
            count(*) FILTER (WHERE status = 'waiting_on_player')::int AS waiting,
            count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS closed,
            count(*) FILTER (WHERE priority IN ('high','urgent') AND status NOT IN ('resolved','closed'))::int AS urgent_open
       FROM support_tickets`,
  );
}
