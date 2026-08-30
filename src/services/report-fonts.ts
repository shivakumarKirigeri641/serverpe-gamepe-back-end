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
  kannada: 'NotoSansKannada',
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

  // Every other available script is registered alongside, so a single name in
  // Kannada or Devanagari can be drawn with the right face without swapping the
  // document's body font. Player names arrive in whatever script the person set
  // on WhatsApp, and one of them being unreadable should not cost the rest of
  // the report its typography.
  for (const other of availableScripts()) {
    if (other === script) continue;
    const base = FACES[other];
    const reg = join(DIR, `${base}-Regular.ttf`);
    const bld = join(DIR, `${base}-Bold.ttf`);
    if (!existsSync(reg)) continue;
    doc.registerFont(other, reg);
    doc.registerFont(`${other}Bold`, existsSync(bld) ? bld : reg);
  }

  return { regular: 'body', bold: 'bodyBold', oblique: 'bodyOblique', unicode: true };
}

/**
 * Which face a piece of text needs.
 *
 * Player names arrive in whatever script the person set on WhatsApp — a real
 * game already produced "ಗಂಗಾಧರ", which DejaVu cannot draw at all, so the name
 * silently vanished from their report. Detected from the text rather than from
 * a profile setting, because nobody tells us their script and the name itself
 * is the only evidence.
 */
export function scriptFor(text: string): Script {
  if (/[ಀ-೿]/.test(text)) return 'kannada';
  if (/[ऀ-ॿ]/.test(text)) return 'devanagari';
  return 'latin';
}

/** Which scripts can actually be typeset on this machine right now. */
export function availableScripts(): Script[] {
  return (Object.keys(FACES) as Script[]).filter((s) =>
    existsSync(join(DIR, `${FACES[s]}-Regular.ttf`)),
  );
}

/**
 * The registered font name to draw this text with.
 *
 * Latin text keeps the body face; anything else gets the face that can actually
 * render it. Called per string rather than per document because one player in a
 * room of ten may be the only one whose name is not Latin.
 */
export function fontForText(text: string, fonts: FontSet, bold = false): string {
  const script = scriptFor(text);
  if (script === 'latin') return bold ? fonts.bold : fonts.regular;
  if (!availableScripts().includes(script)) return bold ? fonts.bold : fonts.regular;
  return bold ? `${script}Bold` : script;
}
