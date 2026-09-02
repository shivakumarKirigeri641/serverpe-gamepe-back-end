/**
 * How to play, as one page.
 *
 * Served by the API rather than rebuilt on the marketing site, so there is one
 * explanation of the rules instead of two that drift apart. The same URL is
 * what the bot sends when somebody picks "How to play" from the menu, and what
 * the website's Demo link points at.
 *
 * It shows a real generated ticket and walks a few numbers across it, because
 * "five in a row wins the top line" is much easier to see than to read.
 */
import { config } from '../config/env.js';
import { generateTicket } from '../games/tambola/ticket.js';
import { makeRng } from '../utils/random.js';
import { CLAIMS } from '../games/tambola/claims.js';
import { taglineFor } from '../games/tambola/taglines.js';
import { walkthrough } from './demo-walkthrough.js';

export function demoPage({ lang = 'en' } = {}) {
  // A fixed seed: everyone who opens the page sees the same ticket, so a
  // screenshot in a support conversation matches what the next person sees.
  const ticket = generateTicket(makeRng(20260101));
  const hi = lang === 'hi';

  // The walk-through calls the top row in order, so Top Line completes on cue.
  const script = [...ticket.grid[0], 42, 17, 63].filter((n) => n !== null);

  const wt = walkthrough();

  const data = JSON.stringify({
    ticket, script, hi,
    brand: config.brandName,
    wa: config.whatsapp.businessNumber,
    // Served from src/media by express.static, which answers Range requests -
    // without those a phone cannot seek, and some browsers refuse to start at
    // all. The poster is what shows before anything is downloaded, so the page
    // is never a black rectangle on a slow connection.
    video: `${config.publicRoot}/public/media/${hi ? 'mastipe-demo-hi.mp4' : 'mastipe-demo.mp4'}`,
    poster: `${config.publicRoot}/public/media/${hi ? 'mastipe-demo-hi-cover.png' : 'mastipe-demo-cover.png'}`,
    interval: config.game.drawIntervalSeconds,
    maxPlayers: config.game.maxPlayers,
    prizes: CLAIMS.map((c) => ({ key: c.key, label: c.label, hint: c.hint })),
    taglines: Object.fromEntries(script.map((n) => [n, taglineFor(n)])),
  });

  return `<!doctype html>
<html lang="${hi ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16151a">
<title>${esc(config.brandName)} — ${hi ? 'कैसे खेलें' : 'How to play'}</title>
<style>
:root{
  --ink:#2b2118; --paper:#f4ecd8; --maroon:#8b1e3f; --maroon-deep:#5c0f2b; --gold:#d4a537;
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5; --ok:#10b981;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:18px 14px 80px}
/* 16:9 with a black ground, so a portrait phone shows letterboxing rather
   than a jumping layout while the first frame loads. */
.demo{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;display:block}
h1{font-size:26px;margin:0 0 4px;color:var(--gold);letter-spacing:-.01em}
h2{font-size:16px;margin:0 0 10px;color:var(--gold)}
.lede{color:var(--dim);margin:0 0 20px}
.langrow{display:flex;justify-content:flex-end;margin-bottom:4px}
.lang{color:var(--gold);font-size:13px;text-decoration:none;border:1px solid var(--line);
  border-radius:999px;padding:5px 12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.step{display:flex;gap:12px;padding:11px 0;border-top:1px solid var(--line)}
.step:first-of-type{border-top:0}
.step .n{width:26px;height:26px;border-radius:50%;background:var(--maroon);color:#fff;
  display:grid;place-items:center;font:700 13px system-ui;flex:none}
.step .t{font-size:14.5px}
.step .t b{color:var(--text)}
.muted{color:var(--dim);font-size:14px}

/* the live demo */
.callout{background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border-radius:14px;padding:14px;text-align:center}
.callout .num{font:800 54px/1 ui-rounded,system-ui;color:#fff}
.callout .tag{color:#f7dfa5;font-size:13px;margin-top:5px;min-height:1.3em}
.ticket{background:var(--paper);border-radius:4px;margin:12px 0;overflow:hidden}
table{border-collapse:collapse;width:100%;table-layout:fixed}
td{border:1px solid rgba(139,30,63,.45);height:46px;text-align:center;position:relative;
  font:600 19px/1 Georgia,serif;color:var(--ink)}
td.blank{background:repeating-linear-gradient(45deg,transparent,transparent 5px,
  rgba(139,30,63,.055) 5px,rgba(139,30,63,.055) 10px)}
td.marked::after{content:"";position:absolute;inset:50% auto auto 50%;width:36px;height:36px;
  margin:-18px 0 0 -18px;border-radius:50%;
  background:radial-gradient(circle at 36% 32%,rgba(16,185,129,.78),rgba(4,120,87,.62) 70%);
  animation:stamp .3s cubic-bezier(.2,1.6,.4,1)}
@keyframes stamp{0%{transform:scale(.2);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
td.marked{color:#06301f;font-weight:700}
tr.win td{box-shadow:inset 0 0 0 2px var(--gold)}
.win-note{text-align:center;color:var(--gold);font-weight:700;min-height:1.5em;margin-top:6px}
.btn{display:block;width:100%;padding:14px;border-radius:12px;border:0;cursor:pointer;
  font:700 15px system-ui;background:var(--gold);color:#2b2118;text-align:center;
  text-decoration:none;margin-top:10px}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.prizes{list-style:none;padding:0;margin:0}
.prizes li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.prizes li:first-child{border-top:0}
.prizes b{color:var(--gold);flex:none;width:96px}
${wt.css}
.prizes span{color:var(--dim)}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
(function(){
  "use strict";
  var d = ${data};
  var WT_HTML = ${JSON.stringify(wt.html)};
  var T = d.hi ? {
    title:'कैसे खेलें', lede:'तंबोला, सीधे व्हाट्सएप पर। कोई ऐप नहीं।',
    steps:'तीन चरणों में', watch:'देखिए यह कैसे चलता है', prizes:'छह इनाम',
    play:'अभी खेलें', replay:'फिर से देखें', ready:'तैयार?',
    video:'डेमो देखिए', videoNote:'आवाज़ चालू करके देखें।'
  } : {
    title:'How to play', lede:'Tambola, right on WhatsApp. No app to install.',
    steps:'Three steps', watch:'Watch how it works', prizes:'Six prizes',
    play:'Play now on WhatsApp', replay:'Watch again', ready:'Ready?',
    video:'Watch the demo', videoNote:'Best with sound on.'
  };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  var steps = d.hi ? [
    ['व्हाट्सएप पर <b>hi</b> भेजें','मेन्यू से Play Tambola चुनें और खिलाड़ियों की संख्या बताएं।'],
    ['लिंक दोस्तों को भेजें','वे टैप करते हैं, शर्तें स्वीकार करते हैं, और अंदर आ जाते हैं।'],
    ['खेल शुरू करें','हर ' + d.interval + ' सेकंड में एक नंबर। अपनी टिकट पर निशान लगाएं।'],
  ] : [
    ['Message <b>hi</b> on WhatsApp','Pick <b>Play Tambola</b> from the menu and say how many are playing — up to ' + d.maxPlayers + '.'],
    ['Share the link with your friends','They tap it, accept the terms, and they are in. Everyone gets their own ticket.'],
    ['Tap Start','A number every ' + d.interval + ' seconds. Mark your own ticket, and claim a prize the moment you spot one.'],
  ];

  var h = '';
  // A language switch on the page itself, not only on the marketing site.
  //
  // The bot has no notion of a player's language - players.locale exists but
  // WhatsApp does not reliably tell us - so the link it sends is always the
  // English one. Without this, a Hindi speaker arriving from WhatsApp has no
  // route to the Hindi video at all. One tap solves it for everybody, whichever
  // link they came in on.
  h += '<div class="langrow">' +
    '<a class="lang" href="?lang=' + (d.hi ? 'en' : 'hi') + '">' +
    (d.hi ? 'View in English' : 'हिंदी में देखें') + '</a></div>';

  h += '<h1>' + T.title + '</h1><p class="lede">' + T.lede + '</p>';

  // The video leads, because it is the fastest way to understand the game -
  // the written steps below are for anyone who would rather read, or who is
  // somewhere they cannot play sound.
  h += '<div class="card"><h2>' + T.video + '</h2>' +
    '<video class="demo" controls preload="none" playsinline ' +
      'poster="' + esc(d.poster) + '">' +
      '<source src="' + esc(d.video) + '" type="video/mp4">' +
    '</video>' +
    '<div class="muted" style="font-size:12.5px;margin-top:8px">' + T.videoNote + '</div>' +
  '</div>';

  h += '<div class="card"><h2>' + T.steps + '</h2>' +
    steps.map(function(s,i){
      return '<div class="step"><div class="n">' + (i+1) + '</div>' +
        '<div class="t"><b>' + s[0] + '</b><br><span class="muted">' + s[1] + '</span></div></div>';
    }).join('') + '</div>';

  h += '<div class="card"><h2>' + T.watch + '</h2>' +
    WT_HTML + '</div>';

  h += '<div class="card"><h2>' + T.prizes + '</h2><ul class="prizes">' +
    d.prizes.map(function(p){
      return '<li><b>' + esc(p.label) + '</b><span>' + esc(p.hint) + '</span></li>';
    }).join('') + '</ul></div>';

  h += '<div class="card"><h2>' + T.ready + '</h2>' +
    '<a class="btn" href="https://wa.me/' + esc(d.wa) + '?text=hi">' + T.play + '</a></div>';

  document.getElementById('app').innerHTML = h;

// Runs inside this scope on purpose: the walkthrough reads the same d object the
// rest of the page does, so the ticket it animates is the ticket shown above
// and the prize it lights up is a real prize key. Its own body is wrapped in
// an IIFE, so nothing leaks either way.
${wt.js}

})();
</script>
</body>
</html>`;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
