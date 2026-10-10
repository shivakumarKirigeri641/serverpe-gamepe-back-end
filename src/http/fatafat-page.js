/**
 * Fatafat: the page a player actually plays on.
 *
 * One self-contained document - lobby, play and report - for the same reason
 * the tambola board is one: a player on a patchy connection should download
 * the game once and never again mid-round. There is no framework and no build
 * step; the whole thing is a string this module returns.
 *
 * ── What the page is not allowed to know ──────────────────────────────────
 *
 * It never receives the correct answer before the player has answered. The
 * server hands out one question at a time, judges the tap, and only then says
 * what was right. Anyone opening devtools finds the question they are already
 * looking at and nothing else.
 *
 * ── Why the options get shuffled on arrival ───────────────────────────────
 *
 * Correctness is defined by an option's TEXT, never by its slot, so the page
 * is free to display the three in any order as long as it maps a tap back to
 * the server's ordering. Two things fall out of that: everybody's screen is
 * different, so a screenshot of "tap the middle one" is worthless; and the
 * mid-question shuffle - the twist - costs nothing to implement because the
 * mapping already exists.
 *
 * ── The twist, and the grace window ───────────────────────────────────────
 *
 * On one question a round, the options slide into new positions while the
 * player is deciding. A tap that lands within GRACE_MS of that shuffle is
 * judged against the OLD layout. Without that, a thumb already travelling
 * toward the right answer is punished for a decision that was correct when it
 * was made - which does not read as a prank, it reads as cheating, and it is
 * the difference between "do that again" and uninstalling.
 */
import { config } from '../config/env.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fatafatPage({ token, playerName, questionCount, timeLimitMs, apiBase, waNumber, stats, feedbackUrl, roundStatus, doc, lang, ui, supportUrl }) {
  const hi = lang === 'hi';
  const returning = stats && stats.rounds > 0;
  // Reopening a link for a round already played is a normal thing to do -
  // people revisit a score to show somebody. The lobby has to offer the
  // report rather than a Play button that quietly leads to it.
  const spent = roundStatus && roundStatus !== 'open';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="theme-color" content="#16151a">
<title>Tap Bakra — ${esc(config.brandName)}</title>
<style>
${css()}
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <span class="brand">${esc(config.brandName)}</span>
    <span class="game">Tap Bakra</span>
    <button id="lang" class="icon lang" aria-label="Language">${hi ? 'EN' : 'हिं'}</button>
    <button id="mute" class="icon" aria-label="Sound on or off">🔊</button>
  </header>

  <!-- ── lobby ─────────────────────────────────────────────────────────── -->
  <section id="lobby" class="screen">
    <div class="hero">
      <h1>Tap Bakra</h1>
      <p class="tag">${hi ? 'तेज़ी से टैप करें। बकरा मत बनिए।' : "Tap fast. Don't be the bakra."}</p>
    </div>

${returning ? dashboardHtml(stats, playerName, hi) : `    <ol class="rules">
      ${hi
        ? '<li><b>निर्देश पढ़िए।</b> हर बार बदलता है।</li>' +
          '<li><b>सही वाले पर टैप कीजिए</b> — घड़ी खत्म होने से पहले।</li>' +
          '<li><b>कभी-कभी सही जवाब होता है कुछ भी न छूना।</b> ध्यान से पढ़िए।</li>'
        : '<li><b>Read the instruction.</b> It changes every time.</li>' +
          '<li><b>Tap the right one</b> before the clock runs out.</li>' +
          '<li><b>Sometimes the answer is to tap nothing at all.</b> Read carefully.</li>'}
    </ol>`}

    <p class="fineprint">
      ${hi
        ? `${questionCount} सवाल · हर एक ${(timeLimitMs / 1000).toFixed(0)} सेकंड · कुल लगभग एक मिनट`
        : `${questionCount} questions · ${(timeLimitMs / 1000).toFixed(0)} seconds each · about a minute in total`}
    </p>

    ${spent
      ? '<button id="freshRound" class="primary">Play a new round</button>' +
        '<button id="begin" class="ghost">See that round&rsquo;s report</button>'
      : '<button id="begin" class="primary">' +
        (hi ? (returning ? 'खेलें' : 'तैयार हूँ') : (returning ? 'Play' : "I'm ready")) + '</button>'}

    <div class="tiles" id="tiles"></div>
  </section>

  <!-- ── the menu, under the Play button ───────────────────────────────── -->
  <section id="menu" class="screen hidden"></section>

  <!-- ── countdown ─────────────────────────────────────────────────────── -->
  <section id="countdown" class="screen hidden">
    <div class="count" id="countNum">3</div>
    <p class="countHint">${hi ? 'अंगूठा तैयार रखिए' : 'Get your thumb ready'}</p>
  </section>

  <!-- ── play ──────────────────────────────────────────────────────────── -->
  <section id="play" class="screen hidden">
    <div class="pips" id="pips"></div>

    <div class="qhead">
      <span class="qno" id="qno">1 / ${questionCount}</span>
      <span class="score" id="score">0</span>
    </div>

    <div class="clockrow">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="bg" cx="60" cy="60" r="52"></circle>
        <circle class="fg" id="ringFg" cx="60" cy="60" r="52"
                transform="rotate(-90 60 60)"></circle>
      </svg>
      <div class="clockface">
        <div class="ms" id="clock">5.000</div>
        <div class="mslabel">${hi ? 'सेकंड बचे' : 'seconds left'}</div>
      </div>
    </div>

    <p class="instruction" id="instruction">&nbsp;</p>
    <p class="tapshint" id="tapsHint">&nbsp;</p>

    <div class="options" id="options"></div>

    <div class="verdict" id="verdict"></div>
  </section>

  <!-- ── report ────────────────────────────────────────────────────────── -->
  <section id="report" class="screen hidden"></section>

</div>

<script>
window.__FF__ = ${JSON.stringify({
    token, playerName, questionCount, timeLimitMs, apiBase, waNumber, stats, feedbackUrl,
    spent, doc, lang, ui, supportUrl,
  })};
${js()}
</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Styles. Same palette as the tambola board so the two games feel like one
   product, with a louder, faster personality on top of it.
   ───────────────────────────────────────────────────────────────────────── */
