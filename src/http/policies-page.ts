import { env } from '../config/env.js';
import type { LegalDocument } from '../services/consent.service.js';
import { whatsappReturnUrl } from './board-token.js';

/**
 * All policies on one web page.
 *
 * Five documents is far too much to read inside chat bubbles, and WhatsApp
 * offers no way to scroll back to a specific clause. A page gives players a
 * table of contents, real typography, and something they can revisit or share.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Converts WhatsApp's markup to HTML.
 *
 * Documents are authored once and shown in both places, so the same stored text
 * has to render in chat and on the web. Escaping happens first, so a document
 * edited in the admin panel can never inject markup.
 */
function toHtml(body: string): string {
  const escaped = escapeHtml(body);

  return escaped
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');

      // A run of bullet lines becomes a list rather than a paragraph.
      if (lines.every((l) => l.trim().startsWith('•'))) {
        const items = lines
          .map((l) => `<li>${inline(l.replace(/^\s*•\s*/, ''))}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

function inline(text: string): string {
  return text
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
}

export function renderPoliciesPage(docs: LegalDocument[]): string {
  const toc = docs
    .map((d) => `<a href="#${escapeHtml(d.doc_key)}">${escapeHtml(d.title)}</a>`)
    .join('');

  const sections = docs
    .map(
      (d) => `<section id="${escapeHtml(d.doc_key)}">
        <h2>${escapeHtml(d.title)}</h2>
        <p class="sub">${escapeHtml(d.summary)} · version ${d.version}</p>
        ${toHtml(d.body)}
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(env.BRAND_NAME)} — Policies &amp; Terms</title>
<style>
  :root { --maroon:#7d0f22; --ink:#1e2733; --muted:#6b7684; --line:#e2e7ee; --bg:#f6f3ef; --card:#fff; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--ink); line-height: 1.6; font-size: 16px;
    max-width: 720px; margin: 0 auto; padding: 0 16px 40px;
  }
  header { background: linear-gradient(135deg, var(--maroon), #5c0a19); color:#fff;
           margin: 0 -16px 18px; padding: 26px 20px 22px; }
  header h1 { margin:0; font-size: 23px; letter-spacing:.3px; }
  header p { margin:6px 0 0; opacity:.9; font-size: 14px; }
  nav { display:flex; flex-wrap:wrap; gap:8px; margin-bottom: 18px; }
  nav a { background:#fff; border:1px solid var(--line); border-radius:999px;
          padding:8px 14px; font-size:14px; font-weight:600; color:var(--maroon); text-decoration:none; }
  section { background: var(--card); border-radius:14px; padding:18px 18px 6px; margin-bottom:14px;
            box-shadow: 0 1px 3px rgba(20,25,35,.07); scroll-margin-top: 12px; }
  section h2 { margin:0 0 2px; font-size:19px; color: var(--maroon); }
  .sub { margin:0 0 12px; color: var(--muted); font-size:13px; }
  section p { margin: 0 0 12px; }
  section ul { margin: 0 0 12px; padding-left: 20px; }
  section li { margin-bottom: 6px; }
  strong { font-weight: 700; }
  .cta { display:block; text-align:center; margin-top:18px; padding:15px; border-radius:12px;
         background:#1f9d55; color:#fff; text-decoration:none; font-weight:700; }
  footer { text-align:center; color:var(--muted); font-size:12px; margin-top:16px; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(env.BRAND_NAME)} — Policies &amp; Terms</h1>
  <p>Please read these before you play. Operated by ServerPe App Solutions.</p>
</header>
<nav>${toc}</nav>
${sections}
<a class="cta" href="${whatsappReturnUrl()}">Back to WhatsApp to accept</a>
<footer>Questions? admin@serverpe.in</footer>
</body>
</html>`;
}
