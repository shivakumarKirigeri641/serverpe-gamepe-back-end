/**
 * Renders the MastiPe demo video.
 *
 *   npx tsx scripts/make-demo-video.ts
 *   → src/temp/mastipe-demo.mp4  and  src/temp/mastipe-demo-cover.png
 *
 * Four phones side by side, because the thing people cannot picture is not the
 * rules — it is the choreography. One person opens a room; three friends get a
 * link; the moment Start is pressed the bot becomes the caller and everyone's
 * phone moves together. Showing one screen at a time hides exactly that.
 *
 * Built as SVG frames rasterised by sharp and encoded by ffmpeg, rather than by
 * driving a browser: no headless Chrome to install, it runs the same on a
 * laptop and in CI, and every frame is a pure function of a timestamp — so a
 * scene can be retimed by editing one number instead of re-recording.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { writeDemoMusic } from './demo-music.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Finished films go where the server serves from; the frames and the chosen
// soundtrack do not, so that nothing half-rendered and nothing licensed to
// somebody else is ever reachable from the internet.
const outDir = join(root, 'src', 'media');
const musicDir = join(root, 'src', 'assets', 'music');
const frameDir = join(root, 'src', 'assets', 'music', '.frames');

const W = 1280;
const H = 720;
const FPS = 15;

const C = {
  bg: '#f6f3ef',
  ink: '#1e2733',
  muted: '#6b7684',
  maroon: '#7d0f22',
  maroonDark: '#5c0a19',
  gold: '#f0a202',
  green: '#1f9d55',
  line: '#e2e7ee',
  chatBg: '#efe6dc',
  them: '#ffffff',
  me: '#d9fdd3',
};

type Lang = 'en' | 'hi';

/** Set per render. Two passes produce the English and Hindi films. */
let LANG: Lang = 'en';

// Nirmala UI first for Hindi: it is the Windows face with Devanagari coverage,
// and without a font that has the conjuncts the text rasterises as tofu.
const FONTS = {
  en: 'Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  hi: 'Nirmala UI, Noto Sans Devanagari, Mangal, Segoe UI, Arial, sans-serif',
};

let FONT = FONTS.en;

/** Picks the string for the language being rendered. */
const L = (en: string, hi: string): string => (LANG === 'hi' ? hi : en);

/* ------------------------------------------------------------------ helpers */

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ease-out cubic: fast arrival, gentle settle. Used for every entrance. */
const ease = (p: number): number => 1 - Math.pow(1 - Math.min(Math.max(p, 0), 1), 3);

/**
 * Wraps text to a pixel width.
 *
 * Measured by average character width rather than by real font metrics — sharp
 * rasterises the SVG, so there is nothing to measure against here. The estimate
 * is deliberately conservative: a line that breaks early looks fine, a line
 * that overflows its bubble does not.
 */
