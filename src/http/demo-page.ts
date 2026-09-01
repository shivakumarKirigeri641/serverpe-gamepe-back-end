import { apiPath, env } from '../config/env.js';
import { whatsappReturnUrl } from './board-token.js';
import { nicknameFor } from '../games/tambola/nicknames.js';

/**
 * How to play, shown rather than described.
 *
 * Tambola is obvious once you have seen a round and opaque until then, and the
 * people this product is for have mostly played it in a room with paper tickets
 * — never on a phone. A page of instructions would be read by nobody; a ticket
 * that fills itself in while numbers are called explains it in ten seconds.
 *
 * Server-rendered and self-contained for the same reasons as the board: it is
 * opened from a chat message on a phone, must work with no login and no build
 * step, and is linked from both WhatsApp and the marketing site so there is one
 * copy of the explanation rather than two that drift.
 *
 * Deliberately fake: no game, no player, no state. Nothing here can affect a
 * real room, which is what makes it safe to link publicly.
 */

const COLOR = {
  maroon: '#7d0f22',
  maroonDark: '#5c0a19',
  gold: '#f0a202',
  green: '#1f9d55',
  ink: '#1e2733',
  muted: '#6b7684',
  line: '#e2e7ee',
  bg: '#f6f3ef',
};

/**
 * A real 3x9 ticket layout: fifteen numbers, five per row, banded by column.
 *
 * Fixed rather than generated so the prize diagrams below can point at known
 * cells — an explanation of Four Corners is useless if the corners move on
 * every page load.
 */
const TICKET: (number | null)[][] = [
  [4, null, 23, null, 45, null, 61, null, 88],
  [null, 17, 26, 34, null, 52, null, 79, null],
  [8, null, null, 38, 41, 57, 66, null, 90],
];

/** The order the demo calls them in, chosen to complete prizes in sequence. */
const CALL_ORDER = [4, 17, 23, 26, 34, 45, 8, 88, 90, 52, 79, 38, 41, 57, 61, 66];

interface Prize {
  key: string;
  label: string;
  labelHi: string;
  what: string;
  whatHi: string;
  /** Cells to highlight, as [row, col]. Empty means "any five". */
  cells: Array<[number, number]>;
  anyFive?: boolean;
}

const PRIZES: Prize[] = [
  {
    key: 'early_five',
    label: 'Early Five',
    labelHi: 'अर्ली फाइव',
    what: 'The first five numbers on your ticket, wherever they are.',
    whatHi: 'आपके टिकट के कोई भी पहले पाँच नंबर।',
    cells: [],
    anyFive: true,
  },
  {
    key: 'top_line',
    label: 'Top Line',
    labelHi: 'टॉप लाइन',
    what: 'All five numbers in the first row.',
    whatHi: 'पहली पंक्ति के पाँचों नंबर।',
    cells: [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8]],
  },
  {
    key: 'middle_line',
    label: 'Middle Line',
    labelHi: 'मिडिल लाइन',
    what: 'All five numbers in the second row.',
    whatHi: 'दूसरी पंक्ति के पाँचों नंबर।',
    cells: [[1, 1], [1, 2], [1, 3], [1, 5], [1, 7]],
  },
  {
    key: 'bottom_line',
    label: 'Bottom Line',
    labelHi: 'बॉटम लाइन',
    what: 'All five numbers in the third row.',
    whatHi: 'तीसरी पंक्ति के पाँचों नंबर।',
    cells: [[2, 0], [2, 3], [2, 4], [2, 5], [2, 6]],
  },
  {
    key: 'four_corners',
    label: 'Four Corners',
    labelHi: 'फोर कॉर्नर्स',
    what: 'The first and last number of the top row, and of the bottom row.',
    whatHi: 'पहली और तीसरी पंक्ति के पहले और आखिरी नंबर।',
    cells: [[0, 0], [0, 8], [2, 0], [2, 8]],
  },
  {
    key: 'full_house',
    label: 'Full House',
    labelHi: 'फुल हाउस',
    what: 'All fifteen numbers. This one ends the game.',
    whatHi: 'पूरे पंद्रह नंबर। इसी पर खेल खत्म होता है।',
    cells: TICKET.flatMap((row, r) =>
      row.map((v, c): [number, number] | null => (v === null ? null : [r, c])).filter(
        (x): x is [number, number] => x !== null,
      ),
    ),
  },
];

interface Bubble {
  /** 'them' is the bot, 'me' is the person holding the phone. */
  side: 'them' | 'me';
  text: string;
  /** Rendered as a tappable-looking chip, the way WhatsApp shows buttons. */
  button?: boolean;
  /** A caption above the bubble, e.g. who is speaking. */
  who?: string;
}

/**
 * The whole journey, as it actually appears in the chat.
 *
 * The part people cannot picture is the handover: one person opens the room,
 * and from the moment they press Start the bot is the host — it calls, it
 * checks the claims, it decides. Nobody has to sit with a bag of tokens, and
 * the person who started the room plays like everyone else. That is the thing
 * this transcript exists to show, so it is stated in the chat itself rather
 * than in a caption beside it.
 */
const CHAT_EN: Bubble[] = [
  { side: 'me', text: 'hi', who: 'Rekha, who is starting the game' },
  { side: 'them', text: 'Welcome to MastiPe! Tambola on WhatsApp — no app, no account.' },
  { side: 'them', text: 'Play Tambola', button: true },
  { side: 'me', text: 'Play Tambola' },
  { side: 'them', text: 'How many players are you expecting?' },
  { side: 'me', text: '12' },
  { side: 'them', text: 'Your room is open. Code MP4K9T. Share the invite link with your friends.' },
  { side: 'them', text: 'Amruta joined. Ravi joined. Meera joined. 12 in the room.' },
  { side: 'them', text: 'Everyone in? Once you start, nobody else can join this game.' },
  { side: 'them', text: 'Start game', button: true },
  { side: 'me', text: 'Start game' },
  {
    side: 'them',
    text: 'Game on. From here I am the host — I call the numbers, check every claim and announce the winners. Rekha now plays like everybody else.',
  },
  { side: 'them', text: 'Ticket sent to all 12 players. Open yours and keep it in front of you.' },
  { side: 'them', text: 'First number... 4 — chaar, ekdum chhota packet!' },
];