function css() {
  return `
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --maroon:#8b1e3f; --maroon-deep:#5c0f2b; --gold:#d4a537;
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5;
  --good:#3f9d6d; --good-soft:rgba(63,157,109,.16);
  --bad:#c04b4b;  --bad-soft:rgba(192,75,75,.16);
}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--text);
  font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  overscroll-behavior:none;
}
.wrap{max-width:520px;margin:0 auto;padding:10px 14px 28px;
  min-height:100%;display:flex;flex-direction:column}

.top{display:flex;align-items:center;gap:10px;padding:6px 2px 12px}
.brand{font-weight:800;letter-spacing:.02em;color:var(--gold)}
.game{font-size:12px;color:var(--dim);border:1px solid var(--line);
  padding:3px 8px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase}
.icon{background:none;border:1px solid var(--line);border-radius:8px;
  color:var(--text);font-size:14px;line-height:1;padding:6px 9px;cursor:pointer}
.lang{margin-left:auto;font-weight:700;font-size:12px;min-width:38px}
/* Language is a lobby decision. Offering it mid-question would mean serving
   that question again, which hands back a full clock every time it is tapped. */
body.playing .lang{visibility:hidden}

.screen{flex:1;display:flex;flex-direction:column}
.hidden{display:none !important}

/* ── lobby ─────────────────────────────────────────────────────────────── */
.hero{text-align:center;padding:26px 0 10px}
.hero h1{
  margin:0;font-size:40px;line-height:1.05;letter-spacing:-.02em;
  background:linear-gradient(100deg,var(--gold),#f0d089 55%,var(--gold));
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.tag{margin:6px 0 0;color:var(--dim);font-size:15px}
.rules{margin:24px 0 0;padding:0 0 0 20px;color:var(--dim);font-size:15px}
.rules li{margin:10px 0}
.rules b{color:var(--text)}
.fineprint{margin:22px 0 0;text-align:center;font-size:13px;color:var(--dim)}
.primary{
  margin-top:auto;width:100%;padding:16px;border:0;border-radius:14px;cursor:pointer;
  background:linear-gradient(180deg,var(--maroon),var(--maroon-deep));
  color:#fff;font:800 17px system-ui;letter-spacing:.01em;
  box-shadow:0 6px 20px rgba(139,30,63,.35);
}
.primary:active{transform:translateY(1px)}
.ghost{
  width:100%;padding:14px;border:1px solid var(--line);border-radius:14px;cursor:pointer;
  background:transparent;color:var(--text);font:700 15px system-ui;margin-top:10px;
}

/* ── the returning player's record ─────────────────────────────────────── */
.dash{margin:20px 0 0}
.dashline{text-align:center;font-size:13px;color:var(--dim);margin:0 0 12px}
.dashline b{color:var(--text)}
.spark{margin-top:14px;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:12px}
.spark h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
.spark svg{width:100%;height:52px;display:block;overflow:visible}
.spark .ln{fill:none;stroke:var(--gold);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.spark .dot{fill:var(--gold)}
.spark .last{fill:var(--good)}
.rules details{margin-top:14px}
.howto{margin-top:16px;border-top:1px solid var(--line);padding-top:12px}
.howto summary{cursor:pointer;font-size:13px;color:var(--dim);list-style:none}
.howto summary::-webkit-details-marker{display:none}
.howto summary:before{content:'▸ ';color:var(--gold)}
.howto[open] summary:before{content:'▾ '}
.howto ol{margin:10px 0 0;padding-left:20px;color:var(--dim);font-size:14px}
.howto b{color:var(--text)}

/* ── the game-room menu ────────────────────────────────────────────────── */
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}
.tile{
  display:flex;align-items:center;gap:9px;text-align:left;text-decoration:none;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:12px 11px;color:var(--text);font:600 13px system-ui;cursor:pointer;
}
.tile .ic{font-size:17px;line-height:1;flex:none}
.tile .tx{min-width:0}
.tile .sub{display:block;font-weight:400;font-size:11px;color:var(--dim);margin-top:1px}
.tile:active{transform:translateY(1px)}
.tile[disabled]{opacity:.5;cursor:default}
.tile[disabled] .sub{color:var(--gold)}

/* A panel opened from a tile. Same page - nobody should lose their place in a
   game room to read one number. */
.panel{padding-top:4px}
.panel .bar{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.panel h2{margin:0;font-size:17px}
.panel .back{margin-left:auto;background:none;border:1px solid var(--line);
  border-radius:8px;color:var(--text);font:600 12px system-ui;padding:7px 11px;cursor:pointer}

.rlist{list-style:none;margin:0;padding:0}
.rlist li{border-top:1px solid var(--line)}
.rlist li:first-child{border-top:0}
.rlist a{display:flex;align-items:center;gap:10px;padding:11px 2px;
  text-decoration:none;color:var(--text)}
.rlist .sc{font:800 17px ui-monospace,Menlo,monospace;color:var(--gold);
  min-width:48px;font-variant-numeric:tabular-nums}
.rlist .mid{flex:1;min-width:0}
.rlist .when{font-size:12px;color:var(--dim)}
.rlist .go{color:var(--dim);font-size:16px}

.bars{margin:0;padding:0;list-style:none}
.bars li{margin:9px 0}
.bars .top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
.bars .top b{font-variant-numeric:tabular-nums}
.bars .track{height:7px;background:var(--line);border-radius:4px;overflow:hidden}
.bars .fill{height:100%;background:var(--good);border-radius:4px}
.bars .fill.mid{background:var(--gold)}
.bars .fill.low{background:var(--bad)}

/* ── countdown ─────────────────────────────────────────────────────────── */
#countdown{align-items:center;justify-content:center}
.count{
  font:900 120px/1 system-ui;color:var(--gold);
  animation:pop .6s ease-out;
}
@keyframes pop{from{transform:scale(.4);opacity:0}60%{transform:scale(1.12)}to{transform:scale(1);opacity:1}}
.countHint{color:var(--dim);margin-top:10px}

/* ── play ──────────────────────────────────────────────────────────────── */
.pips{display:flex;gap:5px;justify-content:center;margin:2px 0 14px}
.pip{height:4px;flex:1;max-width:34px;border-radius:2px;background:var(--line);transition:background .25s}
.pip.ok{background:var(--good)}
.pip.no{background:var(--bad)}
.pip.now{background:var(--gold)}

.qhead{display:flex;align-items:baseline;justify-content:space-between;
  font-size:13px;color:var(--dim);margin-bottom:8px}
.score{font:800 18px ui-monospace,Menlo,monospace;color:var(--gold)}

.clockrow{position:relative;display:flex;align-items:center;justify-content:center;height:132px}
.ring{position:absolute;width:132px;height:132px}
.ring .bg{fill:none;stroke:var(--line);stroke-width:7}
.ring .fg{fill:none;stroke:var(--gold);stroke-width:7;stroke-linecap:round;
  stroke-dasharray:326.7;stroke-dashoffset:0}
.ring.urgent .fg{stroke:var(--bad)}
.clockface{text-align:center}
.ms{font:800 30px/1 ui-monospace,Menlo,monospace;color:var(--text);
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.ms.urgent{color:var(--bad)}
.mslabel{font-size:11px;color:var(--dim);margin-top:3px;letter-spacing:.06em;text-transform:uppercase}

.instruction{
  text-align:center;font:800 24px/1.25 system-ui;margin:16px 0 2px;min-height:2.5em;
  display:flex;align-items:center;justify-content:center;
}
.instruction .warn{color:var(--bad)}
.tapshint{text-align:center;font-size:13px;color:var(--dim);margin:0 0 12px;min-height:1.3em}

.options{display:grid;gap:10px}
/* The options sit in the middle of what is left, so a three-option question
   does not float at the top of a tall phone with a void beneath it. */
#play .instruction{margin-top:auto}
#play .verdict{margin-bottom:auto}
.opt{
  position:relative;padding:20px 14px;border-radius:14px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--text);
  font:800 20px system-ui;letter-spacing:.01em;
  transition:transform .28s cubic-bezier(.2,.8,.3,1),background .15s,border-color .15s;
}
.opt:active{transform:scale(.985)}
.opt.picked{border-color:var(--gold);background:rgba(212,165,55,.12)}
.opt.right{border-color:var(--good);background:var(--good-soft)}
.opt.wrong{border-color:var(--bad);background:var(--bad-soft)}
.opt[disabled]{cursor:default}
/* The shuffle: the options physically travel, so it reads as mischief rather
   than as a rendering glitch. */
.options.shuffling .opt{transition:transform .38s cubic-bezier(.34,1.3,.44,1)}

/*
 * The laugh.
 *
 * Emoji burst outward from the middle of the board and tumble away over a
 * second. Pointer events are off throughout: the joke must never eat the tap
 * that starts the next question.
 */
.laugh{position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden}
.laugh span{
  position:absolute;left:50%;top:46%;
  font-size:34px;line-height:1;will-change:transform,opacity;
  animation:fly 1s cubic-bezier(.18,.7,.35,1) forwards;
}
@keyframes fly{
  0%  {transform:translate(-50%,-50%) scale(.3) rotate(0deg);opacity:0}
  18% {transform:translate(calc(-50% + var(--x) * .35),calc(-50% + var(--y) * .35)) scale(1.15) rotate(var(--r));opacity:1}
  100%{transform:translate(calc(-50% + var(--x)),calc(-50% + var(--y))) scale(.85) rotate(calc(var(--r) * 2.4));opacity:0}
}
/* The board itself flinches once, which sells the joke more than the emoji do. */
.shake{animation:shake .42s cubic-bezier(.36,.07,.19,.97)}
@keyframes shake{
  10%,90%{transform:translateX(-2px)}
  20%,80%{transform:translateX(4px)}
  30%,50%,70%{transform:translateX(-7px)}
  40%,60%{transform:translateX(7px)}
}
@media (prefers-reduced-motion:reduce){
  /* Somebody who has asked their phone to stop moving things should not be
     shaken by a game. They still get the sound and the verdict. */
  .laugh span{animation:fadeonly 1s ease-out forwards}
  .shake{animation:none}
  @keyframes fadeonly{0%{opacity:0}20%{opacity:1}100%{opacity:0}}
}

.verdict{min-height:52px;margin-top:14px;text-align:center;font-weight:700}
.verdict .big{font-size:20px}
.verdict .sub{display:block;font-weight:500;font-size:13px;color:var(--dim);margin-top:3px}
.verdict.good .big{color:var(--good)}
.verdict.bad .big{color:var(--bad)}

/* ── the document wrapper ──────────────────────────────────────────────── */
/*
 * Print furniture. Hidden on screen and restored inside the print block below,
 * because a phone already knows whose report it is looking at - and this used
 * to push the score itself off the first screen.
 */
.masthead,.parties,.docfoot{display:none}

/* What the screen gets instead: the reference and the time, on one line. */
.docline{
  display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;
  font:11px ui-monospace,Menlo,monospace;color:var(--dim);
  padding:2px 0 10px;letter-spacing:.02em;
}
.docline .ref{color:var(--text)}

.masthead{align-items:flex-start;gap:12px;padding:0 0 12px;
  border-bottom:1px solid var(--line);margin-bottom:14px}
.masthead .mark{flex:none;height:26px;width:auto}
.masthead .who{flex:1;min-width:0}
.masthead .issuer{font:800 14px system-ui;color:var(--text)}
.masthead .sub{font-size:11px;color:var(--dim);margin-top:1px}
.masthead .doctype{text-align:right;flex:none}
.masthead .doctype .t{font:800 12px system-ui;letter-spacing:.08em;
  text-transform:uppercase;color:var(--gold)}
.masthead .doctype .r{font:600 10px ui-monospace,Menlo,monospace;color:var(--dim);margin-top:3px}

.parties{grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.party{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 11px}
.party h4{margin:0 0 6px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.party dl{margin:0;font-size:12px}
.party .r{display:flex;justify-content:space-between;gap:8px;padding:1.5px 0}
.party .r dt{color:var(--dim);flex:none}
.party .r dd{margin:0;text-align:right;font-weight:600;
  overflow-wrap:anywhere;font-variant-numeric:tabular-nums}

.docfoot{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);
  font-size:11px;color:var(--dim);line-height:1.5}
.docfoot b{color:var(--text)}
.docfoot .cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.docfoot .legal{margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)}

/* ── report ────────────────────────────────────────────────────────────── */
.rhead{text-align:center;padding:8px 0 4px}
.rhead .big{font:900 54px/1 system-ui;color:var(--gold);font-variant-numeric:tabular-nums}
.rhead .of{color:var(--dim);font-size:13px;margin-top:4px}
.rhead h2{margin:10px 0 0;font-size:20px}
.grade{display:inline-block;margin-top:8px;padding:5px 14px;border-radius:999px;
  font:800 13px system-ui;letter-spacing:.06em;text-transform:uppercase}

.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:9px;margin:18px 0}
@media(min-width:420px){.kpis{grid-template-columns:repeat(4,1fr)}}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:11px}
.kpi .v{font:800 20px ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.kpi .k{font-size:11px;color:var(--dim);margin-top:2px;letter-spacing:.04em}
.kpi.good .v{color:var(--good)}
.kpi.bad .v{color:var(--bad)}
.kpi.gold .v{color:var(--gold)}

.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:14px;margin:12px 0}
.card h3{margin:0 0 10px;font-size:14px;letter-spacing:.02em}
.card .note{font-size:12px;color:var(--dim);margin:10px 0 0}

.chart{width:100%;height:auto;display:block;overflow:visible}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .lbl{fill:var(--dim);font:10px ui-monospace,Menlo,monospace}
.chart .barOk{fill:var(--good)}
.chart .barNo{fill:var(--bad)}
.chart .barHold{fill:var(--gold)}
.chart .avgline{stroke:var(--gold);stroke-width:1.5;stroke-dasharray:4 3}

.insights{list-style:none;margin:0;padding:0}
.insights li{display:flex;gap:9px;padding:8px 0;font-size:14px;border-top:1px solid var(--line)}
.insights li:first-child{border-top:0}
.insights .mark{flex:none;width:18px;text-align:center}
.insights .good .mark{color:var(--good)}
.insights .bad .mark{color:var(--bad)}
.insights .flat .mark{color:var(--dim)}

.qlist{list-style:none;margin:0;padding:0}
.qrow{border-top:1px solid var(--line);padding:10px 0;display:flex;gap:10px;align-items:flex-start}
.qrow:first-child{border-top:0}
.qrow .n{flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;
  font:700 11px ui-monospace,monospace;background:var(--line);color:var(--text)}
.qrow.ok .n{background:var(--good-soft);color:var(--good)}
.qrow.no .n{background:var(--bad-soft);color:var(--bad)}
.qrow .body{flex:1;min-width:0}
.qrow .q{display:block;font-size:14px;font-weight:600}
.qrow .d{display:block;font-size:12px;color:var(--dim);margin-top:3px}
.qrow .d .why{color:var(--bad)}
.qrow .t{flex:none;font:700 13px ui-monospace,monospace;color:var(--dim);
  font-variant-numeric:tabular-nums}
.tagpill{display:inline-block;font-size:10px;padding:1px 6px;border-radius:999px;
  border:1px solid var(--line);color:var(--dim);margin-left:6px;vertical-align:1px}

.actions{margin-top:18px}
.actions .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.actions .row .ghost{margin-top:0}

/*
 * Printing, which is how a phone saves a PDF.
 *
 * The dark theme is right on a screen and wrong on paper - it would drink an
 * ink cartridge and read badly. The report inverts to ink on white, the
 * buttons disappear because a printed button is a lie, and colour-adjust is
 * forced on so the chart bars survive: a bar chart printed in uniform grey
 * says nothing at all.
 */
@media print{
  @page{margin:14mm}
  html,body{background:#fff !important;color:#111 !important}
  .top,.actions,#lobby,#countdown,#play{display:none !important}
  .wrap{max-width:100%;padding:0}
  /* A sheet of paper is far wider than a phone, so the four-across layout
     that only appears on a tablet on screen is the right one in print. */
  /* Adapts to the paper rather than assuming it: four across on A4, two on a
     narrow sheet, and never wider than the page. */
  .kpis{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}
  .parties{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
  .card,.kpi{background:#fff !important;border:1px solid #ccc !important;
    break-inside:avoid;page-break-inside:avoid}
  .rhead .big{color:#8b1e3f !important}
  .kpi .v,.qrow .q,.rhead h2{color:#111 !important}
  .kpi .k,.qrow .d,.card .note,.rhead .of{color:#555 !important}
  .grade{border:1px solid #999}
  /* The document furniture is for paper, so this is where it exists. */
  .masthead{display:flex !important}
  .parties{display:grid !important}
  .docfoot{display:block !important}
  .docline{display:none !important}
  .masthead,.party,.docfoot{background:#fff !important;border-color:#bbb !important}
  .masthead .issuer,.party .r dd,.docfoot b{color:#111 !important}
  .masthead .sub,.party h4,.party .r dt,.docfoot{color:#555 !important}
  .masthead .doctype .t{color:#8b1e3f !important}
  /* A report is read in order: it should not break in the middle of a party
     block or an insight. */
  .masthead,.parties,.docfoot{break-inside:avoid;page-break-inside:avoid}
  .chart .lbl{fill:#555 !important}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Behaviour.
   ───────────────────────────────────────────────────────────────────────── */
function js() {
  return `
(function(){
  var CFG = window.__FF__;
  var API = CFG.apiBase + '/fatafat/' + CFG.token;
  var GRACE_MS = 250;        // a tap this soon after a shuffle means the old layout
  var FLOOR_MS = 150;        // below this nobody read anything

  var $ = function(id){ return document.getElementById(id); };
  var state = {
    seq: 0, total: CFG.questionCount, score: 0,
    q: null, perm: [0,1,2], prevPerm: null, shuffledAt: 0,
    startedAt: 0, taps: [], locked: true, raf: 0, timeout: 0,
  };

  /* ── sound ─────────────────────────────────────────────────────────────
     Synthesised, not downloaded: four short tones cost nothing to ship and
     nothing to wait for on a slow connection. */
  var actx = null, muted = localStorage.getItem('ff_mute') === '1';
  function ac(){ if(!actx){ try{ actx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return actx; }
  function tone(freq, ms, type, vol){
    if (muted) return;
    var c = ac(); if(!c) return;
    try{
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.09, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms/1000);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + ms/1000);
    }catch(e){}
  }
  var sTick   = function(){ tone(1100, 60, 'square', 0.05); };
  var sGo     = function(){ tone(760, 220, 'triangle', 0.10); };
  var sRight  = function(){ tone(880, 90, 'sine', 0.10); setTimeout(function(){ tone(1320, 140, 'sine', 0.09); }, 85); };
  var sWrong  = function(){ tone(210, 240, 'sawtooth', 0.09); };
  var sShuffle= function(){ tone(520, 70, 'square', 0.06); setTimeout(function(){ tone(680, 70, 'square', 0.06); }, 70); };
  var sHold   = function(){ tone(440, 300, 'sine', 0.07); };

  /*
   * A laugh, out of oscillators.
   *
   * Four falling syllables with a wobble on each - "ha ha ha ha" read more
   * than heard. A recorded laugh would be kinder to the ear and a 40KB
   * download that has to arrive before the joke lands, which on a slow
   * connection means it arrives during the next question instead.
   */
  var sLaugh = function(){
    if (muted) return;
    var c = ac(); if (!c) return;
    var start = [430, 380, 340, 300];
    for (var i = 0; i < start.length; i++) {
      (function(i){
        setTimeout(function(){
          try {
            var o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
            o.type = 'triangle';
            o.frequency.setValueAtTime(start[i], c.currentTime);
            o.frequency.exponentialRampToValueAtTime(start[i] * 0.72, c.currentTime + 0.13);
            lfo.frequency.value = 22; lg.gain.value = 26;      // the wobble
            lfo.connect(lg); lg.connect(o.frequency);
            g.gain.setValueAtTime(0.0001, c.currentTime);
            g.gain.exponentialRampToValueAtTime(0.085, c.currentTime + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.15);
            o.connect(g); g.connect(c.destination);
            lfo.start(); o.start();
            o.stop(c.currentTime + 0.16); lfo.stop(c.currentTime + 0.16);
          } catch (e) {}
        }, i * 125);
      })(i);
    }
  };

  var BAKRA = ['\uD83D\uDE02', '\uD83E\uDD23', '\uD83D\uDC10', '\uD83D\uDE1C', '\uD83D\uDE48'];

  /** Emoji outward from the middle, then gone. */
  function laughAt(){
    var box = document.createElement('div');
    box.className = 'laugh';
    var n = 7;
    for (var i = 0; i < n; i++) {
      var e = document.createElement('span');
      e.textContent = BAKRA[Math.floor(Math.random() * BAKRA.length)];
      var angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      var dist = 90 + Math.random() * 90;
      e.style.setProperty('--x', Math.round(Math.cos(angle) * dist) + 'px');
      e.style.setProperty('--y', Math.round(Math.sin(angle) * dist - 30) + 'px');
      e.style.setProperty('--r', Math.round(-40 + Math.random() * 80) + 'deg');
      e.style.animationDelay = (i * 22) + 'ms';
      box.appendChild(e);
    }
    document.body.appendChild(box);
    setTimeout(function(){ box.remove(); }, 1400);

    var play = $('play');
    if (play) { play.classList.add('shake'); setTimeout(function(){ play.classList.remove('shake'); }, 460); }
  }

  /* Every string the page decides for itself. The questions arrive already in
     the round's language; these are the words around them. */
  var T = CFG.ui || {
    tapBoth: 'Tap BOTH of them', right: 'Right!', held: 'Held it. 🧊',
    missed: 'Missed', outOfTime: 'Out of time',
    tooSoon: 'Too soon — that was a guess, not an answer',
    notThatOne: 'Not that one',
    trapLine: 'That one was a trap — the answer was to tap nothing',
    holdWorked: 'Touching nothing was the answer',
    inARow: 'in a row', ms: 'ms', go: 'GO',
  };

  var langBtn = $('lang');
  if (langBtn) langBtn.onclick = function(){
    langBtn.disabled = true;
    post('/lang', { lang: CFG.lang === 'hi' ? 'en' : 'hi' }).then(function(res){
      // A round that has already been answered cannot change language without
      // re-serving a question, so the server starts a fresh one instead and
      // sends its link. Either way the language actually changes.
      if (res && res.url) { location.href = res.url; return; }
      if (res && res.lang) { location.reload(); return; }
      langBtn.disabled = false;
    });
  };

  $('mute').textContent = muted ? '🔇' : '🔊';
  $('mute').onclick = function(){
    muted = !muted;
    localStorage.setItem('ff_mute', muted ? '1' : '0');
    $('mute').textContent = muted ? '🔇' : '🔊';
    if (!muted) tone(880, 80);
  };

  /* ── the game-room menu ───────────────────────────────────────────────── */
  var M = CFG.lang === 'hi' ? {
    reports: 'मेरी रिपोर्ट', reportsSub: 'हर राउंड की पूरी रिपोर्ट',
    analytics: 'विश्लेषण', analyticsSub: 'आप किसमें अच्छे हैं',
    refer: 'रेफर करें', referSub: 'जल्द आ रहा है',
    feedback: 'फ़ीडबैक', feedbackSub: 'हमें बताइए',
    support: 'सहायता', supportSub: 'कोई सवाल?',
    back: 'वापस', none: 'अभी कोई राउंड नहीं खेला।',
    accuracy: 'सटीकता', speed: 'औसत समय', rounds: 'राउंड',
  } : {
    reports: 'My reports', reportsSub: 'Every round, in full',
    analytics: 'Analytics', analyticsSub: 'What you are good at',
    refer: 'Refer & earn', referSub: 'Coming soon',
    feedback: 'Feedback', feedbackSub: 'Tell us what you think',
    support: 'Support', supportSub: 'Got a question?',
    back: 'Back', none: 'No rounds played yet.',
    accuracy: 'accuracy', speed: 'average time', rounds: 'rounds',
  };

  function tile(icon, title, sub, attrs){
    return '<' + (attrs.href ? 'a' : 'button') + ' class="tile" ' +
      (attrs.href ? 'href="' + attrs.href + '"' : '') +
      (attrs.id ? ' id="' + attrs.id + '"' : '') +
      (attrs.disabled ? ' disabled' : '') + '>' +
      '<span class="ic">' + icon + '</span>' +
      '<span class="tx">' + escapeHtml(title) +
        '<span class="sub">' + escapeHtml(sub) + '</span></span>' +
    '</' + (attrs.href ? 'a' : 'button') + '>';
  }

  (function buildTiles(){
    var box = $('tiles');
    if (!box) return;
    box.innerHTML =
      tile('\uD83D\uDCC4', M.reports, M.reportsSub, { id: 'tReports' }) +
      tile('\uD83D\uDCC8', M.analytics, M.analyticsSub, { id: 'tAnalytics' }) +
      // Defined, worded and visibly not ready. A tile that appears on launch
      // day is a tile nobody notices; one that has been sitting there greyed
      // out for a month is the first thing they tap when it lights up.
      tile('\uD83C\uDF81', M.refer, M.referSub, { id: 'tRefer', disabled: true }) +
      (CFG.feedbackUrl ? tile('\u2B50', M.feedback, M.feedbackSub, { href: CFG.feedbackUrl }) : '') +
      (CFG.supportUrl ? tile('\uD83D\uDCAC', M.support, M.supportSub, { href: CFG.supportUrl }) : '');

    var r = $('tReports'), a = $('tAnalytics');
    if (r) r.onclick = openReports;
    if (a) a.onclick = openAnalytics;
  })();

  function openPanel(html){
    $('lobby').classList.add('hidden');
    var p = $('menu');
    p.innerHTML = html;
    p.classList.remove('hidden');
    var back = p.querySelector('.back');
    if (back) back.onclick = function(){
      p.classList.add('hidden');
      $('lobby').classList.remove('hidden');
    };
  }

  function panelShell(title, body){
    return '<div class="panel"><div class="bar"><h2>' + escapeHtml(title) + '</h2>' +
      '<button class="back">' + escapeHtml(M.back) + '</button></div>' + body + '</div>';
  }

  function when(iso){
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(CFG.lang === 'hi' ? 'hi-IN' : 'en-IN', {
        timeZone: (CFG.doc && CFG.doc.timezone) || 'Asia/Kolkata',
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
      });
    } catch (e) { return String(iso).slice(0, 16).replace('T', ' '); }
  }

  function openReports(){
    openPanel(panelShell(M.reports, '<p class="fineprint">…</p>'));
    get('/rounds').then(function(rows){
      var body = !rows.length ? '<p class="fineprint">' + escapeHtml(M.none) + '</p>' :
        '<ul class="rlist">' + rows.map(function(r){
          return '<li><a href="' + (CFG.apiBase || '') + r.url + '">' +
            '<span class="sc">' + r.score + '</span>' +
            '<span class="mid">' + r.correct + '/' + r.answered +
              '<span class="when">' + when(r.playedAt) + '</span></span>' +
            '<span class="go">&rsaquo;</span></a></li>';
        }).join('') + '</ul>';
      openPanel(panelShell(M.reports, body));
    });
  }

  var MODE_LABEL = CFG.lang === 'hi'
    ? { go: 'सीधा टैप', position: 'शब्द बनाम जगह', rule: 'नियम', except: 'दोनों, एक छोड़कर', hold: 'रुकना' }
    : { go: 'Straight tap', position: 'Word vs slot', rule: 'Rules', except: 'Both but one', hold: 'Holding still' };

  function bar(label, pct, note){
    var cls = pct >= 80 ? '' : pct >= 55 ? 'mid' : 'low';
    return '<li><div class="top"><span>' + escapeHtml(label) + '</span>' +
      '<b>' + (pct === null ? '—' : pct + '%') + (note ? ' <span style="color:var(--dim);font-weight:400">' + note + '</span>' : '') + '</b></div>' +
      '<div class="track"><div class="fill ' + cls + '" style="width:' + (pct || 0) + '%"></div></div></li>';
  }

  function openAnalytics(){
    openPanel(panelShell(M.analytics, '<p class="fineprint">…</p>'));
    get('/analytics').then(function(a){
      var body = '';
      if (!a.byMode.length) {
        body = '<p class="fineprint">' + escapeHtml(M.none) + '</p>';
      } else {
        body += '<div class="card"><h3>' + escapeHtml(CFG.lang === 'hi' ? 'प्रश्न के प्रकार के अनुसार' : 'Accuracy by question type') + '</h3><ul class="bars">' +
          a.byMode.map(function(m){
            return bar(MODE_LABEL[m.mode] || m.mode, m.accuracyPct,
                       m.avgMs ? m.avgMs + 'ms' : '');
          }).join('') + '</ul>' +
          '<p class="note">' + (CFG.lang === 'hi'
            ? 'सबसे कठिन है रुकना — जहाँ सही जवाब है कुछ भी न छूना।'
            : 'The hardest is holding still — the questions where the answer is to touch nothing.') +
          '</p></div>';

        body += '<div class="card"><h3>' + (CFG.lang === 'hi' ? 'कठिनाई के अनुसार' : 'By difficulty') +
          '</h3><ul class="bars">' + a.byDifficulty.map(function(d){
            return bar((CFG.lang === 'hi' ? 'स्तर ' : 'Level ') + d.difficulty, d.accuracyPct,
                       d.avgMs ? d.avgMs + 'ms' : '');
          }).join('') + '</ul></div>';

        if (a.improvement && a.improvement.enough) {
          var arrow = a.improvement.direction === 'up' ? '▲' : a.improvement.direction === 'down' ? '▼' : '•';
          body += '<div class="card"><h3>' + (CFG.lang === 'hi' ? 'क्या आप सुधर रहे हैं?' : 'Are you improving?') + '</h3>' +
            '<p style="margin:0;font-size:15px">' + arrow + ' <b>' + a.improvement.now + '</b> ' +
            (CFG.lang === 'hi' ? 'अब, पहले था ' : 'now, from ') + '<b>' + a.improvement.before + '</b>' +
            '</p><p class="note">' + (CFG.lang === 'hi'
              ? 'आपके पिछले ' + a.improvement.window + ' राउंड बनाम पहले के ' + a.improvement.window
              : 'Your last ' + a.improvement.window + ' rounds against your first ' + a.improvement.window) +
            '</p></div>';
        }
      }
      openPanel(panelShell(M.analytics, body));
    });
  }

  /* ── pips ─────────────────────────────────────────────────────────────── */
  (function(){
    var box = $('pips'), html = '';
    for (var i = 0; i < state.total; i++) html += '<span class="pip" id="pip'+(i+1)+'"></span>';
    box.innerHTML = html;
  })();

  /* ── network ──────────────────────────────────────────────────────────── */
  function get(path){ return fetch(API + path, {headers:{'Accept':'application/json'}}).then(function(r){ return r.json(); }); }
  function post(path, body){
    return fetch(API + path, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}),
    }).then(function(r){ return r.json(); });
  }

  /* ── lobby ────────────────────────────────────────────────────────────── */
  var fresh = $('freshRound');
  if (fresh) fresh.onclick = function(){
    fresh.disabled = true; fresh.textContent = 'Starting…';
    post('/again', {}).then(function(res){
      if (res.url) location.href = res.url;
      else { fresh.disabled = false; fresh.textContent = 'Play a new round'; }
    });
  };

  $('begin').onclick = function(){
    var mn = $('menu'); if (mn) mn.classList.add('hidden');
    if (!muted) { var c = ac(); if (c && c.state === 'suspended') c.resume(); }
    $('lobby').classList.add('hidden');
    if (CFG.spent) return showReport();
    countdown(3);
  };

  function countdown(n){
    $('countdown').classList.remove('hidden');
    var el = $('countNum');
    (function step(){
      if (n === 0) {
        el.textContent = T.go || 'GO';
        sGo();
        setTimeout(function(){
          $('countdown').classList.add('hidden');
          $('play').classList.remove('hidden');
          document.body.classList.add('playing');
          nextQuestion();
        }, 450);
        return;
      }
      el.textContent = String(n);
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      sTick();
      n--;
      setTimeout(step, 800);
    })();
  }

  /* ── one question ─────────────────────────────────────────────────────── */
  function nextQuestion(){
    get('/next').then(function(res){
      if (res.done) return showReport();
      state.seq = res.seq;
      state.q = res.question;
      state.taps = [];
      state.prevPerm = null;
      state.shuffledAt = 0;

      // A fresh order for every question on every device. Correctness lives in
      // the option's text, so this changes nothing except that a screenshot
      // saying "tap the middle one" helps nobody.
      state.perm = shuffled([0,1,2]);

      $('qno').textContent = res.seq + ' / ' + res.total;
      for (var i = 1; i <= state.total; i++) {
        var p = $('pip'+i);
        if (p && i === res.seq) p.className = 'pip now';
      }

      var warn = /DON'T/.test(state.q.instruction);
      $('instruction').innerHTML = warn
        ? state.q.instruction.replace(/(DON'T TAP)/, '<span class="warn">$1</span>')
        : state.q.instruction;
      $('tapsHint').textContent = state.q.taps === 2 ? T.tapBoth : '\\u00a0';
      $('verdict').textContent = '';
      $('verdict').className = 'verdict';

      drawOptions();
      startClock(res.timeLimitMs);
      state.locked = false;

      if (state.q.twist) {
        // Fired partway through: early enough that they have committed, late
        // enough that they have read the question.
        state.timeout = setTimeout(doTwist, Math.round(res.timeLimitMs * 0.42));
      }
    });
  }

  function shuffled(a){
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function drawOptions(){
    var box = $('options'), html = '';
    for (var slot = 0; slot < 3; slot++) {
      var canonical = state.perm[slot];
      html += '<button class="opt" data-slot="' + slot + '">' +
              escapeHtml(state.q.options[canonical]) + '</button>';
    }
    box.innerHTML = html;
    var btns = box.querySelectorAll('.opt');
    for (var k = 0; k < btns.length; k++) btns[k].onclick = onTap;
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  /**
   * The twist. The options change places under the player's thumb.
   */
  function doTwist(){
    if (state.locked) return;
    var box = $('options');
    state.prevPerm = state.perm.slice();
    state.shuffledAt = performance.now();
    state.perm = shuffled(state.perm);
    sShuffle();

    box.classList.add('shuffling');
    // Redraw, then let the browser animate the new positions in.
    var texts = [];
    for (var s = 0; s < 3; s++) texts.push(state.q.options[state.perm[s]]);
    var btns = box.querySelectorAll('.opt');
    for (var i = 0; i < btns.length; i++) {
      (function(btn, text, i){
        btn.style.transform = 'translateY(' + ((i % 2) ? 8 : -8) + 'px) scale(.96)';
        setTimeout(function(){
          btn.textContent = text;
          btn.style.transform = '';
        }, 120);
      })(btns[i], texts[i], i);
    }
    setTimeout(function(){ box.classList.remove('shuffling'); }, 500);
  }

  /* ── the clock ────────────────────────────────────────────────────────── */
  function startClock(limitMs){
    cancelAnimationFrame(state.raf);
    state.startedAt = performance.now();
    var ring = $('ringFg'), clock = $('clock'), face = ring.parentNode;
    var CIRC = 2 * Math.PI * 52;
    var urgentAt = 1500, buzzed = false;

    (function frame(){
      var left = limitMs - (performance.now() - state.startedAt);
      if (left <= 0) {
        clock.textContent = '0.000';
        ring.style.strokeDashoffset = CIRC;
        return timeUp();
      }
      // Three decimals, because a stopwatch that moves is half the thrill.
      clock.textContent = (left / 1000).toFixed(3);
      ring.style.strokeDashoffset = CIRC * (1 - left / limitMs);

      var urgent = left < urgentAt;
      face.classList.toggle('urgent', urgent);
      clock.classList.toggle('urgent', urgent);
      if (urgent && !buzzed) { buzzed = true; }
      if (urgent) {
        var whole = Math.ceil(left / 1000);
        if (whole !== frame.lastWhole) { frame.lastWhole = whole; sTick(); }
      }

      state.raf = requestAnimationFrame(frame);
    })();
  }

  function stopClock(){
    cancelAnimationFrame(state.raf);
    clearTimeout(state.timeout);
  }

  /* ── answering ────────────────────────────────────────────────────────── */
  function onTap(e){
    if (state.locked) return;
    var slot = Number(e.currentTarget.getAttribute('data-slot'));

    // Which layout was on screen when the thumb committed? Inside the grace
    // window after a shuffle, the honest answer is "the old one".
    var perm = state.perm;
    if (state.prevPerm && (performance.now() - state.shuffledAt) < GRACE_MS) perm = state.prevPerm;

    var canonical = perm[slot] + 1;          // server counts slots from 1
    if (state.taps.indexOf(canonical) === -1) state.taps.push(canonical);
    e.currentTarget.classList.add('picked');

    if (state.taps.length >= state.q.taps) send(state.taps);
  }

  function timeUp(){
    if (state.locked) return;
    // Touching nothing is a real answer, and on a no-go it is the right one.
    send([]);
  }

  function send(taps){
    state.locked = true;
    stopClock();
    var ms = Math.round(performance.now() - state.startedAt);
    post('/answer', { seq: state.seq, tapped: taps, ms: ms }).then(function(res){
      if (res.error) { $('verdict').textContent = res.error; return; }
      showVerdict(res, taps);
      var pip = $('pip' + state.seq);
      if (pip) pip.className = 'pip ' + (res.correct ? 'ok' : 'no');
      state.score += res.points;
      $('score').textContent = Math.round(state.score);
      // Long enough for the laugh to finish, short enough that it never
      // becomes the thing you are waiting for.
      setTimeout(function(){ res.done ? showReport() : nextQuestion(); }, res.correct ? 750 : 1250);
    });
  }

  function showVerdict(res, taps){
    var box = $('options'), btns = box.querySelectorAll('.opt');
    for (var slot = 0; slot < btns.length; slot++) {
      var canonical = state.perm[slot] + 1;
      btns[slot].disabled = true;
      if (res.correctPositions.indexOf(canonical) !== -1 && !res.noGo) btns[slot].classList.add('right');
      else if (taps.indexOf(canonical) !== -1) btns[slot].classList.add('wrong');
    }

    var v = $('verdict');
    if (res.correct) {
      sRight();
      v.className = 'verdict good';
      v.innerHTML = '<span class="big">' + (res.noGo ? T.held : T.right) + '</span>' +
        '<span class="sub">' +
          (res.noGo ? T.holdWorked : res.takenMs + ' ' + T.ms) +
          ' &middot; +' + Math.round(res.points) +
          (res.streak > 2 ? ' &middot; ' + res.streak + ' ' + T.inARow : '') +
        '</span>';
    } else {
      // The bakra moment - whether they tapped the wrong one or sat there and
      // let the clock run out. Both are the game winning.
      sWrong();
      setTimeout(sLaugh, 140);
      laughAt();
      v.className = 'verdict bad';
      var why = res.noGo ? T.trapLine
              : taps.length === 0 ? T.outOfTime
              : res.takenMs < FLOOR_MS ? T.tooSoon
              : T.notThatOne;
      v.innerHTML = '<span class="big">' + T.missed + '</span><span class="sub">' + why + '</span>';
      if (res.noGo) sHold();
    }
  }

  /* ── report ───────────────────────────────────────────────────────────── */
  function showReport(){
    stopClock();
    // The language button is hidden only while a question is on screen. A
    // report is not a question, and leaving the class on left the toggle
    // invisible for the rest of the page's life.
    document.body.classList.remove('playing');
    $('play').classList.add('hidden');
    get('/report').then(function(r){
      $('report').innerHTML = reportHtml(r);
      // A missing logo should leave no gap. Bound here rather than as an
      // inline onerror attribute: quotes inside an attribute inside a
      // generated string are one escape away from breaking the whole file.
      var mk = document.querySelector('.masthead .mark');
      if (mk) mk.onerror = function(){ this.style.display = 'none'; };
      $('report').classList.remove('hidden');
      var save = $('savepdf');
      if (save) save.onclick = function(){ window.print(); };
      var again = $('again');
      if (again) again.onclick = function(){
        again.disabled = true; again.textContent = 'Starting…';
        post('/again', {}).then(function(res){
          if (res.url) location.href = res.url;
          else { again.disabled = false; again.textContent = 'Play again'; }
        });
      };
    });
  }

  function grade(pct){
    if (pct >= 850) return ['Outstanding', 'var(--gold)', '#2b2118'];
    if (pct >= 700) return ['Sharp', 'var(--good)', '#06210f'];
    if (pct >= 500) return ['Steady', 'rgba(212,165,55,.25)', 'var(--gold)'];
    if (pct >= 300) return ['Warming up', 'var(--line)', 'var(--text)'];
    return ['Room to grow', 'var(--line)', 'var(--dim)'];
  }

  /** A date and time in the operator's timezone, not the reader's device. */
  function stamp(iso){
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-IN', {
        timeZone: (CFG.doc && CFG.doc.timezone) || 'Asia/Kolkata',
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
    } catch (e) { return new Date(iso).toISOString().slice(0, 16).replace('T', ' '); }
  }

  function row(k, v){
    return '<div class="r"><dt>' + k + '</dt><dd>' + (v === null || v === undefined || v === '' ? '—' : v) + '</dd></div>';
  }

  /**
   * The masthead and the two parties.
   *
   * A score somebody screenshots into a group chat is one thing; a document
   * they keep, print or send to support is another, and the second has to say
   * who it is about, who issued it and which round it refers to.
   */
  function docHead(r){
    var d = CFG.doc || {}, b = d.business || {}, p = d.player || {};
    var mark = (CFG.apiBase || '') + '/public/images/logo-horizontal.svg';
    var mins = r.round.finishedAt && r.round.createdAt
      ? Math.max(1, Math.round((new Date(r.round.finishedAt) - new Date(r.round.createdAt)) / 60000))
      : null;

    var h = '<div class="masthead">' +
      '<img class="mark" src="' + mark + '" alt="">' +
      '<div class="who">' +
        '<div class="issuer">' + escapeHtml(b.legalName || b.brandName || 'MastiPe') + '</div>' +
        '<div class="sub">' + escapeHtml(b.brandName || 'MastiPe') + ' &middot; Tap Bakra</div>' +
      '</div>' +
      '<div class="doctype"><div class="t">Performance Report</div>' +
        '<div class="r">' + escapeHtml(d.reference || '') + '</div></div>' +
    '</div>';

    h += '<div class="parties">' +
      '<div class="party"><h4>Player</h4><dl>' +
        row('Name', escapeHtml(p.name || 'Not set')) +
        row('WhatsApp', escapeHtml(p.masked || '—')) +
        row('Player ID', p.id) +
      '</dl></div>' +
      '<div class="party"><h4>Round</h4><dl>' +
        row('Reference', escapeHtml(d.reference || '')) +
        row('Played', stamp(r.round.finishedAt || r.round.createdAt)) +
        row('Questions', r.round.questionCount) +
        row('Per question', (r.round.timeLimitMs / 1000).toFixed(0) + 's') +
        (mins ? row('Duration', mins + ' min') : '') +
      '</dl></div>' +
    '</div>';

    return h;
  }

  /** Who issued this, how to reach them, and what it is not. */
  function docFoot(){
    var d = CFG.doc || {}, b = d.business || {}, a = b.address || {};
    var lines = [a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country]
      .filter(function(x){ return x && String(x).trim(); });

    var h = '<div class="docfoot"><div class="cols">' +
      '<div><b>' + escapeHtml(b.legalName || 'ServerPe App Solutions') + '</b><br>' +
        (lines.length ? escapeHtml(lines.join(', ')) : 'India') +
        (b.gstin ? '<br>GSTIN: ' + escapeHtml(b.gstin) : '') +
      '</div>' +
      '<div>' +
        (b.supportEmail ? escapeHtml(b.supportEmail) + '<br>' : '') +
        (b.whatsappNumber ? 'WhatsApp +' + escapeHtml(b.whatsappNumber) + '<br>' : '') +
        (d.siteUrl ? escapeHtml(String(d.siteUrl).replace(/^https?:\\/\\//, '')) : '') +
      '</div>' +
    '</div>' +
    '<div class="legal">' +
      'Generated ' + stamp(new Date().toISOString()) + '. ' +
      'Computer-generated report &mdash; valid without signature. ' +
      'Scores are calculated from the numbers actually recorded during play and ' +
      'can be reproduced from the round reference above.<br>' +
      '<b>Entertainment only.</b> No betting, no wagering and no cash prizes. ' +
      'Nothing won in this game has monetary value.' +
    '</div></div>';
    return h;
  }

  function reportHtml(r){
    var t = r.totals, tm = r.timing, g = grade(r.round.pct);

    // Screen gets one line; print gets the whole masthead. Both are rendered,
    // and CSS decides which the reader is actually looking at.
    var d0 = CFG.doc || {};
    var h = docHead(r);
    h += '<div class="docline">' +
      '<span class="ref">' + escapeHtml(d0.reference || '') + '</span>' +
      '<span>&middot;</span>' +
      '<span>' + stamp(r.round.finishedAt || r.round.createdAt) + '</span>' +
    '</div>';
    h += '<div class="rhead">' +
      '<div class="big">' + Math.round(r.round.score) + '</div>' +
      '<div class="of">of a possible ' + r.round.maxScore + '</div>' +
      '<h2>' + (CFG.playerName ? escapeHtml(CFG.playerName) + ', that\\'s a wrap' : "That\\'s a wrap") + '</h2>' +
      '<span class="grade" style="background:' + g[1] + ';color:' + g[2] + '">' + g[0] + '</span>' +
    '</div>';

    h += '<div class="kpis">' +
      kpi(t.correct + '/' + t.answered, 'correct', t.correct === t.answered ? 'good' : '') +
      kpi(t.accuracyPct + '%', 'accuracy', t.accuracyPct >= 80 ? 'good' : t.accuracyPct < 50 ? 'bad' : '') +
      kpi(tm.avgMs === null ? '—' : tm.avgMs + 'ms', 'average', 'gold') +
      kpi(tm.fastestMs === null ? '—' : tm.fastestMs + 'ms', 'fastest', 'good') +
    '</div>';

    h += '<div class="kpis">' +
      kpi(t.bestStreak, 'best run', '') +
      kpi(tm.medianMs === null ? '—' : tm.medianMs + 'ms', 'typical', '') +
      kpi(tm.spreadMs === null ? '—' : '±' + tm.spreadMs + 'ms', 'steadiness', '') +
      kpi(t.noGosHeld + '/' + t.noGosFaced, 'held', t.noGosHeld === t.noGosFaced ? 'good' : 'bad') +
    '</div>';

    h += '<div class="card"><h3>Every question, and how long you took</h3>' +
      timeChart(r) +
      '<p class="note">Gold bars are the no-go questions, where the right answer was to touch ' +
      'nothing — they always take the full clock, so they are not counted in your average.</p>' +
    '</div>';

    h += '<div class="card"><h3>What that says</h3><ul class="insights">' +
      r.insights.map(function(i){
        var mark = i.tone === 'good' ? '▲' : i.tone === 'bad' ? '▼' : '•';
        return '<li class="' + i.tone + '"><span class="mark">' + mark + '</span><span>' +
               escapeHtml(i.text) + '</span></li>';
      }).join('') +
    '</ul></div>';

    h += '<div class="card"><h3>Question by question</h3><ul class="qlist">' +
      r.rows.map(function(row){
        var cls = row.wasCorrect ? 'ok' : 'no';
        var what = row.tapped.length
          ? 'You tapped ' + row.tapped.map(function(p){ return escapeHtml(row.options[p-1]); }).join(' + ')
          : (row.noGo ? 'You touched nothing' : 'You ran out of time');
        var right = row.noGo ? 'nothing' :
          row.correctPositions.map(function(p){ return escapeHtml(row.options[p-1]); }).join(' + ');
        // A pre-tap deserves its own sentence. "You tapped RIGHT, answer was
        // RIGHT" next to a red mark reads as a broken game, not a strict one.
        var why = row.preTap
          ? ' &middot; <span class="why">too fast to be a real answer</span>'
          : (row.wasCorrect ? '' : ' &middot; answer was ' + right);
        return '<li class="qrow ' + cls + '">' +
          '<span class="n">' + row.seq + '</span>' +
          '<span class="body"><span class="q">' + escapeHtml(row.instruction) +
            (row.twisted ? '<span class="tagpill">shuffled</span>' : '') +
            (row.noGo ? '<span class="tagpill">no-go</span>' : '') +
          '</span>' +
          '<span class="d">' + what + why + '</span></span>' +
          '<span class="t">' + (row.takenMs === null ? '—' : (row.takenMs/1000).toFixed(2) + 's') + '</span>' +
        '</li>';
      }).join('') +
    '</ul></div>';

    h += '<div class="actions">' +
      '<button id="again" class="primary">Play again</button>' +
      '<div class="row">' +
        // window.print() is the whole PDF feature. Every phone browser offers
        // "Save as PDF" from its print sheet, and a library that rasterises
        // the page would be 200KB to do it worse.
        '<button id="savepdf" class="ghost">Save as PDF</button>' +
        (CFG.feedbackUrl
          ? '<a class="ghost" style="text-align:center;text-decoration:none;display:block" ' +
            'href="' + CFG.feedbackUrl + '">Give feedback</a>'
          : '') +
      '</div>' +
      '<a class="ghost" style="display:block;text-align:center;text-decoration:none" ' +
        'href="https://wa.me/' + CFG.waNumber + '">Back to WhatsApp</a>' +
    '</div>';

    h += docFoot();

    return h;
  }

  function kpi(v, k, tone){
    return '<div class="kpi ' + (tone||'') + '"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  /**
   * Per-question times, drawn as SVG.
   *
   * Hand-rolled rather than charted with a library: one bar chart does not
   * justify shipping 200KB to a phone on a train.
   */
  function timeChart(r){
    var rows = r.rows, limit = r.round.timeLimitMs;
    var W = 320, H = 150, padL = 26, padB = 20, padT = 8;
    var innerW = W - padL - 6, innerH = H - padB - padT;
    var bw = innerW / rows.length;

    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">';
    for (var g = 0; g <= 4; g++) {
      var y = padT + innerH * (g / 4);
      var secs = ((limit / 1000) * (1 - g / 4)).toFixed(1);
      s += '<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + W + '" y2="' + y + '"/>';
      s += '<text class="lbl" x="0" y="' + (y + 3) + '">' + secs + 's</text>';
    }
    rows.forEach(function(row, i){
      var ms = row.takenMs === null ? limit : row.takenMs;
      var hgt = Math.max(2, innerH * Math.min(1, ms / limit));
      var x = padL + i * bw + bw * 0.18;
      var w = bw * 0.64;
      var y2 = padT + innerH - hgt;
      var cls = row.noGo ? 'barHold' : (row.wasCorrect ? 'barOk' : 'barNo');
      s += '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + y2.toFixed(1) +
           '" width="' + w.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="2"><title>' +
           'Q' + row.seq + ' — ' + (row.takenMs === null ? 'no answer' : row.takenMs + 'ms') + '</title></rect>';
      s += '<text class="lbl" x="' + (x + w/2).toFixed(1) + '" y="' + (H - 6) +
           '" text-anchor="middle">' + row.seq + '</text>';
    });
    if (r.timing.avgMs !== null) {
      var ay = padT + innerH - innerH * Math.min(1, r.timing.avgMs / limit);
      s += '<line class="avgline" x1="' + padL + '" y1="' + ay.toFixed(1) +
           '" x2="' + W + '" y2="' + ay.toFixed(1) + '"/>';
    }
    s += '</svg>';
    return s;
  }
})();
`;
}

/**
 * What a returning player sees instead of the rules.
 *
 * Their own record, not a leaderboard. Before anyone has played twice there is
 * nothing to compare against, and a board showing one name is sadder than no
 * board - so this is the number to beat, which is the only comparison that
 * works from the very first return visit.
 */
function dashboardHtml(stats, playerName, hi) {
  const ms = (v) => (v === null || v === undefined ? '—' : v + 'ms');
  const kpi = (v, k, tone) =>
    `<div class="kpi ${tone || ''}"><div class="v">${v}</div><div class="k">${k}</div></div>`;

  const rounds = stats.rounds;
  const L = hi
    ? { best: 'सर्वोच्च स्कोर', avg: 'औसत', acc: 'सटीकता', fast: 'सबसे तेज़',
        last: `आपके पिछले ${stats.recentScores.length} राउंड`, how: 'कैसे खेलें' }
    : { best: 'best score', avg: 'average', acc: 'accuracy', fast: 'fastest',
        last: `Your last ${stats.recentScores.length} rounds`, how: 'How it works' };

  const line = hi
    ? (playerName
        ? `वापसी पर स्वागत है, ${esc(playerName)}। <b>${rounds}</b> राउंड खेले।`
        : `<b>${rounds}</b> राउंड खेले।`)
    : (playerName
        ? `Welcome back, ${esc(playerName)}. <b>${rounds}</b> round${rounds === 1 ? '' : 's'} played.`
        : `<b>${rounds}</b> round${rounds === 1 ? '' : 's'} played.`);

  return `    <div class="dash">
      <p class="dashline">${line}</p>
      <div class="kpis">
        ${kpi(stats.bestScore, L.best, 'gold')}
        ${kpi(stats.avgScore, L.avg, '')}
        ${kpi(stats.accuracyPct === null ? '—' : stats.accuracyPct + '%', L.acc,
              stats.accuracyPct >= 80 ? 'good' : '')}
        ${kpi(ms(stats.bestMs), L.fast, 'good')}
      </div>
      ${sparkline(stats.recentScores, stats.bestScore, L.last)}
      <details class="howto">
        <summary>${L.how}</summary>
        <ol>
          ${hi
            ? '<li><b>निर्देश पढ़िए।</b> हर बार बदलता है।</li>' +
              '<li><b>सही वाले पर टैप कीजिए</b> — घड़ी खत्म होने से पहले।</li>' +
              '<li><b>कभी-कभी सही जवाब होता है कुछ भी न छूना।</b></li>'
            : '<li><b>Read the instruction.</b> It changes every time.</li>' +
              '<li><b>Tap the right one</b> before the clock runs out.</li>' +
              '<li><b>Sometimes the answer is to tap nothing at all.</b></li>'}
        </ol>
      </details>
    </div>`;
}

/** Recent scores, oldest to newest. Drawn only once there is a shape to see. */
function sparkline(scores, best, heading) {
  if (!scores || scores.length < 2) return '';
  const W = 300, H = 52;
  const top = Math.max(best, ...scores) || 1;
  const step = scores.length > 1 ? W / (scores.length - 1) : W;
  const pts = scores.map((v, i) => [i * step, H - (v / top) * (H - 6) - 3]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const dots = pts.map((p, i) =>
    `<circle class="${i === pts.length - 1 ? 'last' : 'dot'}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 3.5 : 2}"/>`).join('');
  return `      <div class="spark">
        <h4>${heading || 'Your last ' + scores.length + ' rounds'}</h4>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
             aria-label="Scores from your last ${scores.length} rounds">
          <path class="ln" d="${d}"/>${dots}
        </svg>
      </div>`;
}