function wrap(text: string, widthPx: number, fontSize: number): string[] {
  const perChar = fontSize * 0.55;
  const max = Math.max(8, Math.floor(widthPx / perChar));
  const out: string[] = [];
  let line = '';

  for (const word of text.split(' ')) {
    if (!line.length) line = word;
    else if ((line + ' ' + word).length <= max) line += ' ' + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/* -------------------------------------------------------------- the script */

type Side = 'them' | 'me';

interface Msg {
  at: number;
  phone: number;
  side: Side;
  text: string;
  /** Rendered as a tappable chip, the way WhatsApp shows a reply button. */
  button?: boolean;
  /** Highlights the chip as if a finger landed on it. */
  tapped?: boolean;
}

interface Caption {
  at: number;
  text: string;
}

/** The four phones. Index 0 is the host, who plays as well. */
const phones = (): string[] => [
  L('Rekha  ·  host', 'रेखा  ·  होस्ट'),
  L('Amruta', 'अमृता'),
  L('Ravi', 'रवि'),
  L('Meera', 'मीरा'),
];

const HOST_SUFFIX = () => L('  ·  host', '  ·  होस्ट');

/** Each player's ticket. Real 3x9 layouts: five per row, columns banded. */
const TICKETS: (number | null)[][][] = [
  [
    [4, null, 23, null, 45, null, 61, null, 88],
    [null, 17, 26, 34, null, 52, null, 79, null],
    [8, null, null, 38, 41, 57, 66, null, 90],
  ],
  [
    [6, 12, null, 31, null, 55, null, 72, null],
    [null, 15, 27, null, 44, null, 63, null, 81],
    [9, null, 29, 36, null, 59, null, 78, null],
  ],
  [
    [3, 11, 22, null, null, 51, null, null, 84],
    [null, 19, null, 33, 47, null, 65, 71, null],
    [7, null, 25, null, 49, 58, null, null, 86],
  ],
  [
    [2, null, 24, 35, null, 53, null, null, 82],
    [null, 16, null, 39, 46, null, 64, 75, null],
    [5, 13, null, null, 48, 56, null, 77, null],
  ],
];

/** Numbers the bot calls, and when. Meera's middle row completes on the last. */
// Every number Meera's middle row needs (16, 39, 46, 64, 75) is called, or the
// claim she makes at the end would be one the server would rightly refuse —
// and a demo that shows an invalid claim being accepted teaches the wrong
// thing. The others each get one number too, so no ticket stays empty.
const calls = (): Array<{ at: number; n: number; nick: string }> => [
  { at: 61, n: 4, nick: CHAT('chaar — chhota packet!') },
  { at: 68, n: 27, nick: CHAT('sattaais') },
  { at: 75, n: 16, nick: CHAT('sola — solah singaar') },
  { at: 82, n: 51, nick: CHAT('ikyavan') },
  { at: 89, n: 46, nick: CHAT('chhiyalis') },
  { at: 96, n: 75, nick: CHAT('pachhattar') },
  { at: 103, n: 64, nick: CHAT('chausath') },
  { at: 110, n: 39, nick: CHAT('untaalis — line poori!') },
];

const CLAIM_AT = 115;
const PRIZES_AT = 127;
const END_AT = 165;
const TOTAL = 173;

/**
 * Product text, always English.
 *
 * The bot speaks English in WhatsApp whatever language the viewer reads, so a
 * Hindi film that translated the chat bubbles would be promising a product
 * that does not exist. Everything inside a phone frame goes through here; the
 * narration around it goes through L() and does carry the Hindi.
 */
const CHAT = (en: string): string => en;

/** Every message, on every phone, with the second it appears. */
const messages = (): Msg[] => [
  // --- the host opens a room -------------------------------------------
  { at: 5.0, phone: 0, side: 'me', text: 'hi' },
  { at: 6.2, phone: 0, side: 'them', text: CHAT('Welcome to MastiPe! Tambola on WhatsApp. No app, no account.') },
  { at: 8.0, phone: 0, side: 'them', text: CHAT('Play Tambola'), button: true },
  { at: 9.6, phone: 0, side: 'me', text: CHAT('Play Tambola') },
  { at: 11.0, phone: 0, side: 'them', text: CHAT('How many players are you expecting?') },
  { at: 12.8, phone: 0, side: 'me', text: '4' },
  { at: 14.2, phone: 0, side: 'them', text: CHAT('Room MP4K9T is open. Share this link with your friends.') },

  // --- the friends receive it and tap ----------------------------------
  { at: 18.0, phone: 1, side: 'them', text: CHAT('Rekha: Join my Tambola game! wa.me/mastipe') },
  { at: 18.6, phone: 2, side: 'them', text: CHAT('Rekha: Join my Tambola game! wa.me/mastipe') },
  { at: 19.2, phone: 3, side: 'them', text: CHAT('Rekha: Join my Tambola game! wa.me/mastipe') },

  { at: 21.5, phone: 1, side: 'me', text: 'JOIN MP4K9T' },
  { at: 22.6, phone: 1, side: 'them', text: CHAT("You're in! Waiting for the host to start.") },
  { at: 23.4, phone: 0, side: 'them', text: CHAT('Amruta joined MP4K9T - 1 of 4 so far.') },

  { at: 25.5, phone: 2, side: 'me', text: 'JOIN MP4K9T' },
  { at: 26.6, phone: 2, side: 'them', text: CHAT("You're in! Waiting for the host to start.") },
  { at: 27.4, phone: 0, side: 'them', text: CHAT('Ravi joined MP4K9T - 2 of 4 so far.') },

  { at: 29.5, phone: 3, side: 'me', text: 'JOIN MP4K9T' },
  { at: 30.6, phone: 3, side: 'them', text: CHAT("You're in! Waiting for the host to start.") },
  { at: 31.4, phone: 0, side: 'them', text: CHAT('Meera joined - that is 4 of 4. Everyone is here!') },

  // --- start, and the handover -----------------------------------------
  { at: 37.0, phone: 0, side: 'them', text: CHAT('Once you start, nobody else can join this game.') },
  { at: 39.0, phone: 0, side: 'them', text: CHAT('Start game'), button: true },
  { at: 41.5, phone: 0, side: 'me', text: CHAT('Start game'), tapped: true },

  { at: 44.0, phone: 0, side: 'them', text: CHAT('Game on. From here I am the host - I call the numbers and check every claim. You play too, Rekha.') },
  { at: 44.6, phone: 1, side: 'them', text: CHAT('Game on! Your ticket is ready.') },
  { at: 45.1, phone: 2, side: 'them', text: CHAT('Game on! Your ticket is ready.') },
  { at: 45.6, phone: 3, side: 'them', text: CHAT('Game on! Your ticket is ready.') },
];

/** What the caption bar says, and from when. */
const captions = (): Caption[] => [
  { at: 4.5, text: L('Rekha wants to run a Tambola evening. She messages MastiPe on WhatsApp.', 'रेखा तंबोला की एक शाम रखना चाहती हैं। वे WhatsApp पर MastiPe को मैसेज करती हैं।') },
  { at: 11.0, text: L('She says how many friends are coming. That is the whole setup.', 'वे बताती हैं कितने दोस्त आ रहे हैं। बस, इतनी ही तैयारी है।') },
  { at: 14.2, text: L('A room opens with a code and one link to forward.', 'एक रूम खुलता है - एक कोड और आगे भेजने के लिए एक लिंक।') },
  { at: 17.5, text: L('Her friends get the link in their own chats.', 'दोस्तों को उनकी अपनी चैट में लिंक मिल जाता है।') },
  { at: 21.0, text: L('One tap each. No app to install, no account to make.', 'बस एक टैप। न ऐप डाउनलोड, न खाता बनाना।') },
  { at: 23.4, text: L('Rekha is told who has arrived, and how many are still missing.', 'रेखा को पता चलता रहता है कौन आया और कितने बाकी हैं।') },
  { at: 32.2, text: L('Everyone is in. Nobody can join after Start, so she waits until they are.', 'सब आ गए। शुरू करने के बाद कोई नहीं आ सकता, इसलिए वे सबका इंतज़ार करती हैं।') },
  { at: 37.2, text: L('Rekha is only a temporary host — she opens the room, nothing more.', 'रेखा सिर्फ़ शुरुआत करने वाली होस्ट हैं — वे बस रूम खोलती हैं, बस इतना ही।') },
  { at: 41.5, text: L('She presses Start, and hands the game over.', 'वे Start दबाती हैं और खेल सौंप देती हैं।') },
  { at: 58.5, text: L('No one has to run the game. Nobody sits out to be the caller.', 'खेल चलाने के लिए किसी को बैठना नहीं पड़ता। कोई कॉलर बनकर बाहर नहीं रहता।') },
  { at: 55.0, text: L('Everyone gets their own ticket, on their own phone.', 'हर किसी को अपना टिकट, अपने ही फ़ोन पर मिलता है।') },
  { at: 62.0, text: L('The bot calls a number. It lands on all four phones at once.', 'बॉट एक नंबर बोलता है। वह चारों फ़ोन पर एक साथ पहुँचता है।') },
  { at: 66.5, text: L('Each player answers: do I have it, or not?', 'हर खिलाड़ी जवाब देता है: मेरे पास है, या नहीं?') },
  { at: 73.0, text: L('A number you have is marked on your ticket automatically.', 'जो नंबर आपके पास है वह टिकट पर अपने आप कट जाता है।') },
  { at: 86.0, text: L('A number you do not have costs you nothing. Just say so and wait.', 'जो नंबर आपके पास नहीं है उससे कोई नुकसान नहीं। बस बता दीजिए और इंतज़ार कीजिए।') },
  { at: 110.0, text: L("That last number completes Meera's middle row.", 'इस आखिरी नंबर से मीरा की बीच वाली लाइन पूरी हो गई।') },
  { at: CLAIM_AT, text: L('A prize is not given, it is claimed. Meera taps to claim it.', 'इनाम मिलता नहीं, माँगना पड़ता है। मीरा दावा करती हैं।') },
  { at: CLAIM_AT + 5, text: L('The server checks the claim against the numbers actually called.', 'सर्वर बोले गए नंबरों से मिलाकर दावा जाँचता है।') },
  { at: CLAIM_AT + 8, text: L('Verified. Everyone is told at the same moment.', 'जाँच पूरी। सबको एक ही पल में पता चल जाता है।') },
  { at: PRIZES_AT, text: L('There are six prizes. This is what each one means.', 'कुल छह इनाम हैं। हर एक का मतलब यह है।') },
  { at: PRIZES_AT + 30, text: L('Watch to the end to know every prize and how to claim it.', 'पूरा देखिए — हर इनाम और उसका दावा कैसे करना है, दोनों समझ आ जाएँगे।') },
  { at: END_AT, text: '' },
];

/* ------------------------------------------------------------- components */

function phoneFrame(x: number, y: number, w: number, h: number, name: string, host: boolean): string {
  const accent = host ? C.maroon : C.ink;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="26" fill="#ffffff" stroke="${accent}" stroke-width="${host ? 4 : 2.5}"/>
    <rect x="${x + 8}" y="${y + 8}" width="${w - 16}" height="44" rx="14" fill="${accent}"/>
    <text x="${x + w / 2}" y="${y + 37}" font-family="${FONT}" font-size="17" font-weight="700"
          text-anchor="middle" fill="#ffffff">${esc(name)}</text>
    <rect x="${x + 8}" y="${y + 58}" width="${w - 16}" height="${h - 68}" rx="14" fill="${C.chatBg}"/>`;
}

/** The chat inside one phone: the most recent messages, newest at the bottom. */
function chat(x: number, y: number, w: number, h: number, msgs: Msg[], now: number): string {
  const pad = 16;
  const innerW = w - pad * 2;
  const fs = 13.5;
  const lineH = 17;

  // Lay every visible message out from the bottom up, so the newest is always
  // in view — which is what a phone actually does.
  const visible = msgs.filter((m) => m.at <= now);
  const blocks = visible.map((m) => {
    const lines = wrap(m.text, innerW - 26, fs);
    return { m, lines, height: lines.length * lineH + 16 };
  });

  let out = '';
  let cursor = y + h - 14;

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]!;
    const age = now - b.m.at;
    const p = ease(age / 0.35);
    if (p <= 0) continue;

    const bh = b.height;
    cursor -= bh + 8;
    if (cursor < y + 6) break;

    const bw = Math.min(innerW, Math.max(70, b.lines[0]!.length * fs * 0.58 + 26));
    const bx = b.m.side === 'me' ? x + w - pad - bw : x + pad;
    const slide = (1 - p) * 14;

    const fill = b.m.button ? '#ffffff' : b.m.side === 'me' ? C.me : C.them;
    const stroke = b.m.button ? (b.m.tapped ? C.gold : '#dbe2ea') : 'none';

    out += `<g opacity="${p.toFixed(3)}" transform="translate(0 ${slide.toFixed(1)})">
      <rect x="${bx}" y="${cursor}" width="${bw}" height="${bh}" rx="11" fill="${fill}"
            ${stroke === 'none' ? '' : `stroke="${stroke}" stroke-width="${b.m.tapped ? 3 : 1.5}"`}/>
      ${b.lines
        .map(
          (l, li) =>
            `<text x="${b.m.button ? bx + bw / 2 : bx + 13}" y="${cursor + 20 + li * lineH}"
                   font-family="${FONT}" font-size="${fs}"
                   ${b.m.button ? 'text-anchor="middle" font-weight="700" fill="#1c8ddb"' : `fill="${C.ink}"`}
             >${esc(l)}</text>`,
        )
        .join('')}
    </g>`;
  }

  return out;
}

/** A player's ticket, with the numbers they have marked so far. */
function ticket(x: number, y: number, w: number, grid: (number | null)[][], marked: number[], latest: number | null): string {
  const cw = (w - 8 * 3) / 9;
  const ch = 26;
  let out = '';

  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const v = grid[r]![c];
      const cx = x + c * (cw + 3);
      const cy = y + r * (ch + 3);
      const isLatest = v !== null && v === latest;
      const isMarked = v !== null && marked.includes(v);

      const fill = v === null ? '#e9edf2' : isLatest ? C.gold : isMarked ? C.green : '#ffffff';
      const color = isLatest ? '#3a2a00' : isMarked ? '#ffffff' : C.ink;

      out += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="5" fill="${fill}"
                    stroke="${v === null ? '#e9edf2' : C.line}" stroke-width="1"/>`;
      if (v !== null) {
        out += `<text x="${cx + cw / 2}" y="${cy + 18}" font-family="${FONT}" font-size="12.5"
                      font-weight="700" text-anchor="middle" fill="${color}">${v}</text>`;
      }
    }
  }
  return out;
}