const CHAT_HI: Bubble[] = [
  { side: 'me', text: 'hi', who: 'रेखा, जो खेल शुरू कर रही हैं' },
  { side: 'them', text: 'MastiPe में स्वागत है! WhatsApp पर तंबोला — न ऐप, न खाता।' },
  { side: 'them', text: 'तंबोला खेलें', button: true },
  { side: 'me', text: 'तंबोला खेलें' },
  { side: 'them', text: 'कितने लोग खेलने वाले हैं?' },
  { side: 'me', text: '12' },
  { side: 'them', text: 'आपका रूम खुल गया। कोड MP4K9T। दोस्तों को लिंक भेज दीजिए।' },
  { side: 'them', text: 'अमृता आ गईं। रवि आ गए। मीरा आ गईं। रूम में 12 लोग।' },
  { side: 'them', text: 'सब आ गए? शुरू करने के बाद कोई और शामिल नहीं हो पाएगा।' },
  { side: 'them', text: 'खेल शुरू करें', button: true },
  { side: 'me', text: 'खेल शुरू करें' },
  {
    side: 'them',
    text: 'खेल शुरू! अब से होस्ट मैं हूँ — नंबर मैं बोलूँगा, हर दावा मैं जाँचूँगा, विजेता मैं बताऊँगा। रेखा अब बाकी सबकी तरह खिलाड़ी हैं।',
  },
  { side: 'them', text: 'सभी 12 खिलाड़ियों को टिकट भेज दिया। अपना टिकट खोल लीजिए।' },
  { side: 'them', text: 'पहला नंबर... 4 — चार, एकदम छोटा पैकेट!' },
];

interface SyncFrame {
  caption: string;
  /** One line per phone: the host's, then the three players'. */
  screens: [string, string, string, string];
}

/**
 * The same minute, seen from four phones at once.
 *
 * Everything else on this page is one person's view, and that hides the part
 * people ask about first: what are the others doing while I wait? Four screens
 * side by side answer it — the host watching the count climb, three players
 * sitting on "waiting for the host", then the same number landing on all four
 * at the same instant.
 */
const SYNC_EN: SyncFrame[] = [
  {
    caption: 'Rekha opens a room and shares the link.',
    screens: ['Room MP4K9T is open. 0 joined.', 'Invite received', 'Invite received', 'Invite received'],
  },
  {
    caption: 'Amruta taps the link. She is in.',
    screens: ['1 joined: Amruta', "You're in! Waiting for the host.", 'Invite received', 'Invite received'],
  },
  {
    caption: 'Ravi taps it too.',
    screens: ['2 joined: Amruta, Ravi', 'Waiting for the host.', "You're in! Waiting for the host.", 'Invite received'],
  },
  {
    caption: 'Meera joins. The host can see the room filling up.',
    screens: ['3 joined: Amruta, Ravi, Meera', 'Waiting for the host.', 'Waiting for the host.', "You're in! Waiting."],
  },
  {
    caption: 'Nobody can join after Start, so the host waits until everyone is in.',
    screens: ['Everyone in? Nobody can join once you start.', 'Waiting...', 'Waiting...', 'Waiting...'],
  },
  {
    caption: 'The host presses Start. The bot takes over and sends everyone a ticket.',
    screens: ['Game on. You play too.', 'Your ticket is ready.', 'Your ticket is ready.', 'Your ticket is ready.'],
  },
];

const SYNC_HI: SyncFrame[] = [
  {
    caption: 'रेखा रूम खोलती हैं और लिंक भेजती हैं।',
    screens: ['रूम MP4K9T खुला। 0 शामिल।', 'लिंक मिला', 'लिंक मिला', 'लिंक मिला'],
  },
  {
    caption: 'अमृता ने लिंक टैप किया। वे अंदर आ गईं।',
    screens: ['1 शामिल: अमृता', 'आप अंदर हैं! होस्ट का इंतज़ार।', 'लिंक मिला', 'लिंक मिला'],
  },
  {
    caption: 'रवि ने भी टैप किया।',
    screens: ['2 शामिल: अमृता, रवि', 'होस्ट का इंतज़ार।', 'आप अंदर हैं! इंतज़ार।', 'लिंक मिला'],
  },
  {
    caption: 'मीरा भी आ गईं। होस्ट को रूम भरता दिख रहा है।',
    screens: ['3 शामिल: अमृता, रवि, मीरा', 'होस्ट का इंतज़ार।', 'होस्ट का इंतज़ार।', 'आप अंदर हैं!'],
  },
  {
    caption: 'शुरू होने के बाद कोई नहीं आ सकता, इसलिए होस्ट सबका इंतज़ार करती हैं।',
    screens: ['सब आ गए? शुरू के बाद कोई नहीं आ सकता।', 'इंतज़ार...', 'इंतज़ार...', 'इंतज़ार...'],
  },
  {
    caption: 'होस्ट ने Start दबाया। अब बॉट होस्ट है और सबको टिकट भेज देता है।',
    screens: ['खेल शुरू। आप भी खेलिए।', 'आपका टिकट तैयार।', 'आपका टिकट तैयार।', 'आपका टिकट तैयार।'],
  },
];

/**
 * The four tickets in the room, and the numbers the bot calls.
 *
 * Real tickets: five to a row, columns banded 1-9, 10-19 ... 80-90, no number
 * twice. Fixed rather than generated, because the sequence has to land
 * somewhere specific — Meera's middle row completing is the moment the claim
 * is explained, and a random ticket would not give it.
 */
