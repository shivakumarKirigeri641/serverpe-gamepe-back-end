import { apiPath, env } from '../config/env.js';
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

export type PolicyLang = 'en' | 'hi';

/**
 * Page furniture in both languages.
 *
 * The email address, the brand and the company name stay in Latin script in
 * both: they are strings a reader has to recognise or type exactly, and
 * transliterating them would make them wrong.
 */
const UI = {
  en: {
    htmlLang: 'en',
    title: 'Policies & Terms',
    intro: 'Please read these before you play. Operated by ServerPe App Solutions.',
    version: 'version',
    cta: 'Back to WhatsApp to accept',
    questions: 'Questions?',
    switch: 'हिंदी में पढ़ें',
    entertainment: 'For Entertainment Only · No betting · No money',
    legalNote: '',
  },
  hi: {
    htmlLang: 'hi',
    title: 'नीतियाँ और शर्तें',
    intro: 'खेलने से पहले कृपया इन्हें पढ़ें। संचालक: ServerPe App Solutions।',
    version: 'संस्करण',
    cta: 'स्वीकार करने के लिए WhatsApp पर लौटें',
    questions: 'प्रश्न?',
    switch: 'Read in English',
    entertainment: 'केवल मनोरंजन के लिए · कोई सट्टा नहीं · कोई पैसा नहीं',
    // Stated to the reader, not just in a migration comment: a translation is a
    // convenience, and if the two ever disagree the English is what binds.
    legalNote:
      'यह हिंदी अनुवाद आपकी सुविधा के लिए है। किसी भी अंतर की स्थिति में अंग्रेज़ी पाठ ही कानूनी रूप से मान्य होगा।',
  },
} as const;

export function renderPoliciesPage(docs: LegalDocument[], lang: PolicyLang = 'en'): string {
  const t = UI[lang];

  // Per field, not per document: a half-translated document shows its Hindi
  // title with an English clause rather than falling back wholesale.
  const pick = (hi: string | null, en: string): string => (lang === 'hi' && hi ? hi : en);

  const toc = docs
    .map(
      (d) =>
        `<a href="#${escapeHtml(d.doc_key)}">${escapeHtml(pick(d.title_hi, d.title))}</a>`,
    )
    .join('');

  const sections = docs
    .map((d) => {
      const untranslated = lang === 'hi' && !d.body_hi;
      return `<section id="${escapeHtml(d.doc_key)}">
        <h2>${escapeHtml(pick(d.title_hi, d.title))}</h2>
        <p class="sub">${escapeHtml(pick(d.summary_hi, d.summary))} · ${t.version} ${d.version}</p>
        ${untranslated ? '<p class="note">इस दस्तावेज़ का हिंदी अनुवाद अभी उपलब्ध नहीं है। नीचे अंग्रेज़ी पाठ है।</p>' : ''}
        ${toHtml(pick(d.body_hi, d.body))}
      </section>`;
    })
    .join('');

  const other = lang === 'hi' ? 'en' : 'hi';

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" type="image/png" sizes="32x32" href="${apiPath('/public/brand/images/favicon-32.png')}">
<link rel="apple-touch-icon" sizes="180x180" href="${apiPath('/public/brand/images/apple-touch-icon-180.png')}">
<meta name="theme-color" content="#7d0f22">
<title>${escapeHtml(env.BRAND_NAME)} — ${t.title}</title>
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
  .lang { display:inline-block; margin-top:12px; background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.35);
          color:#fff; border-radius:999px; padding:7px 16px; font-size:14px; font-weight:700; text-decoration:none; }
  .ent { display:block; margin:0 0 14px; text-align:center; color:#b3122b; background:#fff2f2;
         border:1px solid #f3c9cf; border-radius:10px; padding:9px; font-size:13px; font-weight:700; }
  .note { background:#fff8e6; border:1px solid #f0d9a0; color:#7a5b00; border-radius:8px;
          padding:9px 11px; font-size:13.5px; margin:0 0 12px; }
  /* Devanagari sits taller than Latin; a little more line height keeps the
     matras from crowding the line above. */
  html[lang="hi"] body { line-height: 1.75; }
  html[lang="hi"] section h2 { line-height: 1.4; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(env.BRAND_NAME)} — ${t.title}</h1>
  <p>${t.intro}</p>
  <a class="lang" href="?lang=${other}" hreflang="${other}">${UI[lang].switch}</a>
</header>
<p class="ent">${t.entertainment}</p>
${t.legalNote ? `<p class="note">${t.legalNote}</p>` : ''}
<nav>${toc}</nav>
${sections}
<a class="cta" href="${whatsappReturnUrl()}">${t.cta}</a>
<footer>${t.questions} support@mastipe.in</footer>
</body>
</html>`;
}