/**
 * The caption bar, which asks to be read when it changes.
 *
 * A line that swaps silently at the bottom of a busy screen is a line nobody
 * notices — the eye is up in the phones. So a new caption arrives with a
 * damped shake and a gold edge that fades out over half a second: enough
 * movement to pull attention down, not so much that it is hard to read while
 * it settles.
 */
function captionBar(text: string, age: number): string {
  if (!text) return '';

  const fade = ease(age / 0.35);
  const lines = wrap(text, 1100, 24);
  const h = lines.length * 32 + 26;
  const y = H - h - 22;

  // A decaying oscillation rather than a linear wobble: it reads as a nudge
  // rather than as an animation, and it is over before it becomes annoying.
  const shake = age < 0.7 ? Math.sin(age * 46) * 9 * Math.exp(-age * 6.5) : 0;
  const glow = age < 0.9 ? 1 - ease(age / 0.9) : 0;
  const lift = (1 - fade) * 10;

  return `<g opacity="${fade.toFixed(3)}" transform="translate(${shake.toFixed(2)} ${lift.toFixed(2)})">
    ${glow > 0.01 ? `<rect x="${52}" y="${y - 8}" width="${W - 104}" height="${h + 16}" rx="20"
                          fill="${C.gold}" opacity="${(glow * 0.55).toFixed(3)}"/>` : ''}
    <rect x="60" y="${y}" width="${W - 120}" height="${h}" rx="16" fill="${C.maroon}" opacity="0.97"/>
    <rect x="60" y="${y}" width="7" height="${h}" rx="3.5" fill="${C.gold}" opacity="${(0.35 + glow * 0.65).toFixed(3)}"/>
    ${lines
      .map(
        (l, i) =>
          `<text x="${W / 2}" y="${y + 36 + i * 32}" font-family="${FONT}" font-size="24"
                 text-anchor="middle" fill="#ffffff">${esc(l)}</text>`,
      )
      .join('')}
  </g>`;
}

