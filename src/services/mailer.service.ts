import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Outbound email.
 *
 * Sent from the no-reply mailbox, never from the admin one. A reply to an
 * automated alert should go nowhere rather than into the mailbox support
 * tickets arrive in, and the admin credentials should not be the ones sitting
 * in an SMTP session on every game that ends.
 *
 * The transport is created once and reused: Hostinger, like most SMTP hosts,
 * rate-limits connections rather than messages, and opening a fresh connection
 * per email is what turns a busy evening into a temporary ban.
 */

let transport: Transporter | null = null;

export function mailConfigured(): boolean {
  return Boolean(env.MAIL_HOST && env.NOREPLYMAIL && env.NOREPLYMAIL_PASSWORD);
}

function getTransport(): Transporter | null {
  if (!mailConfigured()) return null;
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: env.MAIL_HOST,
    port: env.MAIL_PORT,
    secure: env.MAIL_SECURE,
    auth: { user: env.NOREPLYMAIL, pass: env.NOREPLYMAIL_PASSWORD },
    // Kept low so a hung SMTP connection cannot stall the digest job behind it.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMailInput {
  to?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Attachment[];
}

export interface SendResult {
  ok: boolean;
  error?: string;
  recipient: string;
}

/**
 * Sends one email.
 *
 * Never throws. An alert failing to send must not take down the game that
 * triggered it — the whole point of these is to be told what happened, and a
 * notification that can break the thing it reports on is worse than none.
 */
export async function sendMail(input: SendMailInput): Promise<SendResult> {
  const recipient = input.to || env.ALERT_RECIPIENT || env.ADMINMAIL;

  if (!env.ADMIN_NOTIFICATIONS_ENABLED) {
    return { ok: false, error: 'notifications disabled', recipient };
  }
  if (!recipient) {
    return { ok: false, error: 'no recipient configured', recipient: '' };
  }

  const tx = getTransport();
  if (!tx) {
    return { ok: false, error: 'mail is not configured', recipient };
  }

  try {
    const info = await tx.sendMail({
      from: `"${env.MAIL_FROM_NAME}" <${env.NOREPLYMAIL}>`,
      to: recipient,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    });

    logger.info({ to: recipient, subject: input.subject, id: info.messageId }, 'alert email sent');
    return { ok: true, recipient };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'send failed';
    logger.error({ err, to: recipient, subject: input.subject }, 'alert email failed');
    return { ok: false, error, recipient };
  }
}

/** Proves the credentials work, without sending anything. */
export async function verifyMail(): Promise<{ ok: boolean; error?: string }> {
  const tx = getTransport();
  if (!tx) return { ok: false, error: 'mail is not configured' };

  try {
    await tx.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verify failed' };
  }
}
