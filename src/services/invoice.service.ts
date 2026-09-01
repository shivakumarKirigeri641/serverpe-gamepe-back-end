import PDFDocument from 'pdfkit';
import { query, queryOne } from '../db/pool.js';
import { env } from '../config/env.js';
import { appTimeString } from '../utils/time.js';
import { storeDocument } from './document.service.js';
import { drawFooter, fontForText, useFonts } from './report-fonts.js';
import { logger } from '../utils/logger.js';

/**
 * The GST invoice for a payment.
 *
 * A tax invoice is not a receipt with nicer wording — it has required contents,
 * and an invoice missing them is one the customer cannot claim against and we
 * cannot defend at a filing. So this carries: a unique sequential number, the
 * date, both parties, the supplier's GSTIN, the place of supply, the HSN/SAC
 * code, the taxable value, the rate, the tax split into the right heads, and
 * the total in words.
 *
 * Everything is read from the payment row rather than recomputed. The split was
 * decided when the money moved; a rate change or a re-registration next year
 * must not silently rewrite an invoice that has already been issued.
 */

const COLOR = {
  maroon: '#7d0f22',
  ink: '#1e2733',
  muted: '#6b7684',
  line: '#dfe4ea',
  panel: '#f6f3ef',
};

/**
 * Online gaming services. 998439 is "other online contents" under SAC, which is
 * where an entertainment-only game of housie sits — it is not gambling (SAC
 * 999692), and using the gambling code would misdescribe the product on every
 * invoice we issue.
 */
const SAC_CODE = '998439';
const SAC_LABEL = 'Online games / digital entertainment service';

interface InvoiceRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  wa_id: string;
  plan_key: string | null;
  amount_paise: number;
  base_paise: number;
  gst_paise: number;
  gst_percent: string;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  place_of_supply: string | null;
  place_of_supply_code: string | null;
  supplier_state: string | null;
  paid_at: Date | null;
  method: string | null;
  player_id: string | null;
  display_name: string | null;
  plan_name: string | null;
}

const ONES = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function underThousand(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? '-' + ONES[n % 10] : ''}`;
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ' and ' + underThousand(n % 100) : ''}`;
}

/**
 * Amount in words, in the Indian system.
 *
 * Lakh and crore rather than million and billion, because that is what an
 * Indian invoice is read against. Required in practice on a tax invoice and a
 * common audit query when absent.
 */
function inWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const paisePart = paise % 100;

  if (rupees === 0 && paisePart === 0) return 'Zero rupees only';

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const rest = rupees % 1_000;

  if (crore) parts.push(`${underThousand(crore)} crore`);
  if (lakh) parts.push(`${underThousand(lakh)} lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} thousand`);
  if (rest) parts.push(underThousand(rest));

  const rupeeWords = parts.join(' ').trim();
  const head = rupeeWords ? `${rupeeWords} rupees` : '';
  const tail = paisePart ? `${head ? ' and ' : ''}${underThousand(paisePart)} paise` : '';

  const all = `${head}${tail}`.trim();
  return all.charAt(0).toUpperCase() + all.slice(1) + ' only';
}

const rs = (paise: number): string => `Rs ${(paise / 100).toFixed(2)}`;

/**
 * Builds and files the invoice for a paid payment.
 *
 * Returns null rather than throwing when the payment is not payable: an invoice
 * is a consequence of money moving, and a missing one must never be able to
 * break the flow that took the money.
 */