/** The MastiPe mark, from the same paths as the logo files. */
function mark(x: number, y: number, size: number): string {
  const s = size / 512;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect width="512" height="512" rx="112" fill="${C.maroon}"/>
    <g fill="none" stroke="${C.gold}" stroke-width="56" stroke-linecap="round" stroke-linejoin="round">
      <path d="M120 400 V150 L215 292 L310 150 V400"/>
      <path d="M310 152 H350 a54 54 0 0 1 0 108 H310"/>
    </g>
  </g>`;
}

/* ------------------------------------------------------------------ scenes */

const prizeList = (): Array<{ name: string; what: string; cells: Array<[number, number]>; any?: boolean }> => [
  { name: L('Early Five', 'अर्ली फाइव'), what: L('The first five numbers on your ticket, wherever they are.', 'आपके टिकट के कोई भी पहले पाँच नंबर।'), cells: [[0, 0], [0, 2], [1, 1], [1, 2], [2, 0]], any: true },
  { name: L('Top Line', 'टॉप लाइन'), what: L('All five numbers in the first row.', 'पहली पंक्ति के पाँचों नंबर।'), cells: [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8]] },
  { name: L('Middle Line', 'मिडिल लाइन'), what: L('All five numbers in the second row.', 'दूसरी पंक्ति के पाँचों नंबर।'), cells: [[1, 1], [1, 2], [1, 3], [1, 5], [1, 7]] },
  { name: L('Bottom Line', 'बॉटम लाइन'), what: L('All five numbers in the third row.', 'तीसरी पंक्ति के पाँचों नंबर।'), cells: [[2, 0], [2, 3], [2, 4], [2, 5], [2, 6]] },
  { name: L('Four Corners', 'फोर कॉर्नर्स'), what: L('The first and last number of the top and bottom rows.', 'पहली और तीसरी पंक्ति के पहले और आखिरी नंबर।'), cells: [[0, 0], [0, 8], [2, 0], [2, 8]] },
  { name: L('Full House', 'फुल हाउस'), what: L('All fifteen numbers. This one ends the game.', 'पूरे पंद्रह नंबर। इसी पर खेल खत्म होता है।'), cells: [] },
];

function prizeScene(t: number): string {
  const local = t - PRIZES_AT;
  const each = (END_AT - PRIZES_AT) / prizeList().length;
  const list = prizeList();
  const idx = Math.min(list.length - 1, Math.floor(local / each));
  const p = list[idx]!;
  const inP = ease((local - idx * each) / 0.5);

  const grid = TICKETS[0]!;
  const lit = new Set(
    (p.cells.length ? p.cells : grid.flatMap((row, r) => row.map((v, c): [number, number] | null => (v === null ? null : [r, c])).filter(Boolean) as Array<[number, number]>))
      .map(([r, c]) => `${r}:${c}`),
  );

  const tx = 300;
  const ty = 250;
  const cw = 74;
  const ch = 56;

  let cells = '';
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const v = grid[r]![c];
      const on = v !== null && lit.has(`${r}:${c}`);
      const x = tx + c * (cw + 5);
      const y = ty + r * (ch + 5);
      cells += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="9"
                      fill="${v === null ? '#e9edf2' : on ? C.gold : '#ffffff'}"
                      stroke="${C.line}" stroke-width="1.5"/>`;
      if (v !== null) {
        cells += `<text x="${x + cw / 2}" y="${y + 37}" font-family="${FONT}" font-size="26"
                        font-weight="700" text-anchor="middle" fill="${on ? '#3a2a00' : C.ink}">${v}</text>`;
      }
    }
  }

  return `
    <text x="${W / 2}" y="120" font-family="${FONT}" font-size="26" font-weight="700"
          text-anchor="middle" fill="${C.muted}" letter-spacing="3">${esc(L('SIX PRIZES', 'छह इनाम'))}</text>
    <g opacity="${inP.toFixed(3)}">
      <text x="${W / 2}" y="185" font-family="${FONT}" font-size="52" font-weight="800"
            text-anchor="middle" fill="${C.maroon}">${esc(p.name)}</text>
      ${cells}
      <text x="${W / 2}" y="${ty + 3 * (ch + 5) + 48}" font-family="${FONT}" font-size="24"
            text-anchor="middle" fill="${C.ink}">${esc(p.any ? L('Any five squares — position does not matter.', 'कोई भी पाँच खाने — जगह मायने नहीं रखती।') : p.what)}</text>
    </g>
    <g>
      ${list.map((_, i) => `<circle cx="${W / 2 - (list.length - 1) * 11 + i * 22}" cy="${H - 46}" r="6"
              fill="${i === idx ? C.maroon : C.line}"/>`).join('')}
    </g>`;
}


