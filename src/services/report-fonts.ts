import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Fonts for the report PDFs.
 *
 * pdfkit's built-in Helvetica is WinAnsi-encoded. Anything outside Latin-1 —
 * the rupee sign, em dashes, curly quotes, arrows, box-drawing characters,
 * Devanagari — measures as zero width in it. The PDF still generates, the send
 * still succeeds, nothing appears in the logs, and the player opens a report
 * with pieces missing. It fails silently, which is the worst way to fail, and
 * it is why this module exists rather than the reports simply naming a font.
 *
 * DejaVu Sans is the Latin face: it covers the rupee sign, the punctuation and
 * the symbols the reports actually use, and it is freely embeddable (Bitstream
 * Vera licence). Noto Sans Devanagari is registered when present, for Hindi.
 *
 * Bundled in src/assets/fonts rather than read from the system, because the
 * production Linux box has none of the faces a Windows machine does.
 *
 * Adding a script: drop NotoSans<Script>-Regular.ttf and -Bold.ttf into that
 * folder and add a line to FACES. Nothing else changes.
 */

const DIR = join(process.cwd(), 'src', 'assets', 'fonts');

const FACES = {
  latin: 'DejaVuSans',
  devanagari: 'NotoSansDevanagari',
} as const;

export type Script = keyof typeof FACES;

/** Names to hand to doc.font(), plus whether real Unicode faces were found. */
export interface FontSet {
  regular: string;
  bold: string;
  oblique: string;
  unicode: boolean;
}

const HELVETICA: FontSet = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  oblique: 'Helvetica-Oblique',
  unicode: false,
};

// Warned once per process rather than once per report: a missing font is a
// deployment problem, and one line per generated PDF would bury it.
const warned = new Set<string>();

/**
 * Registers the faces for a script on a document and returns their names.
 *
 * Falls back to Helvetica when a face is missing — the report still renders,
 * just without the symbols, and the log says so loudly enough to notice.
 */
export function useFonts(doc: PDFKit.PDFDocument, script: Script = 'latin'): FontSet {
  const base = FACES[script];
  const regular = join(DIR, `${base}-Regular.ttf`);
  const bold = join(DIR, `${base}-Bold.ttf`);
  const oblique = join(DIR, `${base}-Oblique.ttf`);

  if (!existsSync(regular)) {
    if (!warned.has(base)) {
      warned.add(base);
      logger.error(
        { script, expected: regular },
        'no bundled font for this script — falling back to Helvetica, symbols WILL NOT render',
      );
    }
    return HELVETICA;
  }

  doc.registerFont('body', regular);
  doc.registerFont('bodyBold', existsSync(bold) ? bold : regular);
  // Noto ships no oblique; reusing regular is better than silently dropping the
  // text a missing face would cause.
  doc.registerFont('bodyOblique', existsSync(oblique) ? oblique : regular);

  return { regular: 'body', bold: 'bodyBold', oblique: 'bodyOblique', unicode: true };
}

/** Which scripts can actually be typeset on this machine right now. */
export function availableScripts(): Script[] {
  return (Object.keys(FACES) as Script[]).filter((s) =>
    existsSync(join(DIR, `${FACES[s]}-Regular.ttf`)),
  );
}