const ROOM_TICKETS: (number | null)[][][] = [
  TICKET,
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

/** Ten calls: hits spread across all four phones, ending on Meera's row. */
const ROOM_CALLS = [4, 16, 27, 33, 46, 64, 8, 51, 75, 39];

/** What a claim looks like: the hint, the tap, the verdict — right and wrong. */
const CLAIM_EN: Bubble[] = [
  { side: 'them', text: 'Middle Line looks close on your ticket. All five marked? Claim it.' },
  { side: 'them', text: 'Claim Middle Line', button: true },
  { side: 'me', text: 'Claim Middle Line' },
  { side: 'them', text: 'Verified. Middle Line goes to Meera, checked against the 24 numbers called so far.' },
  {
    side: 'them',
    text: 'And if it does not match: "Not yet — 52 has not been called. Nothing lost, keep playing."',
  },
];

const CLAIM_HI: Bubble[] = [
  { side: 'them', text: 'आपके टिकट पर मिडिल लाइन पूरी लग रही है। पाँचों कट गए? दावा कीजिए।' },
  { side: 'them', text: 'मिडिल लाइन का दावा', button: true },
  { side: 'me', text: 'मिडिल लाइन का दावा' },
  { side: 'them', text: 'जाँच लिया। मिडिल लाइन मीरा को — अब तक बोले गए 24 नंबरों से मिलाकर।' },
  {
    side: 'them',
    text: 'और अगर नहीं मिला: "अभी नहीं — 52 अभी बोला ही नहीं गया। कुछ नुकसान नहीं, खेलते रहिए।"',
  },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A small static ticket with certain cells marked, for the prize list. */
function miniTicket(cells: Array<[number, number]>, anyFive: boolean): string {
  const on = new Set(cells.map(([r, c]) => `${r}:${c}`));
  let out = '<div class="mini">';
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 9; c += 1) {
      const v = TICKET[r]?.[c] ?? null;
      const cls = v === null ? 'blank' : on.has(`${r}:${c}`) ? 'lit' : '';
      out += `<i class="${cls}"></i>`;
    }
  }
  out += '</div>';
  return anyFive ? out.replace('class="mini"', 'class="mini anyfive"') : out;
}