/**
 * The one point the whole film exists to make, said outright.
 *
 * A viewer watching four phones will follow the mechanics and still miss the
 * thing that matters commercially: the person who opens the room is not
 * running the game. They press Start and become an ordinary player. A caption
 * scrolling past at the bottom is not enough for that — it gets its own card,
 * held over the phones for six seconds.
 */
function handoverCard(t: number): string {
  const from = 43.5;
  const to = 54.0;
  if (t < from || t > to) return '';

  const p = ease((t - from) / 0.5);
  const out = t > to - 0.6 ? 1 - ease((t - (to - 0.6)) / 0.6) : 1;
  const opacity = p * out;

  const y = 210;
  const h = 300;

  return `<g opacity="${opacity.toFixed(3)}">
    <rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}" opacity="0.82"/>
    <rect x="120" y="${y}" width="${W - 240}" height="${h}" rx="24" fill="#ffffff"
          stroke="${C.gold}" stroke-width="4"/>
    <text x="${W / 2}" y="${y + 62}" font-family="${FONT}" font-size="20" font-weight="800"
          letter-spacing="3" text-anchor="middle" fill="${C.gold}">${esc(L('THE HANDOVER', 'खेल अब बॉट के हाथ में'))}</text>

    <text x="${W / 2}" y="${y + 122}" font-family="${FONT}" font-size="30" font-weight="700"
          text-anchor="middle" fill="${C.ink}">${esc(L('A host is only needed to open the room.', 'रूम खोलने के लिए ही होस्ट चाहिए।'))}</text>

    <text x="${W / 2}" y="${y + 178}" font-family="${FONT}" font-size="30" font-weight="800"
          text-anchor="middle" fill="${C.maroon}">${esc(L('From Start, the WhatsApp bot is the host.', 'Start दबते ही होस्ट WhatsApp बॉट है।'))}</text>

    <text x="${W / 2}" y="${y + 228}" font-family="${FONT}" font-size="23"
          text-anchor="middle" fill="${C.muted}">${esc(L('It calls every number, checks every claim, announces every winner.', 'हर नंबर वही बोलता है, हर दावा वही जाँचता है, हर विजेता वही बताता है।'))}</text>

    <text x="${W / 2}" y="${y + 268}" font-family="${FONT}" font-size="23"
          text-anchor="middle" fill="${C.green}" font-weight="700">${esc(L('Rekha now plays like everybody else.', 'रेखा अब बाकी सबकी तरह खिलाड़ी हैं।'))}</text>
  </g>`;
}

