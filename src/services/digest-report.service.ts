import PDFDocument from 'pdfkit';
import { env } from '../config/env.js';
import { appTimeString } from '../utils/time.js';
import { useFonts } from './report-fonts.js';
import type { DigestStats } from './notification.service.js';

/**
 * The digest as a PDF, attached to the alert email.
 *
 * The email body carries the same numbers, so this is not the only copy — it
 * exists because a PDF is what gets kept, forwarded and compared against last
 * week, and an emailed table is not.
 *
 * Deliberately not filed in the documents store: a digest is a snapshot of a
 * moment, regenerated every ten minutes, and keeping 144 of them a day would
 * bury the reports that actually matter.
 */

const COLOR = {
  maroon: '#7d0f22',
  ink: '#1e2733',
  muted: '#6b7684',
  line: '#dfe4ea',
  green: '#1f9d55',
  red: '#b3122b',
  panel: '#f6f3ef',
};

export interface DigestPdf {
  buffer: Buffer;
  filename: string;
}

export async function buildDigestPdf(
  stats: DigestStats,
  events: Array<{ trigger_key: string; summary: string; created_at: Date }>,
): Promise<DigestPdf> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `${env.BRAND_NAME} activity digest` },
  });
  const F = useFonts(doc, 'latin');

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  /* header */
  doc.rect(0, 0, 595, 82).fill(COLOR.maroon);
  doc.fillColor('#ffffff').fontSize(21).font(F.bold).text(env.BRAND_NAME, 40, 22);
  doc.fontSize(11).font(F.regular).text(`Activity digest — last ${stats.windowMinutes} minutes`, 40, 48);
  doc.fontSize(8).text(appTimeString(), 40, 64, { width: 515, align: 'right' });

  let y = 100;

  /* headline tiles */
  const tile = (x: number, w: number, label: string, value: string, accent = COLOR.maroon): void => {
    doc.roundedRect(x, y, w, 52, 8).fill(COLOR.panel);
    doc.fillColor(accent).fontSize(18).font(F.bold).text(value, x, y + 8, { width: w, align: 'center' });
    doc.fillColor(COLOR.muted).fontSize(8).font(F.regular).text(label, x, y + 32, { width: w, align: 'center' });
  };

  const w = (515 - 30) / 4;
  tile(40, w, 'New people', String(stats.players.new));
  tile(40 + w + 10, w, 'Games started', String(stats.games.started));
  tile(40 + 2 * (w + 10), w, 'Completed', String(stats.games.completed), COLOR.green);
  tile(
    40 + 3 * (w + 10),
    w,
    'Failed sends',
    String(stats.messages.failed),
    stats.messages.failed > 0 ? COLOR.red : COLOR.muted,
  );
  y += 70;

  const section = (title: string): void => {
    doc.fillColor(COLOR.ink).fontSize(12).font(F.bold).text(title, 40, y);
    doc.moveTo(40, y + 16).lineTo(555, y + 16).lineWidth(1).strokeColor(COLOR.line).stroke();
    y += 24;
  };

  const line = (label: string, value: string, note = ''): void => {
    if (y > 760) {
      doc.addPage();
      y = 50;
    }
    doc.fillColor(COLOR.muted).fontSize(10).font(F.regular).text(label, 40, y, { width: 260 });
    doc.fillColor(COLOR.ink).font(F.bold).text(value, 300, y, { width: 90, align: 'right' });
    if (note) doc.fillColor(COLOR.muted).font(F.regular).fontSize(9).text(note, 400, y + 1, { width: 155 });
    y += 16;
  };

  section('People');
  line('Total signups', String(stats.players.total));
  line('New in this window', String(stats.players.new));
  line('Active in this window', String(stats.players.active));

  section('Games');
  line('Created', String(stats.games.created));
  line('Started', String(stats.games.started));
  line('Completed', String(stats.games.completed));
  line('Cancelled', String(stats.games.cancelled));
  line('Never started', String(stats.games.abandoned), 'created, no first number called');
  line('Prizes won', String(stats.prizes));

  section('Messaging');
  line('Received', String(stats.messages.inbound));
  line('Sent', String(stats.messages.outbound));
  line('Failed', String(stats.messages.failed), stats.messages.failed > 0 ? 'worth investigating' : '');

  section('Support and moderation');
  line('Feedback', String(stats.feedback.count), stats.feedback.avgRating ? `avg ${stats.feedback.avgRating}/5` : '');
  line('Support tickets', String(stats.tickets));
  line('Numbers blocked', String(stats.blocked));

  section('Free trial');
  line('Signups', String(stats.trial.signups));
  line('Have played', String(stats.trial.played));
  line('Came back on 2+ days', String(stats.trial.returning), 'predicts renewals');
  line('Trial ends', stats.trial.endsOn, `${stats.trial.daysRemaining} days left`);

  /* the individual events */
  if (events.length > 0) {
    y += 8;
    section(`Events in this window (${events.length})`);

    const grouped = new Map<string, string[]>();
    for (const e of events) {
      const list = grouped.get(e.trigger_key) ?? [];
      list.push(e.summary);
      grouped.set(e.trigger_key, list);
    }

    for (const [key, items] of grouped) {
      if (y > 740) {
        doc.addPage();
        y = 50;
      }
      doc.fillColor(COLOR.maroon).fontSize(10).font(F.bold).text(`${key} (${items.length})`, 40, y);
      y += 15;

      for (const item of items.slice(0, 30)) {
        if (y > 770) {
          doc.addPage();
          y = 50;
        }
        doc.fillColor(COLOR.ink).fontSize(9).font(F.regular).text(`•  ${item}`, 48, y, { width: 500 });
        y = doc.y + 3;
      }
      if (items.length > 30) {
        doc.fillColor(COLOR.muted).fontSize(9).text(`   and ${items.length - 30} more`, 48, y);
        y += 14;
      }
      y += 6;
    }
  }

  doc
    .fontSize(8)
    .fillColor(COLOR.muted)
    .font(F.regular)
    .text(
      `${env.BRAND_NAME} by ServerPe App Solutions — operator digest, not for distribution. No player phone numbers appear in this report.`,
      40,
      802,
      { width: 515, align: 'center' },
    );

  doc.end();
  await done;

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return { buffer: Buffer.concat(chunks), filename: `mastipe-digest-${stamp}.pdf` };
}
