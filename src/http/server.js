/**
 * The Express app.
 *
 * Routes get mounted here as each phase lands. Right now: health only.
 */
import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config/env.js';
import { log } from '../utils/logger.js';
import { pool } from '../db/pool.js';
import { webhookRoutes } from './webhook.routes.js';
import { policiesPage } from './policies-page.js';
import { boardRoutes } from './board.routes.js';
import { adminRoutes } from './admin.routes.js';
import { publicRoutes } from './public.routes.js';
import { formsRoutes } from './forms.routes.js';

/** src/media, resolved from this file so the cwd cannot change the answer. */
const mediaDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');

/** src/images - the brand set: favicons, icons, wordmarks, social cards. */
const imagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'images');

export function createApp() {
  const app = express();

  // Meta signs the RAW request body, so it has to be captured before JSON
  // parsing rewrites it. Doing this at parse time - rather than re-serialising
  // later - is what makes the X-Hub-Signature-256 check actually verify.
  // Getting this wrong is the single most common cause of silently dead
  // WhatsApp webhooks, so it is wired in from day one.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false }));
  app.disable('x-powered-by');

  // Behind ngrok (and later behind whatever fronts api.mastipe.in), the socket
  // address is the proxy's, not the player's. Without this every session would
  // be recorded from 127.0.0.1 and the tracking would be worthless.
  app.set('trust proxy', true);

  // Everything hangs off API_BASE_PATH so this service can share a hostname
  // with other products behind a gateway. With the variable unset the prefix
  // is empty and routes mount at the root exactly as before.
  const api = Router();

  api.get('/healthz', async (_req, res) => {
    let db = 'down';
    try {
      await pool.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }
    res.status(db === 'up' ? 200 : 503).json({
      ok: db === 'up',
      service: config.brandName,
      db,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  api.get('/policies', (_req, res) => {
    res.type('html').send(policiesPage());
  });

  // The panel is served from a different origin in production (it is a static
  // Vite build), so it needs explicit CORS. In development Vite proxies
  // /serverpe, making requests same-origin and this a no-op.
  if (config.admin.corsOrigins.length) {
    api.use(config.admin.basePath, (req, res, next) => {
      const origin = req.get('origin');
      if (origin && config.admin.corsOrigins.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  api.use(config.admin.basePath, adminRoutes());

  /**
   * The demo videos, and anything else that ships with the repo.
   *
   * express.static is used rather than a hand-rolled handler for one reason
   * that matters here: it answers Range requests. Without byte ranges a phone
   * cannot seek or resume a 5MB video - some browsers will not even start
   * playback, because they ask for the last few bytes first to read the moov
   * atom, and a server that ignores Range hands them the whole file instead.
   *
   * ETag and Last-Modified stay on (the defaults), so replacing an mp4 in
   * src/media is picked up on the next revalidation rather than being cached
   * for a day on somebody's phone.
   */
  api.use(
    '/public/media',
    express.static(mediaDir, {
      maxAge: '1h',
      index: false,
      dotfiles: 'deny',
      // Falls through to the app's own 404 rather than handing express.static
      // the last word. With fallthrough:false a missing file is pushed into
      // the error handler and comes back as a 500, which would say the server
      // is broken when the truth is only that a video was renamed.
      fallthrough: true,
    }),
  );

  /**
   * The brand images.
   *
   * Cached hard: a favicon is requested on every page load and these files
   * change roughly never. A year is safe because replacing a logo means
   * replacing the file, and ETag still forces a revalidation when it does.
   */
  api.use(
    '/public/images',
    express.static(imagesDir, { maxAge: '365d', index: false, dotfiles: 'deny', fallthrough: true }),
  );

  api.use(publicRoutes());
  api.use(formsRoutes());

  api.use(boardRoutes());
  api.use(webhookRoutes());

  app.use(config.apiBasePath, api);

  // Uptime checks and load balancers expect a root health endpoint, so keep
  // one there too when a prefix is configured.
  if (config.apiBasePath) {
    app.get('/healthz', (req, res, next) => {
      req.url = '/healthz';
      api(req, res, next);
    });
  }

  app.use((req, res) => {
    log.warn('404', { method: req.method, path: req.originalUrl });
    res.status(404).json({ error: 'not found' });
  });

  // Anything that escapes a route handler lands here rather than killing the
  // process mid-game.
  app.use((err, _req, res, _next) => {
    log.error('unhandled request error', { message: err.message, stack: err.stack });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