/* ------------------------------------------------------------------- frame */

function frame(t: number): string {
  const body: string[] = [];

  // Title card
  if (t < 4.5) {
    const p = ease(t / 0.8);
    const out = t > 3.9 ? 1 - ease((t - 3.9) / 0.6) : 1;
    body.push(`<g opacity="${(p * out).toFixed(3)}">
      ${mark(W / 2 - 80, 150, 160)}
      <text x="${W / 2}" y="400" font-family="${FONT}" font-size="64" font-weight="800"
            text-anchor="middle" fill="${C.maroon}">MastiPe</text>
      <text x="${W / 2}" y="452" font-family="${FONT}" font-size="26"
            text-anchor="middle" fill="${C.muted}">${esc(L('Play together, have Masti.', 'साथ खेलिए, मस्ती कीजिए।'))}</text>
      <text x="${W / 2}" y="530" font-family="${FONT}" font-size="30" font-weight="700"
            text-anchor="middle" fill="${C.ink}">${esc(L('Tambola on WhatsApp — how a game works', 'WhatsApp पर तंबोला — खेल कैसे चलता है'))}</text>
      <text x="${W / 2}" y="572" font-family="${FONT}" font-size="23"
            text-anchor="middle" fill="${C.muted}">${esc(L('One person opens the room. The bot runs the game.', 'रूम एक व्यक्ति खोलता है। खेल बॉट चलाता है।'))}</text>
      <text x="${W / 2}" y="626" font-family="${FONT}" font-size="21" font-weight="700"
            text-anchor="middle" fill="${C.maroon}">${esc(L('Watch to the end — claiming a prize is explained after the game.', 'पूरा देखिए — इनाम का दावा कैसे करें, यह खेल के बाद बताया गया है।'))}</text>
    </g>`);
    return svg(body.join(''));
  }

  // Prize explanation
  if (t >= PRIZES_AT && t < END_AT) {
    body.push(prizeScene(t));
  } else if (t >= END_AT) {
    const p = ease((t - END_AT) / 0.8);
    body.push(`<g opacity="${p.toFixed(3)}">
      ${mark(W / 2 - 60, 170, 120)}
      <text x="${W / 2}" y="400" font-family="${FONT}" font-size="46" font-weight="800"
            text-anchor="middle" fill="${C.maroon}">${esc(L('Say hi on WhatsApp', 'WhatsApp पर hi भेजिए'))}</text>
      <text x="${W / 2}" y="452" font-family="${FONT}" font-size="28"
            text-anchor="middle" fill="${C.ink}">+91 97396 22631  ·  mastipe.in</text>
      <text x="${W / 2}" y="530" font-family="${FONT}" font-size="20"
            text-anchor="middle" fill="${C.muted}">${esc(L('For entertainment only  ·  No betting  ·  No money', 'केवल मनोरंजन के लिए  ·  कोई सट्टा नहीं  ·  कोई पैसा नहीं'))}</text>
    </g>`);
  } else {
    // The four phones
    const px = [40, 355, 670, 985];
    const py = 92;
    const pw = 255;
    const ph = 470;

    const playing = t >= 54.2;
    const called = calls().filter((c) => c.at <= t);
    const latest = called.length ? called[called.length - 1]!.n : null;

    for (let i = 0; i < 4; i += 1) {
      // Rekha is marked as the host only while she is one. The moment the game
      // starts the bot is the host and she is a player like everybody else —
      // so the red frame and the "· host" label go, which is the visual half
      // of the point the narration is making.
      const isHost = i === 0 && !playing;
      const label = phones()[i]!;
      body.push(phoneFrame(px[i]!, py, pw, ph, isHost ? label : label.replace(HOST_SUFFIX(), ''), isHost));

      if (playing) {
        // In play the ticket takes the phone, with the call above it.
        const grid = TICKETS[i]!;
        const marked = called.map((c) => c.n).filter((n) => grid.some((row) => row.includes(n)));
        const call = called[called.length - 1];
        const mine = call ? grid.some((row) => row.includes(call.n)) : false;
        const since = call ? t - call.at : 99;

        body.push(`<rect x="${px[i]! + 16}" y="${py + 70}" width="${pw - 32}" height="52" rx="10"
                         fill="${mine ? '#eafaf0' : '#ffffff'}" stroke="${C.line}"/>
          <text x="${px[i]! + pw / 2}" y="${py + 104}" font-family="${FONT}" font-size="27" font-weight="800"
                text-anchor="middle" fill="${mine ? C.green : C.muted}">${call ? call.n : '· · ·'}</text>`);

        body.push(ticket(px[i]! + 16, py + 136, pw - 32, grid, marked, latest));

        // The two answers, and the tap that follows a beat later.
        if (call && since > 1.2) {
          const tapped = since > 2.6;
          const yesTone = mine ? (tapped ? C.green : '#ffffff') : '#ffffff';
          const noTone = !mine ? (tapped ? C.muted : '#ffffff') : '#ffffff';
          body.push(`
            <rect x="${px[i]! + 16}" y="${py + 250}" width="${pw - 32}" height="38" rx="9"
                  fill="${yesTone}" stroke="${mine && tapped ? C.green : C.line}" stroke-width="${mine && tapped ? 2.5 : 1.5}"/>
            <text x="${px[i]! + pw / 2}" y="${py + 274}" font-family="${FONT}" font-size="12.5" font-weight="700"
                  text-anchor="middle" fill="${mine && tapped ? '#ffffff' : '#1c8ddb'}">${esc(CHAT('Yes, I have this number'))}</text>
            <rect x="${px[i]! + 16}" y="${py + 294}" width="${pw - 32}" height="38" rx="9"
                  fill="${noTone}" stroke="${!mine && tapped ? C.muted : C.line}" stroke-width="${!mine && tapped ? 2.5 : 1.5}"/>
            <text x="${px[i]! + pw / 2}" y="${py + 318}" font-family="${FONT}" font-size="12.5" font-weight="700"
                  text-anchor="middle" fill="${!mine && tapped ? '#ffffff' : '#1c8ddb'}">${esc(CHAT('No, not on my ticket'))}</text>`);
        }

        // The claim, on Meera's phone only, then announced to everybody.
        if (t >= CLAIM_AT && i === 3) {
          const shown = ease((t - CLAIM_AT) / 0.4);
          const done = t >= CLAIM_AT + 6;
          body.push(`<g opacity="${shown.toFixed(3)}">
            <rect x="${px[i]! + 16}" y="${py + 340}" width="${pw - 32}" height="44" rx="10"
                  fill="${done ? C.green : C.gold}"/>
            <text x="${px[i]! + pw / 2}" y="${py + 368}" font-family="${FONT}" font-size="14" font-weight="800"
                  text-anchor="middle" fill="${done ? '#ffffff' : '#3a2a00'}">${esc(done ? CHAT('Middle Line — yours!') : CHAT('Claim Middle Line'))}</text>
          </g>`);
        }
        if (t >= CLAIM_AT + 6 && i !== 3) {
          const shown = ease((t - CLAIM_AT - 6) / 0.4);
          body.push(`<g opacity="${shown.toFixed(3)}">
            <rect x="${px[i]! + 16}" y="${py + 340}" width="${pw - 32}" height="44" rx="10" fill="#eafaf0" stroke="${C.green}"/>
            <text x="${px[i]! + pw / 2}" y="${py + 368}" font-family="${FONT}" font-size="13" font-weight="800"
                  text-anchor="middle" fill="#14663a">${esc(CHAT('Meera won Middle Line'))}</text>
          </g>`);
        }
      } else {
        body.push(chat(px[i]!, py + 58, pw, ph - 68, messages().filter((m) => m.phone === i), t));
      }
    }

    // The bot's voice, above the phones, once it is calling.
    if (playing) {
      const call = calls().filter((c) => c.at <= t).pop();
      const since = call ? t - call.at : 0;
      const pop = call && since < 0.5 ? 1 + 0.12 * (1 - ease(since / 0.5)) : 1;
      // Before the first number there is nothing to call, and "THE BOT IS
      // CALLING —" reads as a bug rather than as a pause. The bar says what is
      // actually true for those few seconds instead.
      const waiting = !call;
      body.push(`
        <rect x="40" y="24" width="1200" height="54" rx="14" fill="${waiting ? C.ink : C.maroon}"/>
        <text x="70" y="58" font-family="${FONT}" font-size="15" font-weight="800" fill="#ffffff" opacity="0.75">${esc(
          waiting ? L('TICKETS ARE OUT — FIRST NUMBER COMING UP', 'टिकट बँट गए — पहला नंबर आने वाला है') : CHAT('THE BOT IS CALLING'),
        )}</text>
        <g transform="translate(${W / 2} 58) scale(${pop.toFixed(3)}) translate(${-W / 2} -58)">
          <text x="${W / 2}" y="60" font-family="${FONT}" font-size="34" font-weight="800"
                text-anchor="middle" fill="#ffffff">${call ? call.n : '· · ·'}</text>
        </g>
        <text x="1210" y="58" font-family="${FONT}" font-size="17" text-anchor="end"
              fill="#ffffff" opacity="0.85">${call ? esc(call.nick) : ''}</text>`);
    } else {
      body.push(`${mark(44, 22, 46)}
        <text x="104" y="55" font-family="${FONT}" font-size="26" font-weight="800" fill="${C.maroon}">MastiPe</text>`);
    }
  }

  body.push(handoverCard(t));

  // Caption
  const cap = [...captions()].reverse().find((c) => c.at <= t);
  if (cap) body.push(captionBar(cap.text, t - cap.at));

  return svg(body.join(''));
}

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${C.bg}"/>
    ${inner}
  </svg>`;
}

/* -------------------------------------------------------------------- main */

const cover = (): string => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${C.maroon}"/><stop offset="1" stop-color="${C.maroonDark}"/>
  </linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  ${mark(W / 2 - 70, 120, 140)}
  <text x="${W / 2}" y="345" font-family="${FONT}" font-size="70" font-weight="800"
        text-anchor="middle" fill="#fdfaf5">MastiPe</text>
  <text x="${W / 2}" y="405" font-family="${FONT}" font-size="32" font-weight="700"
        text-anchor="middle" fill="${C.gold}">${esc(L('Tambola on WhatsApp', 'WhatsApp पर तंबोला'))}</text>
  <text x="${W / 2}" y="470" font-family="${FONT}" font-size="26"
        text-anchor="middle" fill="#ffffff" opacity="0.85">${esc(L('One host · four friends · one link to join', 'एक होस्ट · चार दोस्त · शामिल होने के लिए एक लिंक'))}</text>
  <rect x="${W / 2 - 170}" y="520" width="340" height="60" rx="30" fill="${C.gold}"/>
  <text x="${W / 2}" y="559" font-family="${FONT}" font-size="26" font-weight="800"
        text-anchor="middle" fill="#3a2a00">${esc(L('▶  Watch how it works', '▶  देखिए यह कैसे चलता है'))}</text>
  <text x="${W / 2}" y="660" font-family="${FONT}" font-size="18"
        text-anchor="middle" fill="#ffffff" opacity="0.6">${esc(L('For entertainment only · No betting · No money', 'केवल मनोरंजन के लिए · कोई सट्टा नहीं · कोई पैसा नहीं'))}</text>
</svg>`;

