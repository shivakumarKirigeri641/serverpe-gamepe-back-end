import express, { type Express, type Request, type Response } from 'express';
import { apiPath, env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { pool } from '../db/pool.js';
import { markMessageSeen, redis } from '../redis/client.js';
import { handleInbound } from '../services/conversation.service.js';
import { applyStatus } from '../services/message.service.js';
import { EVENT, track } from '../services/analytics.service.js';
import { parseStatuses, parseWebhook } from '../whatsapp/parse.js';
import { createAdminRouter } from './admin.routes.js';
import { createBoardRouter } from './board.routes.js';
import { renderPoliciesPage } from './policies-page.js';
import { listActiveDocuments } from '../services/consent.service.js';
import { verifyChallenge, verifySignature } from '../whatsapp/verify.js';
import type { WhatsAppWebhookBody } from '../whatsapp/types.js';

export function createServer(): Express {
  const app = express();

  // Behind ngrok / a load balancer, so the forwarded client IP is the real one.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Baseline hardening. The admin API returns JSON only and the webhook is
  // machine-to-machine, so none of this needs to accommodate a rendered page.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });

  // Meta signs the exact bytes it sent, so the raw body must be preserved
  // before any JSON parsing normalises it.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  const healthHandler = async (_req: Request, res: Response): Promise<void> => {
    const checks: Record<string, string> = {};
    try {
      await pool.query('SELECT 1');
      checks['postgres'] = 'ok';
    } catch {
      checks['postgres'] = 'down';
    }
    try {
      await redis.ping();
      checks['redis'] = 'ok';
    } catch {
      checks['redis'] = 'down';
    }
    const healthy = Object.values(checks).every((v) => v === 'ok');
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  };

  // Bare path for load balancers and uptime checks; namespaced path for the
  // platform's own conventions.
  app.get('/health', healthHandler);
  app.get(apiPath('/public/health'), healthHandler);

  // Meta's webhook verification handshake.
  const webhookPath = apiPath(env.WHATSAPP_WEBHOOK_PATH);

  app.get(webhookPath, (req: Request, res: Response) => {
    const challenge = verifyChallenge(req.query as Record<string, unknown>);
    if (challenge) {
      logger.info('whatsapp webhook verified');
      res.status(200).send(challenge);
      return;
    }
    logger.warn({ query: req.query }, 'whatsapp webhook verification failed');
    res.sendStatus(403);
  });

  app.post(webhookPath, async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from('');

    if (!verifySignature(rawBody, req.header('x-hub-signature-256'))) {
      logger.warn('rejected webhook with a bad signature');
      res.sendStatus(401);
      return;
    }

    // Acknowledge immediately. Meta retries anything slower than a few seconds,
    // and a game tick is far too slow to hold the request open for.
    res.sendStatus(200);

    const body = req.body as WhatsAppWebhookBody;

    // Delivery receipts: the only real evidence a player's phone received a
    // number, as opposed to Meta having merely accepted it from us.
    for (const status of parseStatuses(body)) {
      try {
        await applyStatus(status);
      } catch (err) {
        logger.error({ err, messageId: status.messageId }, 'failed applying delivery status');
      }
    }

    for (const event of parseWebhook(body)) {
      try {
        // Meta redelivers aggressively; without this one "Hi" can open three rooms.
        if (!(await markMessageSeen(event.messageId))) {
          logger.debug({ messageId: event.messageId }, 'duplicate webhook delivery ignored');
          await track({
            type: EVENT.MESSAGE_DUPLICATE_IGNORED,
            source: 'whatsapp',
            waId: event.waId,
            properties: { messageId: event.messageId },
          });
          continue;
        }

        // Inbound logging happens inside handleInbound, where the player and
        // their active game are already resolved.
        await handleInbound(event);
      } catch (err) {
        logger.error({ err, messageId: event.messageId }, 'failed processing inbound event');
        await track({
          type: EVENT.ERROR,
          source: 'whatsapp',
          waId: event.waId,
          properties: { stage: 'inbound', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });

  // The board is a real web page opened in a browser, so it must be framed by
  // nobody but must still be reachable cross-origin from WhatsApp's launcher.
  // Public: the full policies, readable in a browser rather than chat bubbles.
  app.get(apiPath('/public/policies'), async (_req: Request, res: Response) => {
    try {
      const docs = await listActiveDocuments();
      res.type('html').set('Cache-Control', 'public, max-age=300').send(renderPoliciesPage(docs));
    } catch (err) {
      logger.error({ err }, 'failed to render policies page');
      res.status(500).type('html').send('<h1>Could not load the policies.</h1>');
    }
  });

  app.use(apiPath('/public/board'), createBoardRouter());

  app.use(apiPath(env.ADMIN_BASE_PATH), createAdminRouter());

  app.use((_req: Request, res: Response) => res.sendStatus(404));

  return app;
}

export function startServer(): ReturnType<Express['listen']> {
  const app = createServer();
  return app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        webhook: apiPath(env.WHATSAPP_WEBHOOK_PATH),
        admin: apiPath(env.ADMIN_BASE_PATH),
        health: apiPath('/public/health'),
      },
      'gamepe backend listening',
    );
  });
}