export async function buildInvoice(paymentId: string): Promise<{
  buffer: Buffer;
  filename: string;
  docNumber: string;
} | null> {
  const p = await queryOne<InvoiceRow>(
    `SELECT pay.id, pay.order_id, pay.payment_id, pay.wa_id, pay.plan_key,
            pay.amount_paise, pay.base_paise, pay.gst_paise, pay.gst_percent,
            pay.cgst_paise, pay.sgst_paise, pay.igst_paise,
            pay.place_of_supply, pay.place_of_supply_code, pay.supplier_state,
            pay.paid_at, pay.method, pay.player_id,
            pl.display_name,
            (SELECT name FROM plans WHERE plan_key = pay.plan_key) AS plan_name
       FROM payments pay
       LEFT JOIN players pl ON pl.id = pay.player_id
      WHERE pay.id = $1 AND pay.status = 'paid'`,
    [paymentId],
  );
  if (!p) return null;

  const biz = await queryOne<Record<string, string | null>>(
    `SELECT legal_name, trade_name, gstin, address_line1, address_line2, city, state,
            postal_code, country, support_email
       FROM business_profile LIMIT 1`,
  );

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `${env.BRAND_NAME} tax invoice` },
  });
  const F = useFonts(doc, 'latin');

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  /* -------------------------------------------------------------- header */
  doc.rect(0, 0, 595, 88).fill(COLOR.maroon);
  doc.fillColor('#ffffff').fontSize(21).font(F.bold).text(env.BRAND_NAME, 40, 22);
  doc.fontSize(11).font(F.regular).text('Tax Invoice', 40, 50);
  doc.fontSize(9).text(String(biz?.['legal_name'] ?? 'ServerPe App Solutions'), 40, 66);

  let y = 104;

  /* ------------------------------------------------- supplier / customer */
  const col = (x: number, w: number, title: string, lines: string[]): void => {
    doc.fillColor(COLOR.muted).fontSize(8).font(F.bold).text(title.toUpperCase(), x, y);
    let ly = y + 13;
    for (const line of lines) {
      if (!line) continue;
      doc.fillColor(COLOR.ink).fontSize(9.5).font(fontForText(line, F)).text(line, x, ly, { width: w });
      ly = doc.y + 1;
    }
  };

  const supplierLines = [
    String(biz?.['legal_name'] ?? 'ServerPe App Solutions'),
    String(biz?.['address_line1'] ?? ''),
    String(biz?.['address_line2'] ?? ''),
    `${biz?.['city'] ?? ''} ${biz?.['postal_code'] ?? ''}`.trim(),
    `${biz?.['state'] ?? ''}, ${biz?.['country'] ?? 'India'}`,
    biz?.['gstin'] ? `GSTIN: ${biz['gstin']}` : '',
    biz?.['support_email'] ? String(biz['support_email']) : '',
  ];

  // The customer is named, never numbered. A phone number on a document that
  // can be forwarded is the one privacy leak this product must not have.
  const customerLines = [
    p.display_name?.trim() || 'MastiPe player',
    `WhatsApp: +${p.wa_id.slice(0, 2)} ***** ${p.wa_id.slice(-4)}`,
    p.place_of_supply ? `State: ${p.place_of_supply}` : 'State: not stated',
    p.place_of_supply_code ? `State code: ${p.place_of_supply_code}` : '',
    'Unregistered (B2C)',
  ];

  col(40, 250, 'Supplied by', supplierLines);
  col(310, 245, 'Billed to', customerLines);

  y = 210;

  /* ---------------------------------------------------- invoice metadata */
  doc.roundedRect(40, y, 515, 46, 8).fill(COLOR.panel);
  const meta: [string, string][] = [
    ['Invoice date', p.paid_at ? appTimeString(new Date(p.paid_at)) : appTimeString()],
    ['Payment ref', p.payment_id ?? p.order_id],
    ['Place of supply', p.place_of_supply ?? 'Not stated'],
    ['Method', p.method ?? 'online'],
  ];
  meta.forEach(([k, v], i) => {
    const x = 52 + i * 128;
    doc.fillColor(COLOR.muted).fontSize(7.5).font(F.bold).text(k.toUpperCase(), x, y + 9, { width: 120 });
    doc.fillColor(COLOR.ink).fontSize(9).font(F.regular).text(v, x, y + 22, { width: 120 });
  });
  y += 62;

  /* ---------------------------------------------------------- line items */
  doc.fillColor(COLOR.ink).fontSize(8).font(F.bold);
  doc.text('DESCRIPTION', 40, y).text('SAC', 300, y).text('TAXABLE', 370, y, { width: 80, align: 'right' })
    .text('AMOUNT', 465, y, { width: 90, align: 'right' });
  y += 13;
  doc.moveTo(40, y).lineTo(555, y).strokeColor(COLOR.line).stroke();
  y += 9;

  doc.fillColor(COLOR.ink).fontSize(10).font(F.regular)
    .text(p.plan_name ?? p.plan_key ?? 'MastiPe game', 40, y, { width: 250 });
  doc.fontSize(8.5).fillColor(COLOR.muted).text(SAC_LABEL, 40, doc.y + 1, { width: 250 });
  doc.fontSize(10).fillColor(COLOR.ink)
    .text(SAC_CODE, 300, y)
    .text(rs(p.base_paise), 370, y, { width: 80, align: 'right' })
    .text(rs(p.base_paise), 465, y, { width: 90, align: 'right' });

  y = Math.max(doc.y, y + 26) + 10;
  doc.moveTo(40, y).lineTo(555, y).strokeColor(COLOR.line).stroke();
  y += 10;

  /* ------------------------------------------------------------- totals */
  const rate = Number(p.gst_percent);
  const rows: [string, number][] = [['Taxable value', p.base_paise]];

  // Only the heads that actually apply. An invoice listing CGST, SGST and IGST
  // with two of them at zero invites the question of which one was meant.
  if (p.igst_paise > 0) {
    rows.push([`IGST @ ${rate}%`, p.igst_paise]);
  } else {
    rows.push([`CGST @ ${(rate / 2).toFixed(1)}%`, p.cgst_paise]);
    rows.push([`SGST @ ${(rate / 2).toFixed(1)}%`, p.sgst_paise]);
  }

  for (const [label, value] of rows) {
    doc.fillColor(COLOR.muted).fontSize(10).font(F.regular).text(label, 330, y, { width: 130, align: 'right' });
    doc.fillColor(COLOR.ink).font(F.regular).text(rs(value), 465, y, { width: 90, align: 'right' });
    y += 16;
  }

  doc.moveTo(330, y + 2).lineTo(555, y + 2).strokeColor(COLOR.line).stroke();
  y += 10;
  doc.fillColor(COLOR.ink).fontSize(12).font(F.bold).text('Total', 330, y, { width: 130, align: 'right' });
  doc.text(rs(p.amount_paise), 465, y, { width: 90, align: 'right' });
  y += 26;

  doc.fillColor(COLOR.muted).fontSize(9).font(F.regular)
    .text(`Amount in words: ${inWords(p.amount_paise)}`, 40, y, { width: 515 });
  y = doc.y + 18;

  /* --------------------------------------------------------------- notes */
  doc.fillColor(COLOR.ink).fontSize(9).font(F.bold).text('Notes', 40, y);
  y += 14;
  const notes = [
    'This is a computer-generated invoice and does not require a signature.',
    `${env.BRAND_NAME} is played for entertainment only. There is no betting, no wagering and no money to be won.`,
    'Credits are prepaid balance for use within MastiPe. They have no cash value and cannot be withdrawn.',
    `Questions about this invoice: ${biz?.['support_email'] ?? env.SUPPORT_EMAIL}`,
  ];
  doc.fontSize(8.5).font(F.regular).fillColor(COLOR.muted);
  for (const note of notes) {
    doc.text(`•  ${note}`, 40, y, { width: 515 });
    y = doc.y + 3;
  }

  drawFooter(
    doc,
    `${biz?.['legal_name'] ?? 'ServerPe App Solutions'} · ${biz?.['city'] ?? ''} · ${biz?.['gstin'] ?? ''}`,
    F.regular,
    COLOR.muted,
  );

  doc.end();
  await done;

  const buffer = Buffer.concat(chunks);

  const stored = await storeDocument({
    kind: 'invoice',
    buffer,
    playerId: p.player_id,
    waId: p.wa_id,
    title: 'Tax invoice',
    // One invoice per payment. Regenerating rewrites it rather than issuing a
    // second number for the same sale — duplicate invoice numbers for one
    // transaction is the kind of thing that turns a filing into a problem.
    dedupeKey: `invoice:${p.id}`,
    metadata: {
      orderId: p.order_id,
      paymentId: p.payment_id,
      amountPaise: p.amount_paise,
      basePaise: p.base_paise,
      cgstPaise: p.cgst_paise,
      sgstPaise: p.sgst_paise,
      igstPaise: p.igst_paise,
      placeOfSupply: p.place_of_supply,
      sac: SAC_CODE,
    },
  });

  logger.info({ paymentId, docNumber: stored.docNumber }, 'invoice issued');

  return { buffer, filename: stored.filename, docNumber: stored.docNumber };
}

/** Every invoice issued, for the admin panel and for a GST return. */
export async function listInvoices(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT d.doc_number, d.created_at, d.byte_size, d.metadata, d.id,
            p.wa_id, p.display_name
       FROM documents d LEFT JOIN players p ON p.id = d.player_id
      WHERE d.kind = 'invoice'
      ORDER BY d.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}
