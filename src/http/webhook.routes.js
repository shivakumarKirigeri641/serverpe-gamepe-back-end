/**
 * The WhatsApp webhook.
 *
 * Meta expects a 200 within a few seconds and retries hard when it does not
 * get one - and a webhook that keeps timing out eventually gets disabled on
 * the app. So this endpoint does the absolute minimum inline (verify, dedupe,
 * acknowledge) and processes the message after the response has gone out.
 */
import { Router } from 'express';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { verifySubscription, verifySignature } from '../whatsapp/verify.js';
import { parseInbound, isStatusCallback } from '../whatsapp/parse.js';
import { claimMessageId } from '../services/player.service.js';
import { handleInbound } from '../services/conversation.service.js';

export function webhookRoutes() {
  const router = Router();
  const path = config.whatsapp.webhookPath;

  // Meta's one-time handshake when you save the callback URL.
  router.get(path, (req, res) => {
    const result = verifySubscription(req.query);
    if (!result.ok) return res.sendStatus(403);
    log.info('webhook verified by Meta');
    res.status(200).send(result.challenge);
  });

  router.post(path, (req, res) => {
    const signature = verifySignature(req);
    if (!signature.ok) {
      log.warn('rejected unsigned webhook', { reason: signature.reason });
      return res.sendStatus(401);
    }
    if (signature.skipped) log.debug('signature check skipped - WHATSAPP_APP_SECRET is not set');

    // Acknowledge first. Everything below runs after the response is sent.
    res.sendStatus(200);

    const body = req.body;
    if (isStatusCallback(body)) return;

    setImmediate(() => {
      processPayload(body).catch((err) =>
        log.error('webhook processing failed', { message: err.message, stack: err.stack }),
      );
    });
  });

  return router;
}

async function processPayload(body) {
  const events = parseInbound(body);
  if (events.length === 0) return;

  for (const event of events) {
    // Insert-first de-duplication: no row back means Meta has sent us this
    // message before and the work is already done.
    const isNew = await claimMessageId(event.waMessageId);
    if (!isNew) {
      log.debug('duplicate webhook dropped', { waMessageId: event.waMessageId });
      continue;
    }

    log.info('inbound', {
      from: event.from,
      type: event.type,
      text: event.text?.slice(0, 60),
      replyId: event.replyId,
    });

    await handleInbound(event);
  }
}
