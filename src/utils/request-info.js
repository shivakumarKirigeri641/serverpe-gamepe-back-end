/**
 * What we can tell about a request: who, from where, on what.
 *
 * The user-agent parsing is deliberately hand-rolled rather than pulled from a
 * dependency. We need six coarse facts, not a 200-family device database, and
 * the one fact that matters most here - "is this WhatsApp's in-app browser?" -
 * is a single substring test that no UA library highlights for you.
 *
 * Pure module: give it headers, get facts. No database, no side effects.
 */
import { isIP } from 'node:net';

/**
 * The client's real address.
 *
 * Behind ngrok, a load balancer or Nginx, req.socket.remoteAddress is the
 * proxy, not the player. Express only trusts X-Forwarded-For when
 * `trust proxy` is set, which server.js does - so req.ip is already correct
 * and we just normalise it here.
 */
export function clientIp(req) {
  const raw =
    req.ip ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';

  // Express reports IPv4 clients as ::ffff:1.2.3.4 when the socket is IPv6.
  const cleaned = raw.replace(/^::ffff:/, '');
  return {
    raw: raw || null,
    // Only hand Postgres something inet will actually accept.
    inet: isIP(cleaned) ? cleaned : null,
  };
}

const DEVICE_TABLETS = /(ipad|tablet|playbook|silk|kindle)|(android(?!.*mobile))/i;
const DEVICE_PHONES = /(iphone|ipod|android.*mobile|windows phone|blackberry|bb10|opera mini|mobile)/i;
const BOTS = /(bot|crawler|spider|crawling|facebookexternalhit|preview|curl|wget|python-requests|okhttp)/i;

/**
 * Coarse facts about the client. Every field can be null - a UA header is a
 * claim by the client, not a fact, and treating it as optional keeps a weird
 * or absent header from breaking anything.
 */
export function parseUserAgent(ua) {
  const s = String(ua ?? '');
  if (!s) return blank();

  const out = blank();
  out.raw = s.slice(0, 512);

  // --- the one that actually matters for this product ---
  // Links tapped in WhatsApp open in an embedded WebView, which suspends
  // background tabs and can silently drop a live SSE connection. Knowing which
  // sessions were in-app is the difference between "our code is broken" and
  // "that player minimised WhatsApp".
  out.isInAppBrowser = /\bWhatsApp\b/i.test(s) || /\b(FBAN|FBAV|Instagram|Line|WebView)\b/i.test(s);
  out.inAppHost = /\bWhatsApp\b/i.test(s) ? 'whatsapp'
    : /\b(FBAN|FBAV)\b/.test(s) ? 'facebook'
    : /\bInstagram\b/i.test(s) ? 'instagram'
    : null;

  if (BOTS.test(s)) out.deviceType = 'bot';
  else if (DEVICE_TABLETS.test(s)) out.deviceType = 'tablet';
  else if (DEVICE_PHONES.test(s)) out.deviceType = 'phone';
  else out.deviceType = 'desktop';

  // --- operating system ---
  let m;
  if ((m = s.match(/Android[ /]([\d.]+)/i))) { out.os = 'Android'; out.osVersion = m[1]; }
  else if ((m = s.match(/(?:iPhone )?OS ([\d_]+) like Mac OS X/i))) { out.os = 'iOS'; out.osVersion = m[1].replace(/_/g, '.'); }
  else if ((m = s.match(/Windows NT ([\d.]+)/i))) { out.os = 'Windows'; out.osVersion = windowsName(m[1]); }
  else if ((m = s.match(/Mac OS X ([\d_.]+)/i))) { out.os = 'macOS'; out.osVersion = m[1].replace(/_/g, '.'); }
  else if (/CrOS/i.test(s)) out.os = 'ChromeOS';
  else if (/Linux/i.test(s)) out.os = 'Linux';

  // --- browser. Order matters: Chrome's UA also contains "Safari", Edge's
  // contains both, and so on. Most specific first.
  if ((m = s.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i))) { out.browser = 'Edge'; out.browserVersion = m[1]; }
  else if ((m = s.match(/OPR\/([\d.]+)/i))) { out.browser = 'Opera'; out.browserVersion = m[1]; }
  else if ((m = s.match(/SamsungBrowser\/([\d.]+)/i))) { out.browser = 'Samsung Internet'; out.browserVersion = m[1]; }
  else if ((m = s.match(/Firefox\/([\d.]+)/i))) { out.browser = 'Firefox'; out.browserVersion = m[1]; }
  else if ((m = s.match(/Chrome\/([\d.]+)/i))) { out.browser = 'Chrome'; out.browserVersion = m[1]; }
  else if ((m = s.match(/Version\/([\d.]+).*Safari/i))) { out.browser = 'Safari'; out.browserVersion = m[1]; }
  else if (/Safari/i.test(s)) out.browser = 'Safari';

  return out;
}

function windowsName(nt) {
  return { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }[nt] ?? nt;
}

function blank() {
  return {
    raw: null, deviceType: null, os: null, osVersion: null,
    browser: null, browserVersion: null, isInAppBrowser: false, inAppHost: null,
  };
}

/** Everything about one request, ready to store. */
export function requestInfo(req) {
  const ip = clientIp(req);
  const ua = parseUserAgent(req.get?.('user-agent'));
  return {
    ip: ip.inet,
    ipRaw: ip.raw,
    userAgent: ua.raw,
    deviceType: ua.deviceType,
    os: ua.os,
    osVersion: ua.osVersion,
    browser: ua.browser,
    browserVersion: ua.browserVersion,
    isInAppBrowser: ua.isInAppBrowser,
    inAppHost: ua.inAppHost,
    referer: (req.get?.('referer') || '').slice(0, 512) || null,
    language: (req.get?.('accept-language') || '').slice(0, 64) || null,
  };
}

/** A short human label for logs and the admin view: "Chrome 120 / Android 13". */
export function describeClient(info) {
  const browser = [info.browser, info.browserVersion?.split('.')[0]].filter(Boolean).join(' ');
  const os = [info.os, info.osVersion].filter(Boolean).join(' ');
  const parts = [browser || 'unknown browser', os || 'unknown os'];
  if (info.isInAppBrowser) parts.push(`in-app: ${info.inAppHost ?? 'yes'}`);
  return parts.join(' / ');
}
