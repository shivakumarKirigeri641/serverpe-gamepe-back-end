/**
 * The look of every email this platform sends.
 *
 * ── Why this is written the way it is ───────────────────────────────────────
 *
 * Email is not the web. Gmail strips <style> blocks in some contexts, Outlook
 * renders through Word's HTML engine, and none of them agree on flexbox, grid,
 * or even margin. So everything here obeys four rules that look dated on
 * purpose:
 *
 *   1. Tables for layout. Not divs.
 *   2. Every style inline, on the element it affects.
 *   3. No external stylesheet, no web font, no image. A logo hosted anywhere
 *      is a blocked image and a tracking-pixel warning in half of all inboxes;
 *      the wordmark here is text, so it always renders.
 *   4. One column, 600px wide, which is what every client is built around.
 *
 * The palette is the panel's Midnight Maroon, but LIGHT. An operator reads
 * these on a phone at 8am next to ordinary email; a black card in that list
 * looks like a phishing attempt. The maroon and gold carry the brand in the
 * header and the accents instead.
 *
 * Dark-mode clients invert light backgrounds automatically. Since the values
 * here are real hex on real table cells (never a transparent element hoping to
 * inherit), that inversion produces a readable dark card rather than black
 * text on a black ground.
 */

const C = {
  brand: '#b3122b',
  brandDeep: '#7d0c1e',
  gold: '#c98a12',
  ink: '#1c1a22',
  body: '#3f3b4a',
  muted: '#7b7589',
  faint: '#a8a2b5',
  line: '#e6e2ec',
  wash: '#faf8fb',
  page: '#f2eff5',
  good: '#0f9d63',
  bad: '#d13c4b',
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** Anything interpolated into HTML goes through this. No exceptions. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─────────────────────────────────────────────────────── building blocks ── */

/** A section heading: small, spaced capitals with a hairline under it. */
export function heading(text) {
  return `
    <tr><td style="padding:26px 28px 8px;">
      <div style="font:700 11px/1.4 ${FONT};letter-spacing:.10em;text-transform:uppercase;color:${C.muted};">${esc(text)}</div>
      <div style="height:1px;background:${C.line};margin-top:8px;"></div>
    </td></tr>`;
}

/** Ordinary prose. */
export function paragraph(text, { small = false } = {}) {
  const size = small ? '12px' : '14px';
  const colour = small ? C.muted : C.body;
  return `
    <tr><td style="padding:6px 28px 10px;">
      <p style="margin:0;font:400 ${size}/1.65 ${FONT};color:${colour};">${esc(text)}</p>
    </td></tr>`;
}

/**
 * A label/value list — the workhorse of the alert emails.
 *
 * Right-aligned values give the column of numbers a spine to read down, which
 * is the whole point of not just writing prose.
 */
export function facts(rows) {
  if (!rows.length) return '';
  const body = rows
    .map(({ label, value, hint, tone }, i) => {
      const colour = tone === 'good' ? C.good : tone === 'bad' ? C.bad : C.ink;
      // The label never wraps and the value always may. The other way round —
      // which is what a plain two-column table does — turns "Played from" into
      // two lines the moment its value is a list of cities.
      const rule = i ? `1px solid ${C.line}` : 'none';
      return `
      <tr>
        <td valign="top" style="padding:9px 14px 9px 0;border-top:${rule};font:400 13px/1.45 ${FONT};color:${C.muted};white-space:nowrap;">
          ${esc(label)}
        </td>
        <td align="right" valign="top" style="padding:9px 0;border-top:${rule};font:700 13px/1.45 ${FONT};color:${colour};">
          ${esc(value)}${hint ? `<span style="font-weight:400;color:${C.faint};"> ${esc(hint)}</span>` : ''}
        </td>
      </tr>`;
    })
    .join('');

  return `
    <tr><td style="padding:2px 28px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
    </td></tr>`;
}

/**
 * The number cards at the top of the daily summary.
 *
 * Two per row rather than four: at 600px minus padding, four columns leaves
 * about 130px each, which wraps "Players seated in a game" into four lines on
 * a phone. Two is the width that survives.
 */
export function statCards(cards) {
  if (!cards.length) return '';
  const cell = (c) => {
    if (!c) return `<td width="50%" style="padding:5px;"></td>`;
    const tone = c.direction === 'up' ? C.good : c.direction === 'down' ? C.bad : C.muted;
    return `
      <td width="50%" valign="top" style="padding:5px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:${C.wash};border:1px solid ${C.line};border-radius:10px;">
          <tr><td style="padding:13px 15px;">
            <div style="font:700 10px/1.3 ${FONT};letter-spacing:.09em;text-transform:uppercase;color:${C.muted};">${esc(c.label)}</div>
            <div style="font:800 26px/1.15 ${FONT};color:${C.ink};padding-top:5px;">${esc(c.value)}</div>
            ${c.change ? `<div style="font:600 12px/1.4 ${FONT};color:${tone};padding-top:3px;">${esc(c.change)}</div>` : ''}
          </td></tr>
        </table>
      </td>`;
  };

  let rows = '';
  for (let i = 0; i < cards.length; i += 2) {
    rows += `<tr>${cell(cards[i])}${cell(cards[i + 1])}</tr>`;
  }
  return `
    <tr><td style="padding:4px 23px 10px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr>`;
}

/**
 * A horizontal bar list, for the geography breakdown.
 *
 * The bar is a table cell with a background colour and a percentage width -
 * the only bar chart every email client on earth agrees to render. No images,
 * no divs with transforms.
 */
export function bars(rows, { max } = {}) {
  if (!rows.length) return '';
  const peak = max ?? Math.max(...rows.map((r) => Number(r.value) || 0), 1);

  const body = rows
    .map((r, i) => {
      const pct = Math.max(2, Math.round(((Number(r.value) || 0) / peak) * 100));
      const tone = r.direction === 'up' ? C.good : r.direction === 'down' ? C.bad : C.faint;
      const fill = i === 0 ? C.brand : i === 1 ? C.gold : '#8d7fa8';
      return `
      <tr><td style="padding:7px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font:600 13px/1.4 ${FONT};color:${C.ink};">${esc(r.label)}</td>
            <td align="right" style="font:700 13px/1.4 ${FONT};color:${C.ink};white-space:nowrap;">
              ${esc(r.value)}
              ${r.share != null ? `<span style="font-weight:400;color:${C.faint};"> ${esc(r.share)}%</span>` : ''}
              ${r.change ? `<span style="font-weight:600;color:${tone};"> ${esc(r.change)}</span>` : ''}
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:5px;">
          <tr>
            <td width="${pct}%" style="height:6px;background:${fill};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
            <td style="height:6px;background:${C.line};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td></tr>`;
    })
    .join('');

  return `
    <tr><td style="padding:2px 28px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
    </td></tr>`;
}

/**
 * A callout box. `tone` decides whether it reads as information or a problem.
 *
 * The left border is what carries the meaning, because a coloured background
 * alone disappears under aggressive dark-mode inversion.
 */
export function callout(lines, { tone = 'info', title } = {}) {
  const list = [].concat(lines).filter(Boolean);
  if (!list.length) return '';
  const accent = tone === 'bad' ? C.bad : tone === 'good' ? C.good : C.gold;
  const wash = tone === 'bad' ? '#fdf3f4' : tone === 'good' ? '#f1faf6' : '#fdf8ee';

  return `
    <tr><td style="padding:4px 28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${wash};border-radius:10px;border-left:3px solid ${accent};">
        <tr><td style="padding:13px 16px;">
          ${title ? `<div style="font:700 12px/1.4 ${FONT};color:${C.ink};padding-bottom:5px;">${esc(title)}</div>` : ''}
          ${list
            .map(
              (l) =>
                `<div style="font:400 13px/1.6 ${FONT};color:${C.body};padding:1px 0;">${esc(l)}</div>`,
            )
            .join('')}
        </td></tr>
      </table>
    </td></tr>`;
}

/** Verbatim text — a player's own words, or a support message. */
export function quote(text) {
  return `
    <tr><td style="padding:2px 28px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${C.wash};border:1px solid ${C.line};border-radius:10px;">
        <tr><td style="padding:14px 16px;font:400 13px/1.65 ${FONT};color:${C.body};white-space:pre-wrap;">${esc(text)}</td></tr>
      </table>
    </td></tr>`;
}

/** A monospaced strip — IP addresses, room codes, references. */
export function mono(label, value) {
  return `
    <tr><td style="padding:2px 28px 12px;">
      <div style="font:400 11px/1.4 ${FONT};color:${C.muted};padding-bottom:4px;">${esc(label)}</div>
      <div style="font:500 12px/1.5 ${MONO};color:${C.ink};background:${C.wash};border:1px solid ${C.line};border-radius:8px;padding:9px 12px;">${esc(value)}</div>
    </td></tr>`;
}

/** The one button an email is allowed. Bulletproof: a padded table cell. */
export function button(label, url) {
  if (!url) return '';
  return `
    <tr><td style="padding:6px 28px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:${C.brand};border-radius:8px;">
          <a href="${esc(url)}" style="display:inline-block;padding:11px 22px;font:700 13px/1 ${FONT};color:#ffffff;text-decoration:none;">${esc(label)} &rsaquo;</a>
        </td></tr>
      </table>
    </td></tr>`;
}

export function divider() {
  return `<tr><td style="padding:2px 28px;"><div style="height:1px;background:${C.line};"></div></td></tr>`;
}

export function spacer(px = 8) {
  return `<tr><td style="height:${px}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
}

/* ───────────────────────────────────────────────────────────── the shell ── */

/**
 * Wraps blocks in the branded card.
 *
 * @param {object} o
 * @param {string} o.brand      product name, shown as the wordmark
 * @param {string} o.company    legal name, shown in the footer
 * @param {string} o.eyebrow    what kind of email this is
 * @param {string} o.title      the headline
 * @param {string} [o.subtitle] one line under it
 * @param {string} [o.icon]     the same emoji the subject line carries
 * @param {string} [o.preheader] the grey text inbox lists show after the
 *        subject. Left out, clients scrape the first words of the body and
 *        show something like "View in browser" — so it is always set.
 * @param {string} o.blocks     the rendered rows
 * @param {string[]} [o.footNotes]
 */
export function shell({
  brand,
  company,
  eyebrow,
  title,
  subtitle,
  icon = '',
  preheader,
  blocks,
  footNotes = [],
}) {
  const hidden = preheader ?? `${title}${subtitle ? ` — ${subtitle}` : ''}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-font-smoothing:antialiased;">

<!-- Inbox preview text, then enough zero-width space to stop the client
     spilling the body's first words in after it. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
  ${esc(hidden)}${'&#847;&zwnj;&nbsp;'.repeat(60)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:26px 12px 34px;">

    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(28,26,34,.09);">

      <!-- header -->
      <tr>
        <td style="background:${C.brandDeep};background-image:linear-gradient(135deg,${C.brand} 0%,${C.brandDeep} 100%);padding:22px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font:800 17px/1.2 ${FONT};color:#ffffff;letter-spacing:-.2px;">
                ${icon ? `${icon} ` : ''}${esc(brand)}
              </td>
              <td align="right" style="font:700 10px/1.2 ${FONT};letter-spacing:.11em;text-transform:uppercase;color:#f3c76a;">
                ${esc(eyebrow)}
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- title -->
      <tr>
        <td style="padding:24px 28px 4px;">
          <h1 style="margin:0;font:800 21px/1.3 ${FONT};color:${C.ink};letter-spacing:-.3px;">${esc(title)}</h1>
          ${subtitle ? `<p style="margin:7px 0 0;font:400 13px/1.55 ${FONT};color:${C.muted};">${esc(subtitle)}</p>` : ''}
        </td>
      </tr>

      ${blocks}

      <!-- footer -->
      <tr>
        <td style="background:${C.wash};border-top:1px solid ${C.line};padding:18px 28px 22px;">
          ${footNotes
            .map(
              (n) =>
                `<p style="margin:0 0 6px;font:400 11px/1.6 ${FONT};color:${C.faint};">${esc(n)}</p>`,
            )
            .join('')}
          <p style="margin:8px 0 0;font:700 12px/1.5 ${FONT};color:${C.muted};">${esc(company)}</p>
          <p style="margin:2px 0 0;font:400 11px/1.5 ${FONT};color:${C.faint};">
            An automatic operator alert — you are receiving it because you run ${esc(brand)}.
            Every alert can be switched to a daily batch, or off, in the admin panel.
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export const palette = C;
