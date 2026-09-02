/**
 * Support tickets.
 *
 * A player fills in the web form, gets a short reference on WhatsApp
 * immediately, and can check the status later. An operator answers from the
 * admin panel, and the reply is pushed straight back to the player's WhatsApp
 * rather than sitting in a portal nobody revisits.
 */
import { randomInt } from 'node:crypto';
import { query, withTransaction, isUniqueViolation } from '../db/pool.js';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { sendMail } from './mailer.service.js';
import { sendText } from '../whatsapp/client.js';
import { recordEvent } from './tracking.service.js';
import { notify } from './notification.service.js';

/** The kinds of question the form offers. Stored as the key. */
export const QUERY_TYPES = [
  { key: 'gameplay', label: 'A problem during a game' },
  { key: 'prize', label: 'A prize or result I disagree with' },
  { key: 'account', label: 'My account or my number' },
  { key: 'payment', label: 'Payments or sponsorship' },
  { key: 'privacy', label: 'Privacy or deleting my data' },
  { key: 'suggestion', label: 'A suggestion' },
  { key: 'other', label: 'Something else' },
];

const labelFor = (key) => QUERY_TYPES.find((q) => q.key === key)?.label ?? key;

/**
 * Short, unambiguous, and unrelated to the row id. Same alphabet as room
 * codes, so nothing a player has to read out contains O/0 or I/1.
 */
function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(0, alphabet.length)];
  return `MP-${out}`;
}

