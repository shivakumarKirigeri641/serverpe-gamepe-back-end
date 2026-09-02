/**
 * Outbound email.
 *
 * Only used for support: a copy of every ticket goes to the support inbox so
 * an operator sees it without opening the panel.
 *
 * Mirrors the WhatsApp client's two safety properties: with no SMTP
 * configured, mail is logged instead of sent, and a failure to send never
 * breaks the thing that triggered it. A support request that reached the
 * database but not the inbox is still a support request — losing it because
 * the mail server was down would be far worse.
 */
import nodemailer from 'nodemailer';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';

let transport = null;

function get() {
  if (transport) return transport;
  const m = config.mail;
  if (!m.host || !m.user) return null;

  transport = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.secure,
    auth: { user: m.user, pass: m.password },
  });
  return transport;
}

export function mailConfigured() {
  return Boolean(config.mail.host && config.mail.user);
}

/**
 * @returns {Promise<{sent:boolean, error?:string}>} never throws
 */
export async function sendMail({ to, subject, text, replyTo }) {
  const m = config.mail;

  if (!mailConfigured()) {
    log.info(`[mail dry run] -> ${to}: ${subject}`);
    return { sent: false, dryRun: true };
  }

  try {
    await get().sendMail({
      from: `"${m.fromName}" <${m.user}>`,
      to,
      replyTo: replyTo || undefined,
      subject,
      text,
    });
    log.info('mail sent', { to, subject });
    return { sent: true };
  } catch (err) {
    log.error('mail failed', { to, subject, message: err.message });
    return { sent: false, error: err.message };
  }
}

/** Verifies SMTP without sending anything — used by the admin diagnostics. */
export async function verifyMail() {
  if (!mailConfigured()) return { ok: false, reason: 'SMTP is not configured' };
  try {
    await get().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
