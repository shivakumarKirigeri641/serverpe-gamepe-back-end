import sharp from 'sharp';
import { COLUMNS, ROWS, type Ticket } from './ticket.js';

/**
 * Draws a Tambola ticket as a PNG that looks like a real housie ticket.
 *
 * Built as SVG and rasterised with sharp rather than drawn on a canvas: SVG
 * keeps the layout declarative, needs no native canvas build on Windows, and
 * produces a small flat-colour PNG — which matters because the image is
 * base64-inlined into the WhatsApp Flow payload.
 */

export interface TicketImageOptions {
  entryNo: number;
  roomCode?: string;
  brand?: string;
  /** Most recently called number, highlighted differently from earlier marks. */
  latest?: number | null;
  totalNumbers?: number;
}

/** Small enough to inline as base64, large enough to read on a phone. */
const CELL_W = 52;
const CELL_H = 48;
const PAD = 14;
const HEADER_H = 46;
const FOOTER_H = 34;

const WIDTH = PAD * 2 + CELL_W * COLUMNS;
const GRID_TOP = PAD + HEADER_H + 10;
const HEIGHT = GRID_TOP + CELL_H * ROWS + FOOTER_H + PAD;

const COLOR = {
  card: '#ffffff',
  edge: '#d8dde3',
  header: '#b3122b',
  headerText: '#ffffff',
  blank: '#eef1f5',
  cell: '#ffffff',
  number: '#1e2733',
  marked: '#1f9d55',
  markedLatest: '#f0a202',
  markedText: '#ffffff',
  footerText: '#6b7684',
  grid: '#c3cad3',
};

/** SVG is XML — anything interpolated from outside must be escaped. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSvg(ticket: Ticket, drawn: readonly number[], opts: TicketImageOptions): string {
  const called = new Set(drawn);
  const marked = ticket.numbers.filter((n) => called.has(n)).length;
  const total = opts.totalNumbers ?? 90;

  const parts: string[] = [];

  parts.push(
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="16" fill="${COLOR.card}" stroke="${COLOR.edge}" stroke-width="2"/>`,
  );

  // Header band
  parts.push(
    `<rect x="${PAD}" y="${PAD}" width="${WIDTH - PAD * 2}" height="${HEADER_H}" rx="10" fill="${COLOR.header}"/>`,
  );
  parts.push(
    `<text x="${PAD + 16}" y="${PAD + 30}" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="bold" fill="${COLOR.headerText}">${escapeXml(opts.brand ?? 'MastiPe')}</text>`,
  );
  const headerRight = [opts.roomCode ? `Room ${opts.roomCode}` : '', `Ticket ${opts.entryNo}`]
    .filter(Boolean)
    .join('   ·   ');
  parts.push(
    `<text x="${WIDTH - PAD - 16}" y="${PAD + 30}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="16" fill="${COLOR.headerText}" opacity="0.92">${escapeXml(headerRight)}</text>`,
  );

  // Cells
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLUMNS; c += 1) {
      const x = PAD + c * CELL_W;
      const y = GRID_TOP + r * CELL_H;
      const value = (ticket.grid[r] as (number | null)[])[c] ?? null;

      if (value === null) {
        parts.push(
          `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${COLOR.blank}" stroke="${COLOR.grid}" stroke-width="1"/>`,
        );
        continue;
      }

      parts.push(
        `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${COLOR.cell}" stroke="${COLOR.grid}" stroke-width="1"/>`,
      );

      const cx = x + CELL_W / 2;
      const cy = y + CELL_H / 2;

      if (called.has(value)) {
        // A filled disc reads as "crossed off" at a glance, and the most recent
        // number gets its own colour so the player can find it instantly.
        const fill = opts.latest === value ? COLOR.markedLatest : COLOR.marked;
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${Math.min(CELL_W, CELL_H) / 2 - 6}" fill="${fill}"/>`);
        parts.push(
          `<text x="${cx}" y="${cy + 7}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="bold" fill="${COLOR.markedText}">${value}</text>`,
        );
      } else {
        parts.push(
          `<text x="${cx}" y="${cy + 7}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="${COLOR.number}">${value}</text>`,
        );
      }
    }
  }

  // Footer
  const footerY = GRID_TOP + CELL_H * ROWS + 23;
  parts.push(
    `<text x="${PAD + 4}" y="${footerY}" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="${COLOR.footerText}">${marked} of 15 marked</text>`,
  );
  parts.push(
    `<text x="${WIDTH - PAD - 4}" y="${footerY}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="${COLOR.footerText}">${drawn.length} of ${total} called</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${parts.join('')}</svg>`;
}

/**
 * Renders the ticket to PNG bytes.
 *
 * Quantised to a small palette: the artwork is flat colour, so this cuts the
 * file to a few kilobytes with no visible loss, which keeps the base64 form
 * inside the Flow payload budget.
 */
export async function renderTicketPng(
  ticket: Ticket,
  drawn: readonly number[],
  opts: TicketImageOptions,
): Promise<Buffer> {
  const svg = buildSvg(ticket, drawn, opts);
  return sharp(Buffer.from(svg))
    .png({ palette: true, colors: 16, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

/** `data:image/png;base64,...` — the form a Flow Image component wants. */
export async function renderTicketDataUri(
  ticket: Ticket,
  drawn: readonly number[],
  opts: TicketImageOptions,
): Promise<string> {
  const png = await renderTicketPng(ticket, drawn, opts);
  return `data:image/png;base64,${png.toString('base64')}`;
}