/** WhatsApp-style bubbles. `hidden` is for the ones the animation reveals. */
function renderChat(bubbles: Bubble[], animated: boolean): string {
  return bubbles
    .map((b) => {
      const cls = [
        'b',
        b.side,
        b.button ? 'btn' : '',
        animated ? 'hide' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const who = b.who ? `<em class="who">${escapeHtml(b.who)}</em>` : '';
      return `<div class="${cls}">${who}<span>${escapeHtml(b.text)}</span></div>`;
    })
    .join('');
}

export function renderDemoPage(lang: 'en' | 'hi' = 'en'): string {
  const hi = lang === 'hi';
  const t = {
    title: hi ? 'MastiPe कैसे खेलें' : 'How to play MastiPe',
    sub: hi
      ? 'तंबोला, वही जो आप जानते हैं — बस अब अपने फ़ोन पर।'
      : 'Tambola, exactly as you know it — just on your phone now.',
    watch: hi ? 'देखिए कैसे चलता है' : 'Watch a round',
    watchSub: hi
      ? 'नंबर बोले जाते हैं, आपका टिकट अपने आप भरता जाता है।'
      : 'Numbers are called, and your ticket fills in as they come.',
    play: hi ? '▶  चलाकर देखें' : '▶  Play the demo',
    again: hi ? '↻  फिर से' : '↻  Again',
    steps: hi ? 'चार कदम' : 'Four steps',
    prizes: hi ? 'छह इनाम' : 'Six prizes',
    prizesSub: hi
      ? 'हर इनाम पर दावा आपको करना होता है — सर्वर जाँचता है कि सही है या नहीं।'
      : 'You claim each prize yourself, and the server checks it against the numbers actually called.',
    cta: hi ? 'WhatsApp पर खेलें' : 'Play on WhatsApp',
    ent: hi
      ? 'केवल मनोरंजन के लिए · कोई सट्टा नहीं · कोई पैसा नहीं'
      : 'For Entertainment Only · No betting · No money',
    switch: hi ? 'Read in English' : 'हिंदी में पढ़ें',
    flow: hi ? 'हाय से पहले नंबर तक' : 'From "hi" to the first number',
    flowSub: hi
      ? 'एक व्यक्ति रूम खोलता है। Start दबते ही होस्ट बॉट बन जाता है — नंबर वही बोलता है, दावे वही जाँचता है। रूम खोलने वाला भी बाकी सबकी तरह खिलाड़ी बन जाता है।'
      : 'One person opens the room. The moment they press Start, the bot is the host — it calls, it checks the claims, it announces. Whoever opened the room plays like everybody else.',
    playChat: hi ? '▶  चैट चलाकर देखें' : '▶  Play the chat',
    room: hi ? 'चार फ़ोन, एक ही खेल' : 'Four phones, one game',
    roomSub: hi
      ? 'होस्ट इंतज़ार करती हैं, खिलाड़ी एक-एक करके आते हैं, फिर सबका खेल साथ चलता है।'
      : 'The host waits, players arrive one by one, and from Start everything happens on all the phones together.',
    next: hi ? 'आगे  ▸' : 'Next  ▸',
    claim: hi ? 'दावा कैसे होता है' : 'How a claim works',
    claimSub: hi
      ? 'दावा आप करते हैं, जाँच सर्वर करता है — बोले गए नंबरों से मिलाकर। इसलिए बहस की गुंजाइश ही नहीं। हर इनाम सिर्फ़ एक बार, और सबसे पहला सही दावा जीतता है। गलत दावे पर कोई नुकसान नहीं।'
      : 'You claim, the server checks it against the numbers actually called. There is nothing to argue about. Each prize goes once, to the first valid claim, and a wrong claim costs you nothing.',
    hostLabel: hi ? 'रेखा · होस्ट' : 'Rekha · host',
    botCalling: hi ? 'बॉट नंबर बोल रहा है' : 'The bot is calling',
    startCalling: hi ? '▶  नंबर बोलना शुरू' : '▶  Start the calling',
    youHave: hi ? 'आपके टिकट पर ✓' : 'on your ticket ✓',
    notYours: hi ? 'आपके टिकट पर नहीं' : 'not on your ticket',
    claimChip: hi ? 'मिडिल लाइन का दावा ▸' : 'Claim Middle Line ▸',
    capCalling: hi
      ? 'बॉट एक नंबर बोलता है। जिसके टिकट पर है उसका खाना कट जाता है, बाकी इंतज़ार करते हैं।'
      : 'The bot calls one number. It marks itself on the tickets that have it; the rest simply wait.',
    capClaim: hi
      ? 'मीरा की बीच वाली लाइन पूरी। उन्होंने दावा किया — बॉट ने जाँचा और सबको बता दिया।'
      : "Meera's middle row is complete. She claims it, the bot checks it and tells everybody.",
    watchVideo: hi ? 'पूरा खेल, तीन मिनट में' : 'A whole game, in three minutes',
    watchVideoSub: hi
      ? 'चार फ़ोन एक साथ — रूम खुलने से लेकर इनाम जीतने तक। पूरा वीडियो देखिए: आखिर में हर इनाम और उसका दावा कैसे करना है, यह समझाया गया है।'
      : 'Four phones at once, from opening a room to winning a prize. Watch the whole thing — the six prizes and how to claim them are explained at the end.',
    marked: hi ? 'कट गए' : 'marked',
    called: hi ? 'बोले गए' : 'called',
  };

  const steps = hi
    ? [
        ['WhatsApp पर hi भेजें', 'न ऐप, न खाता, न पासवर्ड।'],
        ['रूम बनाएँ या शामिल हों', 'होस्ट एक लिंक भेजता है, बाकी टैप करके आ जाते हैं।'],
        ['अपना टिकट खोलें', 'हर नंबर पर बताइए वह आपके पास है या नहीं।'],
        ['इनाम का दावा करें', 'लाइन पूरी हुई? दावा कीजिए — सबको पता चल जाएगा।'],
      ]
    : [
        ['Say hi on WhatsApp', 'No app, no account, no password.'],
        ['Start a room or join one', 'The host shares one link; everyone else taps it.'],
        ['Open your ticket', 'For each number, say whether you have it.'],
        ['Claim your prize', 'Line complete? Claim it — everyone is told.'],
      ];

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(t.title)} — ${escapeHtml(env.BRAND_NAME)}</title>
<meta name="description" content="${escapeHtml(t.sub)}">
<link rel="icon" type="image/png" sizes="32x32" href="${apiPath('/public/brand/images/favicon-32.png')}">
<meta name="theme-color" content="${COLOR.maroon}">
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         background: ${COLOR.bg}; color: ${COLOR.ink}; font-size: 16px; line-height: 1.55;
         max-width: 520px; margin: 0 auto; padding: 0 14px 40px; }
  header { background: linear-gradient(135deg, ${COLOR.maroon}, ${COLOR.maroonDark}); color: #fff;
           margin: 0 -14px 16px; padding: 24px 20px 20px; }
  header h1 { margin: 0; font-size: 22px; letter-spacing: .2px; }
  header p { margin: 6px 0 0; opacity: .9; font-size: 14px; }
  .lang { display: inline-block; margin-top: 12px; background: rgba(255,255,255,.16);
          border: 1px solid rgba(255,255,255,.35); color: #fff; border-radius: 999px;
          padding: 6px 14px; font-size: 13px; font-weight: 700; text-decoration: none; }

  .ent { text-align: center; color: #b3122b; background: #fff2f2; border: 1px solid #f3c9cf;
         border-radius: 10px; padding: 9px; font-size: 12.5px; font-weight: 800; margin-bottom: 16px; }

  .card { background: #fff; border-radius: 16px; box-shadow: 0 1px 3px rgba(20,25,35,.08);
          margin-bottom: 16px; overflow: hidden; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .7px; color: ${COLOR.muted};
       margin: 0; padding: 16px 18px 4px; }
  /* A card whose action sits at its heading, so the button is on screen the
     moment the section is — not below content nobody has scrolled past yet. */
  .head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
          padding-right: 14px; }
  .head h2 { padding-right: 0; }
  .play { flex: 0 0 auto; margin-top: 10px; border: 0; border-radius: 999px; padding: 8px 16px;
          background: ${COLOR.green}; color: #fff; font: inherit; font-weight: 700;
          font-size: 13px; cursor: pointer; white-space: nowrap; }
  .play:disabled { opacity: .5; }
  .lede { color: ${COLOR.muted}; font-size: 13.5px; padding: 0 18px 12px; margin: 0; }

  /* ---- the animated round ---- */
  .call { text-align: center; padding: 6px 16px 4px; }
  .call .num { font-size: 54px; font-weight: 800; color: ${COLOR.maroon}; line-height: 1;
               font-variant-numeric: tabular-nums; min-height: 56px; }
  .call .nick { color: ${COLOR.muted}; font-size: 14px; font-style: italic; min-height: 20px; }
  /* The Devanagari form of the number, under the Latin one. Latin stays the
     larger of the two because that is what is printed on the ticket and on the
     real game board — the demo must not teach a player to look for a digit
     shape the board will never show them. */
  .call .alt { font-size: 22px; font-weight: 700; color: ${COLOR.gold}; line-height: 1;
               min-height: 24px; }
  .caller .alt { font-size: 15px; font-weight: 700; opacity: .85; display: block; }
  .call .who { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .7px;
               color: ${COLOR.maroon}; opacity: .75; }
  /* Whether the number was yours is the only thing a player cares about, so it
     is said in words under the ticket rather than left to the colour alone. */
  .call .verdict { font-size: 13px; font-weight: 800; min-height: 20px; margin-top: 4px; }
  .call .verdict.yes { color: ${COLOR.green}; }
  .call .verdict.no { color: ${COLOR.muted}; }
  .call .num.blink { animation: blink .4s steps(1) 4; }
  @keyframes blink { 0%,100% { color: ${COLOR.maroon}; } 50% { color: ${COLOR.gold}; } }

  table.ticket { width: 100%; border-collapse: separate; border-spacing: 3px; padding: 8px 12px 4px; }
  table.ticket td { height: 42px; text-align: center; border-radius: 8px; font-size: 17px;
                    font-weight: 600; background: #fff; border: 1px solid ${COLOR.line};
                    font-variant-numeric: tabular-nums; transition: background .25s, color .25s; }
  table.ticket td.blank { background: #eef1f5; border-color: #eef1f5; }
  table.ticket td.marked { background: ${COLOR.green}; border-color: ${COLOR.green}; color: #fff; }
  table.ticket td.latest { background: ${COLOR.gold}; border-color: ${COLOR.gold}; color: #3a2a00;
                           animation: pop .45s ease; }
  @keyframes pop { 0% { transform: scale(.7); } 60% { transform: scale(1.14); } 100% { transform: scale(1); } }

  .meta { display: flex; justify-content: space-between; padding: 2px 16px 12px;
          color: ${COLOR.muted}; font-size: 12.5px; }
  .run { display: block; width: calc(100% - 32px); margin: 0 16px 16px; padding: 13px;
         border: 0; border-radius: 12px; background: ${COLOR.green}; color: #fff;
         font: inherit; font-weight: 700; font-size: 15.5px; cursor: pointer; }
  .run:disabled { opacity: .5; }

  /* ---- chat transcript ---- */
  .chat { padding: 6px 14px 14px; background: #efe6dc; }
  .b { max-width: 84%; margin: 0 0 8px; padding: 8px 11px; border-radius: 12px; font-size: 14px;
       box-shadow: 0 1px 1px rgba(20,25,35,.09); position: relative; }
  .b.them { background: #fff; border-top-left-radius: 3px; }
  .b.me { background: #d9fdd3; margin-left: auto; border-top-right-radius: 3px; }
  .b.btn { background: #fff; color: #1c8ddb; text-align: center; font-weight: 700;
           border: 1px solid #e3e8ee; border-radius: 10px; max-width: 84%; }
  .b.me.btn { background: #d9fdd3; color: ${COLOR.ink}; }
  .b .who { display: block; font-style: normal; font-size: 11px; font-weight: 700;
            color: ${COLOR.muted}; margin-bottom: 3px; }
  .b.hide { opacity: 0; transform: translateY(8px); }
  .b.show { opacity: 1; transform: none; transition: opacity .28s ease, transform .28s ease; }

  /* ---- four phones ---- */
  .phones { display: flex; gap: 7px; padding: 8px 14px 4px; overflow-x: auto; }
  .phone { flex: 0 0 108px; border: 2px solid ${COLOR.ink}; border-radius: 13px; background: #efe6dc;
           padding: 4px; }
  .phone.host { border-color: ${COLOR.maroon}; }
  .phone .name { font-size: 10.5px; font-weight: 800; text-align: center; color: ${COLOR.muted};
                 padding: 2px 0 4px; }
  .phone.host .name { color: ${COLOR.maroon}; }
  .phone .screen { background: #fff; border-radius: 9px; min-height: 74px; padding: 7px 8px;
                   font-size: 11.5px; line-height: 1.4; }
  .phone .screen.wait { color: ${COLOR.muted}; font-style: italic; }
  .phone .screen.hit { background: #eafaf0; color: #14663a; font-weight: 700; }
  /* the bot's voice, above the four phones */
  .caller { display: flex; align-items: center; gap: 10px; margin: 0 14px 10px; padding: 10px 14px;
            background: ${COLOR.maroon}; color: #fff; border-radius: 12px; }
  .caller .who { font-size: 11px; font-weight: 800; text-transform: uppercase;
                 letter-spacing: .6px; opacity: .75; }
  .caller .n { font-size: 30px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums;
               min-width: 52px; text-align: center; }
  .caller .nk { font-size: 12.5px; font-style: italic; opacity: .9; }
  .caller.speak .n { animation: pop .45s ease; }
  .caller.idle { background: ${COLOR.line}; color: ${COLOR.muted}; }

  .tik { display: grid; grid-template-columns: repeat(9, 1fr); gap: 2px; margin-bottom: 5px; }
  .tik i { aspect-ratio: 1; border-radius: 2px; background: #e6eaf0; }
  .tik i.empty { background: #f4f6f9; }
  .tik i.on { background: ${COLOR.green}; }
  .tik i.just { background: ${COLOR.gold}; animation: pop .45s ease; }
  .stat { font-size: 10.5px; font-weight: 700; color: ${COLOR.muted}; min-height: 26px; }
  .stat.yes { color: #14663a; }
  .stat.claim { color: #fff; background: ${COLOR.gold}; color: #3a2a00; border-radius: 7px;
                padding: 4px 5px; text-align: center; animation: nudge 1s ease infinite; }
  @keyframes nudge { 0%,100% { transform: none; } 50% { transform: translateY(-2px); } }

  .caption { padding: 8px 16px 0; font-size: 13.5px; min-height: 40px; }
  /* The caption is the one line that tells you what just changed, and a line
     that swaps silently is a line nobody notices. It arrives, and the phones
     that actually changed pulse with it. */
  .caption.flash { animation: capIn .45s ease both; }
  @keyframes capIn {
    0%   { opacity: 0; transform: translateY(6px); }
    55%  { opacity: 1; transform: translateY(0); }
    70%  { background: ${COLOR.gold}22; }
    100% { opacity: 1; background: transparent; }
  }
  .phone .screen.bump { animation: bump .5s ease; }
  @keyframes bump {
    0%   { transform: scale(1); box-shadow: 0 0 0 0 ${COLOR.gold}; }
    35%  { transform: scale(1.05); box-shadow: 0 0 0 3px ${COLOR.gold}66; }
    100% { transform: scale(1); box-shadow: 0 0 0 0 transparent; }
  }
  @media (prefers-reduced-motion: reduce) {
    .caption.flash, .phone .screen.bump, table.ticket td.latest, .call .num.blink,
    .caller.speak .n, .tik i.just, .stat.claim {
      animation: none;
    }
  }
  .dots { display: flex; gap: 5px; justify-content: center; padding: 8px 0 0; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: ${COLOR.line}; }
  .dots i.on { background: ${COLOR.maroon}; }

  /* ---- steps ---- */
  ol.steps { margin: 0; padding: 4px 18px 16px 40px; }
  ol.steps li { margin-bottom: 12px; }
  ol.steps b { display: block; font-size: 15px; }
  ol.steps span { color: ${COLOR.muted}; font-size: 13.5px; }

  /* ---- prizes ---- */
  ul.prizes { list-style: none; margin: 0; padding: 4px 14px 14px; }
  ul.prizes li { display: flex; gap: 12px; align-items: center; padding: 10px 4px;
                 border-bottom: 1px solid ${COLOR.line}; }
  ul.prizes li:last-child { border-bottom: 0; }
  ul.prizes .txt b { display: block; font-size: 15px; }
  ul.prizes .txt span { color: ${COLOR.muted}; font-size: 13px; }

  .mini { display: grid; grid-template-columns: repeat(9, 7px); grid-auto-rows: 7px;
          gap: 2px; flex: 0 0 auto; }
  .mini i { background: #dfe4ea; border-radius: 1.5px; }
  .mini i.blank { background: #f4f6f9; }
  .mini i.lit { background: ${COLOR.gold}; }
  .mini.anyfive i:nth-child(1), .mini.anyfive i:nth-child(3),
  .mini.anyfive i:nth-child(12), .mini.anyfive i:nth-child(19),
  .mini.anyfive i:nth-child(23) { background: ${COLOR.gold}; }

  .film { display: block; width: calc(100% - 28px); margin: 4px 14px 16px; border-radius: 12px;
          background: #000; aspect-ratio: 16 / 9; }
  .cta { display: block; text-align: center; padding: 15px; border-radius: 13px;
         background: #25d366; color: #fff; text-decoration: none; font-weight: 800; font-size: 16px; }
  footer { text-align: center; color: ${COLOR.muted}; font-size: 11.5px; margin-top: 16px; }
</style>
</head>
<body>

<header>
  <h1>${escapeHtml(t.title)}</h1>
  <p>${escapeHtml(t.sub)}</p>
  <a class="lang" href="?lang=${hi ? 'en' : 'hi'}">${escapeHtml(t.switch)}</a>
</header>

<p class="ent">${escapeHtml(t.ent)}</p>

<div class="card">
  <h2>${escapeHtml(t.watchVideo)}</h2>
  <p class="lede">${escapeHtml(t.watchVideoSub)}</p>
  <!-- preload="none" with a poster: the page is opened from a chat, often on
       mobile data, and four megabytes nobody asked for is rude. The cover
       image is what they see until they press play. -->
  <video
    class="film"
    controls
    playsinline
    preload="none"
    poster="${apiPath(`/public/media/mastipe-demo${hi ? '-hi' : ''}-cover.png`)}"
    src="${apiPath(`/public/media/mastipe-demo${hi ? '-hi' : ''}.mp4`)}"
  ></video>
</div>

<div class="card">
  <div class="head">
    <h2>${escapeHtml(t.flow)}</h2>
    <button class="play" id="runChat">${escapeHtml(t.playChat)}</button>
  </div>
  <p class="lede">${escapeHtml(t.flowSub)}</p>
  <div class="chat" id="chat">${renderChat(hi ? CHAT_HI : CHAT_EN, true)}</div>
</div>

<div class="card">
  <h2>${escapeHtml(t.room)}</h2>
  <p class="lede">${escapeHtml(t.roomSub)}</p>
  <div class="caller idle" id="caller">
    <span class="n" id="callNum">–</span>
    <span class="alt" id="callAlt"></span>
    <span>
      <span class="who">${escapeHtml(t.botCalling)}</span>
      <span class="nk" id="callNick"></span>
    </span>
  </div>

  <div class="phones">
    ${[t.hostLabel, hi ? 'अमृता' : 'Amruta', hi ? 'रवि' : 'Ravi', hi ? 'मीरा' : 'Meera']
      .map(
        (name, i) => `<div class="phone${i === 0 ? ' host' : ''}">
          <div class="name">${escapeHtml(name)}</div>
          <div class="tik" id="k${i}" hidden></div>
          <div class="screen" id="s${i}"></div>
          <div class="stat" id="v${i}"></div>
        </div>`,
      )
      .join('')}
  </div>
  <p class="caption" id="caption"></p>
  <div class="dots" id="dots"></div>
  <button class="run" id="runSync">${escapeHtml(t.next)}</button>
</div>

<div class="card">
  <div class="head">
    <h2>${escapeHtml(t.watch)}</h2>
    <button class="play" id="run">${escapeHtml(t.play)}</button>
  </div>
  <p class="lede">${escapeHtml(t.watchSub)}</p>

  <div class="call">
    <div class="who" id="whoCalls">${escapeHtml(t.botCalling)}</div>
    <div class="num" id="num">–</div>
    <div class="alt" id="numAlt"></div>
    <div class="nick" id="nick"></div>
    <div class="verdict" id="verdict"></div>
  </div>

  <table class="ticket" id="ticket"></table>

  <div class="meta">
    <span id="markedCount">0 ${escapeHtml(t.marked)}</span>
    <span id="calledCount">0 ${escapeHtml(t.called)}</span>
  </div>
</div>

<div class="card">
  <h2>${escapeHtml(t.steps)}</h2>
  <ol class="steps">
    ${steps.map(([b, s]) => `<li><b>${escapeHtml(b ?? '')}</b><span>${escapeHtml(s ?? '')}</span></li>`).join('')}
  </ol>
</div>

<div class="card">
  <h2>${escapeHtml(t.claim)}</h2>
  <p class="lede">${escapeHtml(t.claimSub)}</p>
  <div class="chat">${renderChat(hi ? CLAIM_HI : CLAIM_EN, false)}</div>
</div>

<div class="card">
  <h2>${escapeHtml(t.prizes)}</h2>
  <p class="lede">${escapeHtml(t.prizesSub)}</p>
  <ul class="prizes">
    ${PRIZES.map(
      (p) => `<li>
        ${miniTicket(p.cells, Boolean(p.anyFive))}
        <span class="txt">
          <b>${escapeHtml(hi ? p.labelHi : p.label)}</b>
          <span>${escapeHtml(hi ? p.whatHi : p.what)}</span>
        </span>
      </li>`,
    ).join('')}
  </ul>
</div>

<a class="cta" href="${whatsappReturnUrl('Hi')}">${escapeHtml(t.cta)}</a>
<footer>${escapeHtml(env.BRAND_NAME)} by ServerPe App Solutions</footer>

<script>
(function () {
  var TICKET = ${JSON.stringify(TICKET)};
  var ORDER = ${JSON.stringify(CALL_ORDER)};
  var NICKS = ${JSON.stringify(
    Object.fromEntries(CALL_ORDER.map((n) => [n, nicknameFor(n) ?? ''])),
  )};
  var LABEL_MARKED = ${JSON.stringify(t.marked)};
  var LABEL_CALLED = ${JSON.stringify(t.called)};
  var LABEL_PLAY = ${JSON.stringify(t.play)};
  var LABEL_AGAIN = ${JSON.stringify(t.again)};

  var SYNC = ${JSON.stringify(hi ? SYNC_HI : SYNC_EN)};
  var ROOM = ${JSON.stringify(ROOM_TICKETS)};
  var CALLS = ${JSON.stringify(ROOM_CALLS)};
  var ROOM_NICKS = ${JSON.stringify(
    Object.fromEntries(ROOM_CALLS.map((n) => [n, nicknameFor(n) ?? ''])),
  )};
  var L = ${JSON.stringify({
    startCalling: t.startCalling,
    youHave: t.youHave,
    notYours: t.notYours,
    claimChip: t.claimChip,
    capCalling: t.capCalling,
    capClaim: t.capClaim,
    marked: t.marked,
    winner: hi ? 'मिडिल लाइन — मीरा ✅' : 'Middle Line — Meera ✅',
  })};
  var LABEL_NEXT = ${JSON.stringify(t.next)};
  var LABEL_AGAIN_SHORT = ${JSON.stringify(t.again)};
  var LABEL_CHAT = ${JSON.stringify(t.playChat)};

  // ---- the chat transcript, revealed one bubble at a time ----
  var chatBubbles = [].slice.call(document.querySelectorAll('#chat .b'));
  var chatBtn = document.getElementById('runChat');
  var chatTimer = null;

  function revealChat(i) {
    if (i >= chatBubbles.length) {
      chatBtn.disabled = false;
      chatBtn.textContent = LABEL_AGAIN_SHORT;
      return;
    }
    chatBubbles[i].classList.add('show');

    // Paced by how much there is to read, not by a fixed tick: a fourteen-word
    // bubble and the word "hi" were getting the same beat, which made the long
    // ones flash past before anyone had finished them. A button chip still
    // gets a shorter pause — it is the bot offering a choice, and the tap that
    // follows should land soon after, or the bot reads as slow.
    var el = chatBubbles[i];
    var words = (el.textContent || '').trim().split(/\s+/).length;
    var pause = el.classList.contains('btn') ? 1050 : Math.min(3100, 1150 + words * 95);
    chatTimer = setTimeout(function () { revealChat(i + 1); }, pause);
  }

  chatBtn.addEventListener('click', function () {
    clearTimeout(chatTimer);
    for (var i = 0; i < chatBubbles.length; i++) chatBubbles[i].classList.remove('show');
    chatBtn.disabled = true;
    chatBtn.textContent = LABEL_CHAT;
    revealChat(0);
  });

  // ---- four phones, stepped by hand ----
  var syncAt = -1;
  var syncBtn = document.getElementById('runSync');
  var dotsEl = document.getElementById('dots');
  for (var d = 0; d < SYNC.length; d++) dotsEl.appendChild(document.createElement('i'));

  function replay(el, cls) {
    el.classList.remove(cls);
    // Reflow, or the browser coalesces the remove and the add and the
    // animation never runs a second time.
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function showSync(i, animate) {
    syncAt = i;
    var frame = SYNC[i];
    for (var p = 0; p < 4; p++) {
      var el = document.getElementById('s' + p);
      var line = frame.screens[p];
      // Only the phones whose screen actually changed should pulse: pulsing
      // all four would say "look here" about the three that did nothing.
      var changed = el.textContent !== line;
      el.textContent = line;
      // Three states worth distinguishing at a glance: still waiting on
      // somebody else, something good just happened, or ordinary news.
      el.className = 'screen' +
        (/^(Invite|Waiting|इंतज़ार|लिंक)/.test(line) ? ' wait' : '') +
        (/(you have it|yours|you won|आपके पास|आपकी|आप जीते|आप अंदर)/.test(line) ? ' hit' : '');
      if (animate && changed) replay(el, 'bump');
    }

    var cap = document.getElementById('caption');
    cap.textContent = frame.caption;
    if (animate) replay(cap, 'flash');
    var dots = dotsEl.children;
    for (var k = 0; k < dots.length; k++) dots[k].className = k === i ? 'on' : '';
    // On the last joining frame the next press starts the bot calling, so the
    // button says so rather than "Next".
    syncBtn.textContent = i === SYNC.length - 1 ? L.startCalling : LABEL_NEXT;
    syncBtn.disabled = false;
  }

  // ---- the calling phase ----
  //
  // Joining is a sequence of decisions, so it is stepped by hand. Calling is
  // not: it is a rhythm, and the whole point is that one number lands on four
  // phones at once and each ticket answers for itself. So the button hands
  // over to a timer here, and the four tickets replace the four text screens.
  var callerEl = document.getElementById('caller');
  var callNum = document.getElementById('callNum');
  var callNick = document.getElementById('callNick');
  var marks = [[], [], [], []];
  var callTimer = null;

  function ticketCells(p) {
    return document.getElementById('k' + p).children;
  }

  function buildTickets() {
    for (var p = 0; p < 4; p++) {
      var host = document.getElementById('k' + p);
      host.innerHTML = '';
      for (var r = 0; r < 3; r++) {
        for (var c = 0; c < 9; c++) {
          var cell = document.createElement('i');
          if (ROOM[p][r][c] === null) cell.className = 'empty';
          host.appendChild(cell);
        }
      }
    }
  }

  function enterCallPhase() {
    buildTickets();
    for (var p = 0; p < 4; p++) {
      marks[p] = [];
      document.getElementById('k' + p).hidden = false;
      document.getElementById('s' + p).hidden = true;
      document.getElementById('v' + p).textContent = '';
      document.getElementById('v' + p).className = 'stat';
    }
    callerEl.classList.remove('idle');
    document.getElementById('caption').textContent = L.capCalling;
    syncBtn.disabled = true;
    call(0);
  }

  function call(i) {
    if (i >= CALLS.length) return claim();

    var n = CALLS[i];
    callNum.textContent = n;
    document.getElementById('callAlt').textContent = DEVANAGARI ? dev(n) : '';
    callNick.textContent = ROOM_NICKS[n] || '';
    replay(callerEl, 'speak');

    for (var p = 0; p < 4; p++) {
      var found = -1;
      for (var r = 0; r < 3 && found < 0; r++) {
        var c = ROOM[p][r].indexOf(n);
        if (c >= 0) found = r * 9 + c;
      }

      var cells = ticketCells(p);
      // Last call's gold fades to green, so only the newest mark is highlighted.
      for (var k = 0; k < cells.length; k++) {
        if (cells[k].className === 'just') cells[k].className = 'on';
      }

      var stat = document.getElementById('v' + p);
      if (found >= 0) {
        cells[found].className = 'just';
        marks[p].push(n);
        stat.textContent = fmt(n) + ' ' + L.youHave + ' · ' + fmt(marks[p].length) + ' ' + L.marked;
        stat.className = 'stat yes';
      } else {
        stat.textContent = L.notYours;
        stat.className = 'stat';
      }
    }

    callTimer = setTimeout(function () { call(i + 1); }, 1250);
  }

  function claim() {
    // Meera is the fourth phone, and her middle row is what the last call
    // completed — the claim is offered to her alone, then announced to all.
    var her = document.getElementById('v3');
    her.textContent = L.claimChip;
    her.className = 'stat claim';
    document.getElementById('caption').textContent = L.capClaim;

    callTimer = setTimeout(function () {
      for (var p = 0; p < 4; p++) {
        var stat = document.getElementById('v' + p);
        stat.textContent = L.winner;
        stat.className = 'stat yes';
      }
      callerEl.classList.add('idle');
      callNum.textContent = '–';
      document.getElementById('callAlt').textContent = '';
      callNick.textContent = '';
      syncBtn.disabled = false;
      syncBtn.textContent = LABEL_AGAIN_SHORT;
    }, 2200);
  }

  function resetPhones() {
    clearTimeout(callTimer);
    callerEl.classList.add('idle');
    callNum.textContent = '–';
    document.getElementById('callAlt').textContent = '';
    callNick.textContent = '';
    for (var p = 0; p < 4; p++) {
      document.getElementById('k' + p).hidden = true;
      document.getElementById('s' + p).hidden = false;
      document.getElementById('v' + p).textContent = '';
      document.getElementById('v' + p).className = 'stat';
    }
  }

  syncBtn.addEventListener('click', function () {
    // Past the last joining frame the button stops stepping and starts the
    // calling; pressing it again afterwards takes the room from the top.
    if (syncAt >= SYNC.length - 1) {
      if (syncBtn.textContent === LABEL_AGAIN_SHORT) {
        resetPhones();
        showSync(0, true);
        return;
      }
      enterCallPhase();
      return;
    }
    showSync(syncAt + 1, true);
  });

  showSync(0, false);

  var DEVANAGARI = ${hi ? 'true' : 'false'};

  /**
   * The same number in Devanagari digits.
   *
   * Shown beside the Latin form on the Hindi page rather than instead of it:
   * plenty of readers are quicker with one and plenty with the other, and the
   * ticket itself is printed in Latin.
   */
  function dev(n) {
    return String(n).replace(/[0-9]/g, function (d) { return '०१२३४५६७८९'.charAt(+d); });
  }

  /** A count as the reader of this page counts. */
  function fmt(n) {
    return DEVANAGARI ? dev(n) : String(n);
  }

  var called = [];
  var timer = null;
  var runBtn = document.getElementById('run');

  function draw(latest) {
    var html = '';
    for (var r = 0; r < 3; r++) {
      html += '<tr>';
      for (var c = 0; c < 9; c++) {
        var v = TICKET[r][c];
        if (v === null) { html += '<td class="blank"></td>'; continue; }
        var cls = v === latest ? 'latest' : (called.indexOf(v) >= 0 ? 'marked' : '');
        html += '<td class="' + cls + '">' + v + '</td>';
      }
      html += '</tr>';
    }
    document.getElementById('ticket').innerHTML = html;

    var mine = 0;
    for (var i = 0; i < called.length; i++) {
      for (var rr = 0; rr < 3; rr++) if (TICKET[rr].indexOf(called[i]) >= 0) mine++;
    }
    document.getElementById('markedCount').textContent = fmt(mine) + ' ' + LABEL_MARKED;
    document.getElementById('calledCount').textContent = fmt(called.length) + ' ' + LABEL_CALLED;
  }

  function step(i) {
    if (i >= ORDER.length) {
      runBtn.disabled = false;
      runBtn.textContent = LABEL_AGAIN;
      return;
    }
    var n = ORDER[i];
    called.push(n);

    var numEl = document.getElementById('num');
    numEl.textContent = n;
    document.getElementById('numAlt').textContent = DEVANAGARI ? dev(n) : '';
    numEl.classList.remove('blink');
    // Reflow, so the animation restarts on every number rather than only once.
    void numEl.offsetWidth;
    numEl.classList.add('blink');
    document.getElementById('nick').textContent = NICKS[n] || '';

    // Every ticket in this demo is the same one, so the verdict is simply
    // whether the called number is on it — which is exactly the judgement a
    // player makes on every call.
    var mine = false;
    for (var rr = 0; rr < 3; rr++) if (TICKET[rr].indexOf(n) >= 0) mine = true;
    var verdict = document.getElementById('verdict');
    verdict.textContent = mine ? L.youHave : L.notYours;
    verdict.className = 'verdict ' + (mine ? 'yes' : 'no');

    draw(n);
    timer = setTimeout(function () { step(i + 1); }, 1100);
  }

  runBtn.addEventListener('click', function () {
    clearTimeout(timer);
    called = [];
    runBtn.disabled = true;
    document.getElementById('verdict').textContent = '';
    draw(null);
    step(0);
  });

  draw(null);
})();
</script>
</body>
</html>`;
}