export async function createTicket({ playerId, name, waId, email, queryType, message }) {
  const type = QUERY_TYPES.some((q) => q.key === queryType) ? queryType : 'other';
  const subject = `${labelFor(type)} — ${name}`;

  const ticket = await withTransaction(async (client) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const { rows } = await client.query(
          `INSERT INTO support_tickets
             (reference, player_id, name, wa_id, email, query_type, subject, message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [newReference(), playerId, name, waId, email || null, type, subject, message],
        );
        const row = rows[0];
        await client.query(
          `INSERT INTO support_ticket_messages (ticket_id, author, author_name, body)
                VALUES ($1, 'player', $2, $3)`,
          [row.id, name, message],
        );
        return row;
      } catch (err) {
        // References are short enough to collide; retry rather than widen them.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new Error('Could not allocate a ticket reference, please try again');
  });

  await recordEvent({
    type: 'support.opened', source: 'board', playerId, gameId: null,
    properties: { reference: ticket.reference, queryType: type },
  });

  // Email and WhatsApp are both best-effort AFTER the ticket is safely stored.
  emailTicket(ticket).catch(() => {});
  if (waId) {
    sendText(waId, ticketOpenedText(ticket)).catch(() => {});
  }

  notify('support.raised', {
    title: `Support ticket ${ticket.reference}`,
    lines: [
      `From: ${ticket.name} (+${ticket.wa_id ?? 'unknown'})`,
      `About: ${labelFor(ticket.query_type)}`,
      '',
      ticket.message.slice(0, 500),
    ],
    playerId, gameId: null,
  });
  log.info('support ticket opened', { reference: ticket.reference, type });
  return ticket;
}

async function emailTicket(ticket) {
  const body = [
    `New support request — ${ticket.reference}`,
    '',
    `From:     ${ticket.name}`,
    `WhatsApp: ${ticket.wa_id ? '+' + ticket.wa_id : 'not given'}`,
    `Email:    ${ticket.email || 'not given'}`,
    `About:    ${labelFor(ticket.query_type)}`,
    `Opened:   ${new Date(ticket.created_at).toLocaleString('en-IN', { timeZone: config.timezone })}`,
    '',
    '--- their message ---',
    ticket.message,
    '',
    `Reply from the admin panel — the player gets it on WhatsApp.`,
  ].join('\n');

  const result = await sendMail({
    to: config.mail.supportInbox,
    subject: `[${ticket.reference}] ${ticket.subject}`,
    text: body,
    replyTo: ticket.email || undefined,
  });

  await query(
    'UPDATE support_tickets SET emailed_at = $2, email_error = $3 WHERE id = $1',
    [ticket.id, result.sent ? new Date() : null, result.error ?? null],
  );
}

function ticketOpenedText(ticket) {
  return [
    `Thanks — we have your message. 🎫`,
    '',
    `*Your reference: ${ticket.reference}*`,
    '',
    `About: ${labelFor(ticket.query_type)}`,
    '',
    `We will reply here on WhatsApp. Quote that reference if you message us again.`,
    '',
    `To check on it any time, send *status ${ticket.reference}*`,
  ].join('\n');
}

/** Everything on one ticket, for the admin panel and the player's status view. */
export async function getTicket(id) {
  const { rows } = await query(
    `SELECT t.*, p.display_name
       FROM support_tickets t
       LEFT JOIN players p ON p.id = t.player_id
      WHERE t.id = $1`,
    [id],
  );
  if (!rows[0]) return null;

  const { rows: messages } = await query(
    `SELECT author, author_name, body, created_at, delivered_at
       FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at`,
    [id],
  );
  return { ticket: rows[0], messages };
}

export async function getTicketByReference(reference) {
  const { rows } = await query(
    'SELECT id FROM support_tickets WHERE upper(reference) = upper($1)',
    [String(reference).trim()],
  );
  return rows[0] ? getTicket(rows[0].id) : null;
}

/**
 * The one ticket a player's next message should be treated as a reply to.
 *
 * Only tickets still in play - a resolved or closed one should not silently
 * swallow an unrelated message weeks later. Most recent wins if there are
 * several, because that is the one they are thinking about.
 */
export async function openTicketForPlayer(playerId) {
  const { rows } = await query(
    `SELECT * FROM support_tickets
      WHERE player_id = $1
        AND status IN ('open','in_progress','waiting_on_player')
      ORDER BY updated_at DESC LIMIT 1`,
    [playerId],
  );
  return rows[0] ?? null;
}

/**
 * A player's reply, arriving as a plain WhatsApp message.
 *
 * If we had been waiting on them, this moves the ticket back into the queue -
 * otherwise a reply would sit in a status that says nobody needs to look.
 */
export async function appendPlayerMessage(ticket, { body, name }) {
  await query(
    `INSERT INTO support_ticket_messages (ticket_id, author, author_name, body)
          VALUES ($1, 'player', $2, $3)`,
    [ticket.id, name, body],
  );

  await query(
    `UPDATE support_tickets
        SET updated_at = now(),
            status = CASE WHEN status = 'waiting_on_player' THEN 'in_progress' ELSE status END
      WHERE id = $1`,
    [ticket.id],
  );

  await recordEvent({
    type: 'support.player_replied', source: 'whatsapp', playerId: ticket.player_id,
    properties: { reference: ticket.reference },
  });

  // Email the reply too. Without this an operator only learns about it by
  // happening to have the Support page open - which means a waiting player
  // gets silence until someone thinks to look.
  emailReply(ticket, { body, name }).catch(() => {});

  notify('support.replied', {
    title: `${name} replied to ${ticket.reference}`,
    lines: [`Status: ${ticket.status.replace(/_/g, ' ')}`, '', body.slice(0, 500)],
    playerId: ticket.player_id,
  });
  log.info('player replied to ticket', { reference: ticket.reference });
  return getTicket(ticket.id);
}

/** The player's own tickets, newest first. */
export async function ticketsForPlayer(playerId, limit = 10) {
  const { rows } = await query(
    `SELECT reference, subject, query_type, status, created_at, updated_at
       FROM support_tickets WHERE player_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [playerId, limit],
  );
  return rows;
}

export async function listTickets({ limit = 100, status = null } = {}) {
  const { rows } = await query(
    `SELECT t.id, t.reference, t.subject, t.query_type, t.status, t.priority,
            t.wa_id, t.email, t.created_at, t.updated_at, t.emailed_at, t.email_error,
            COALESCE(p.display_name, t.name) AS display_name,
            (SELECT count(*)::int FROM support_ticket_messages m WHERE m.ticket_id = t.id) AS messages
       FROM support_tickets t
       LEFT JOIN players p ON p.id = t.player_id
      WHERE ($2::text IS NULL OR t.status = $2)
      ORDER BY
        CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        t.created_at DESC
      LIMIT $1`,
    [limit, status],
  );

  const { rows: stats } = await query(`
    SELECT
      count(*) FILTER (WHERE status='open')::int              AS open,
      count(*) FILTER (WHERE status='in_progress')::int       AS in_progress,
      count(*) FILTER (WHERE status='waiting_on_player')::int AS waiting,
      count(*) FILTER (WHERE status='resolved')::int          AS resolved,
      count(*) FILTER (WHERE status='closed')::int            AS closed,
      count(*) FILTER (WHERE status='open' AND priority='urgent')::int AS urgent_open
      FROM support_tickets`);

  return { items: rows, stats: stats[0] };
}

/**
 * Changes status or priority.
 *
 * A status change the player would care about is also sent to them - being
 * told your problem is being looked at is most of what support is.
 */
export async function updateTicket(id, patch, by) {
  const allowedStatus = ['open', 'in_progress', 'waiting_on_player', 'resolved', 'closed'];
  const allowedPriority = ['low', 'normal', 'high', 'urgent'];

  const sets = [];
  const values = [id];
  if (patch.status !== undefined) {
    if (!allowedStatus.includes(patch.status)) throw new Error(`"${patch.status}" is not a valid status`);
    values.push(patch.status);
    sets.push(`status = $${values.length}`);
  }
  if (patch.priority !== undefined) {
    if (!allowedPriority.includes(patch.priority)) throw new Error(`"${patch.priority}" is not a valid priority`);
    values.push(patch.priority);
    sets.push(`priority = $${values.length}`);
  }
  if (sets.length === 0) return getTicket(id);

  const { rows } = await query(
    `UPDATE support_tickets SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 RETURNING *`,
    values,
  );
  const ticket = rows[0];
  if (!ticket) return null;

  if (patch.status && ticket.wa_id) {
    const note = statusNote(ticket, patch.status);
    if (note) {
      await query(
        `INSERT INTO support_ticket_messages (ticket_id, author, author_name, body, delivered_at)
              VALUES ($1, 'system', $2, $3, now())`,
        [id, by ?? 'admin', note],
      );
      sendText(ticket.wa_id, note).catch(() => {});
    }
  }

  log.info('ticket updated', { reference: ticket.reference, ...patch, by });
  return getTicket(id);
}

function statusNote(ticket, status) {
  const head = `*${ticket.reference}* — `;
  switch (status) {
    case 'in_progress': return `${head}we are looking into this now. 🔎`;
    case 'waiting_on_player': return `${head}we have replied and are waiting to hear back from you.`;
    case 'resolved': return `${head}we believe this is sorted. ✅\n\nIf it is not, just reply here and we will reopen it.`;
    case 'closed': return `${head}this has been closed.\n\nReply any time if you need it looked at again.`;
    // Reopening is not worth a notification - the reply that caused it is.
    default: return null;
  }
}

/** An operator's reply. Recorded, then pushed to the player's WhatsApp. */
export async function replyToTicket(id, { body, by }) {
  const { rows } = await query('SELECT * FROM support_tickets WHERE id = $1', [id]);
  const ticket = rows[0];
  if (!ticket) return null;

  const text = `*${ticket.reference}* — reply from ${config.brandName}\n\n${body}\n\n` +
    `Just reply here if you need anything else.`;

  let delivered = null;
  if (ticket.wa_id) {
    const result = await sendText(ticket.wa_id, text);
    if (result.sent || result.dryRun || result.captured) delivered = new Date();
  }

  await query(
    `INSERT INTO support_ticket_messages (ticket_id, author, author_name, body, delivered_at)
          VALUES ($1, 'admin', $2, $3, $4)`,
    [id, by ?? 'admin', body, delivered],
  );
  await query(
    `UPDATE support_tickets SET updated_at = now(),
            status = CASE WHEN status IN ('open') THEN 'in_progress' ELSE status END
      WHERE id = $1`,
    [id],
  );

  log.info('ticket replied', { reference: ticket.reference, delivered: Boolean(delivered) });
  return getTicket(id);
}

/**
 * Emails a player's reply to the support inbox.
 *
 * Threaded on the reference in the subject, so a mail client groups it with
 * the original ticket rather than scattering a conversation across the inbox.
 */
async function emailReply(ticket, { body, name }) {
  const text = [
    `${name} replied to ${ticket.reference}`,
    '',
    `WhatsApp: ${ticket.wa_id ? '+' + ticket.wa_id : 'not given'}`,
    `Status:   ${ticket.status.replace(/_/g, ' ')}`,
    `About:    ${labelFor(ticket.query_type)}`,
    '',
    '--- their reply ---',
    body,
    '',
    'Reply from the admin panel and it goes straight to their WhatsApp.',
  ].join('\n');

  const result = await sendMail({
    to: config.mail.supportInbox,
    // Same subject line as the original, so it threads.
    subject: `[${ticket.reference}] ${ticket.subject}`,
    text,
    replyTo: ticket.email || undefined,
  });

  if (!result.sent && result.error) {
    log.warn('could not email ticket reply', { reference: ticket.reference, message: result.error });
  }
}