/**
 * The soundtrack.
 *
 * A file dropped into src/temp wins — it is what somebody chose, and taste
 * beats arithmetic. Anything else falls back to the synthesised music box,
 * so the script still produces a finished film on a machine with no audio
 * assets at all.
 */
async function soundtrack(): Promise<{ path: string; loop: boolean }> {
  const supplied = (await readdir(musicDir).catch(() => []))
    .filter((f) => /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f))
    .sort();

  if (supplied[0]) return { path: join(musicDir, supplied[0]), loop: true };

  const synth = join(frameDir, 'demo-music.wav');
  await writeDemoMusic(synth, TOTAL);
  return { path: synth, loop: false };
}

async function render(lang: Lang): Promise<void> {
  LANG = lang;
  FONT = FONTS[lang];

  const suffix = lang === 'hi' ? '-hi' : '';
  const coverPath = join(outDir, `mastipe-demo${suffix}-cover.png`);
  const out = join(outDir, `mastipe-demo${suffix}.mp4`);

  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  await sharp(Buffer.from(cover())).png().toFile(coverPath);

  const total = Math.round(TOTAL * FPS);
  for (let i = 0; i < total; i += 1) {
    await sharp(Buffer.from(frame(i / FPS)))
      .png({ compressionLevel: 3 })
      .toFile(join(frameDir, `f${String(i).padStart(5, '0')}.png`));
    if (i % 300 === 0) console.log(`  ${lang}: ${i}/${total}`);
  }

  const music = await soundtrack();

  execFileSync(
    ffmpegPath as string,
    [
      '-y',
      '-framerate', String(FPS),
      '-i', join(frameDir, 'f%05d.png'),
      // A track shorter than the film is looped rather than left to run out in
      // silence; -shortest then trims it to the last frame.
      ...(music.loop ? ['-stream_loop', '-1'] : []),
      '-i', music.path,
      '-c:a', 'aac',
      '-b:a', '128k',
      // Quiet enough to read captions over, and faded out under the end card
      // so the film finishes rather than being cut off mid-bar.
      '-af', `volume=0.35,afade=t=out:st=${TOTAL - 4}:d=4`,
      '-shortest',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '20',
      // yuv420p and even dimensions: without both, the file plays in VLC and
      // shows a black rectangle in WhatsApp, Safari and PowerPoint.
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  await rm(frameDir, { recursive: true, force: true });
  console.log(`${lang}: ${out}`);
  console.log(`${lang}: ${coverPath}`);
}

await render('en');
await render('hi');
console.log('\ndone');
