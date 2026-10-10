/**
 * The self-running walkthrough on the how-to-play page.
 *
 * ── Why this exists alongside the video ────────────────────────────────────
 *
 * A recorded video is a photograph of the product on the day it was filmed.
 * The one in src/media already disagrees with the platform in seven places -
 * it calls Jaldi 5 "Early Five", it uses button labels that have since
 * changed, and, worst of all, it shows the called number lighting up on the
 * player's ticket, which is the exact hint that was deliberately removed. A
 * player who learns from it learns a rule the game does not have.
 *
 * This walkthrough cannot drift like that, because it is not a recording. It
 * reads the same modules the game does - the real ticket generator, the real
 * prize list and its labels, the real call-out lines, the real draw interval -
 * so renaming a prize or changing the pace updates the demo on the next page
 * load, with nothing to re-record.
 *
 * ── Shape ─────────────────────────────────────────────────────────────────
 *
 * Scenes, each with a caption and a screen, advancing on a timer with a
 * progress bar. It follows the same story as the video (message the bot, fill
 * the room, start, play, claim, done) and continues past where the video stops
 * - the ending, feedback, and leaving - because those are the parts players
 * ask about most and the video never reaches.
 *
 * One phone, not four. The video is 16:9 for a wide screen; this page is read
 * on a phone, where four side-by-side handsets are four unreadable slivers.
 *
 * @param {object} d  ticket, prizes, taglines, interval, brand, hi
 * @returns {{css: string, html: string, js: string}} fragments to inline
 */
export function walkthrough() {
  return { css: CSS, html: HTML, js: JS };
}

const CSS = `
/* ---- the walkthrough ---------------------------------------------------- */
.wt{position:relative}
.wt .screen{
  background:var(--bg);border:1px solid var(--line);border-radius:14px;
  padding:12px;min-height:340px;overflow:hidden;
}
.wt .cap{
  background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border-radius:10px;padding:11px 13px;margin-top:10px;
  font-size:14px;line-height:1.5;color:#fff;min-height:3.2em;
}
.wt .cap b{color:#ffd98a}
.wt .bar{height:3px;background:var(--line);border-radius:2px;margin-top:10px;overflow:hidden}
.wt .bar i{display:block;height:100%;background:var(--gold);width:0}
.wt .ctrls{display:flex;gap:8px;margin-top:10px}
.wt .ctrls button{flex:1;padding:11px;border-radius:10px;border:1px solid var(--line);
  background:transparent;color:var(--text);font:600 13.5px system-ui;cursor:pointer}
.wt .step-of{text-align:center;font-size:11.5px;color:var(--dim);margin-top:8px}

/* chat */
.wt .chat{display:flex;flex-direction:column;gap:7px}
.wt .bub{max-width:82%;padding:8px 11px;border-radius:12px;font-size:13.5px;line-height:1.45}
.wt .bub.in{background:#232028;border:1px solid var(--line);align-self:flex-start}
.wt .bub.out{background:#1f3d2f;border:1px solid #2c5c45;align-self:flex-end}
.wt .bub .btnrow{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px}
.wt .chip{border:1px solid var(--gold);color:var(--gold);border-radius:8px;
  padding:4px 9px;font-size:12px;font-weight:700}

/* the board, cut down */
.wt .call{background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border-radius:12px;padding:12px;text-align:center;position:relative}
.wt .call .n{font:800 46px/1 ui-rounded,system-ui;color:#fff}
.wt .call .t{color:#f7dfa5;font-size:12.5px;margin-top:4px;min-height:1.3em}
.wt .call .seq{position:absolute;top:8px;left:10px;font-size:10.5px;color:#f7dfa5;opacity:.75}
.wt .ans{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:9px 0}
.wt .ans span{padding:10px 6px;border-radius:10px;border:1px solid var(--line);
  background:var(--panel);text-align:center;font:600 13px system-ui;color:var(--text)}
.wt .ans span.hit{background:#10b981;border-color:#10b981;color:#04231a}
.wt .ans span.miss{background:#c04b4b;border-color:#c04b4b;color:#fff}
.wt .tkt{background:var(--paper);border-radius:4px;overflow:hidden}
.wt .tkt table{border-collapse:collapse;width:100%;table-layout:fixed}
.wt .tkt td{border:1px solid rgba(139,30,63,.45);height:34px;text-align:center;
  position:relative;font:600 15px/1 Georgia,serif;color:var(--ink)}
.wt .tkt td.blank{background:repeating-linear-gradient(45deg,transparent,transparent 5px,
  rgba(139,30,63,.055) 5px,rgba(139,30,63,.055) 10px)}
.wt .tkt td.mk::after{content:"";position:absolute;inset:50% auto auto 50%;
  width:27px;height:27px;margin:-13.5px 0 0 -13.5px;border-radius:50%;
  background:radial-gradient(circle at 36% 32%,rgba(16,185,129,.8),rgba(4,120,87,.65) 70%);
  animation:wtstamp .3s cubic-bezier(.2,1.6,.4,1)}
@keyframes wtstamp{0%{transform:scale(.2);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1)}}
.wt .tkt td.mk{color:#06301f;font-weight:700}
/* Used only to point out a number the player FAILED to mark, after the fact. */
.wt .tkt td.oops{box-shadow:inset 0 0 0 2px #c04b4b}

/* Scrolls rather than clips. Six prize names do not fit across a phone, and
   the one that fell off the end was Full House - the prize the whole game is
   named after. */
.wt .bar-prizes{display:flex;gap:5px;overflow-x:auto;margin-top:9px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:2px}
.wt .bar-prizes::-webkit-scrollbar{display:none}
.wt .bar-prizes span{flex:none;padding:6px 9px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel);color:var(--dim);font:600 11.5px system-ui;white-space:nowrap}
.wt .bar-prizes span.able{border-color:var(--gold);color:var(--gold);
  animation:wtglow 1.4s ease-in-out infinite}
@keyframes wtglow{0%,100%{box-shadow:0 0 0 0 rgba(212,165,55,.35)}50%{box-shadow:0 0 0 5px rgba(212,165,55,0)}}
.wt .bar-prizes span.mine{background:var(--gold);border-color:var(--gold);color:#2b2118}

.wt .lobby{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.wt .who{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13.5px}
.wt .av{width:24px;height:24px;border-radius:50%;background:var(--maroon);color:#fff;
  display:grid;place-items:center;font:700 11px system-ui;flex:none}
.wt .warnbox{background:rgba(192,75,75,.1);border:1px solid rgba(192,75,75,.35);
  border-radius:10px;padding:10px;font-size:12.5px;color:#f0b8b8;margin-top:9px}
.wt .sealed{text-align:center;padding:26px 10px;background:var(--panel);
  border:1px solid var(--line);border-radius:12px;margin-top:9px}
.wt .cd{display:grid;place-items:center;min-height:250px}
.wt .cd .ring{width:130px;height:130px;border-radius:50%;display:grid;place-items:center;
  border:3px solid rgba(212,165,55,.35);animation:wtbeat 1s ease-in-out infinite}
@keyframes wtbeat{0%{transform:scale(1)}14%{transform:scale(1.07)}28%{transform:scale(1)}
  42%{transform:scale(1.05)}70%,100%{transform:scale(1)}}
.wt .cd .n{font:800 62px/1 ui-rounded,system-ui;color:var(--gold)}
.wt .ended{background:linear-gradient(160deg,rgba(139,30,63,.5),rgba(92,15,43,.55));
  border:1px solid rgba(212,165,55,.35);border-radius:12px;padding:13px}
.wt .ended .lbl{font:700 10.5px system-ui;letter-spacing:.15em;text-transform:uppercase;color:var(--gold)}
.wt .ended .why{margin-top:7px;font:600 15px/1.45 system-ui}
.wt .ended .why b{color:var(--gold)}
.wt .cta{display:block;text-align:center;background:var(--gold);color:#2b2118;
  border-radius:10px;padding:11px;font:700 13.5px system-ui;margin-top:9px}
.wt .exitbar{display:flex;justify-content:center;margin-top:10px}
.wt .exitbar span{border:1px solid var(--line);border-radius:9px;padding:8px 14px;
  color:var(--dim);font:600 12.5px system-ui}
.wt .askbox{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px}
.wt .askbox h4{margin:0 0 8px;font:800 16px system-ui;color:var(--text)}
@media (prefers-reduced-motion: reduce){
  .wt .tkt td.mk::after,.wt .cd .ring,.wt .bar-prizes span.able{animation:none}
}
`;

const HTML = `
  <div class="wt">
    <div class="screen" id="wtScreen"></div>
    <div class="cap" id="wtCap"></div>
    <div class="bar"><i id="wtBar"></i></div>
    <div class="step-of" id="wtStep"></div>
    <div class="ctrls">
      <button id="wtPlay"></button>
      <button id="wtSkip"></button>
    </div>
  </div>
`;

/**
 * The driver.
 *
 * Written as one string rather than a module because the whole page ships
 * inline - no build step, no second request, and it still works from a saved
 * copy months later.
 *
 * Reads `d` from the enclosing page scope: the same object that feeds the rest
 * of the demo, so the ticket on screen is a real generated ticket and the
 * prize names are the real prize names.
 */
const JS = `
(function(){
  var S  = document.getElementById('wtScreen');
  var C  = document.getElementById('wtCap');
  var B  = document.getElementById('wtBar');
  var ST = document.getElementById('wtStep');
  var PB = document.getElementById('wtPlay');
  var SK = document.getElementById('wtSkip');
  if (!S) return;

  var L = d.hi ? {
    play:'चलाएँ', pause:'रोकें', again:'फिर से', next:'आगे',
  } : {
    play:'Play', pause:'Pause', again:'Play again', next:'Skip ahead',
  };

  // The numbers this run will call. Real ticket numbers, plus a couple that
  // are not on the ticket, so the demo can show a "not on mine" answer.
  var mine = d.ticket.grid[0].filter(function(v){ return v !== null; });
  var row2 = d.ticket.grid[1].filter(function(v){ return v !== null; });
  var notMine = [];
  for (var n = 1; n <= 90 && notMine.length < 3; n++) {
    if (d.ticket.numbers.indexOf(n) < 0) notMine.push(n);
  }

  var marked = {};
  function ticket(opts){
    opts = opts || {};
    return '<div class="tkt"><table><tbody>' + d.ticket.grid.map(function(row){
      return '<tr>' + row.map(function(v){
        if (v === null) return '<td class="blank"></td>';
        var cls = marked[v] ? 'mk' : '';
        if (opts.oops === v) cls += ' oops';
        return '<td class="' + cls + '">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  function callout(num, seq){
    return '<div class="call">' +
      (seq ? '<div class="seq">Number ' + seq + ' of 90</div>' : '') +
      '<div class="n">' + (num == null ? '&ndash;' : num) + '</div>' +
      '<div class="t">' + (d.taglines[num] || '') + '</div></div>';
  }

  function answers(state){
    return '<div class="ans">' +
      '<span class="' + (state === 'yes' ? 'hit' : '') + '">' +
        (d.hi ? '✓ मेरे पास है' : '✓ I have it') + '</span>' +
      '<span class="' + (state === 'no' ? 'miss' : '') + '">' +
        (d.hi ? '✗ मेरे पास नहीं' : '✗ Not on mine') + '</span></div>';
  }

  function prizeBar(ableKey, mineKey){
    return '<div class="bar-prizes">' + d.prizes.map(function(p){
      var cls = p.key === mineKey ? 'mine' : (p.key === ableKey ? 'able' : '');
      return '<span class="' + cls + '">' + p.label + '</span>';
    }).join('') + '</div>';
  }

  // ---- the scenes -------------------------------------------------------
  //
  // Each is [caption, milliseconds, render]. The captions carry the rules the
  // pictures cannot: that a missed number is gone, that nothing marks your
  // ticket for you, and that leaving is final.

  var scenes = [];

  scenes.push([
    d.hi ? 'व्हाट्सएप पर <b>hi</b> भेजिए। कोई ऐप नहीं, कोई अकाउंट नहीं।'
         : 'It starts with <b>hi</b> on WhatsApp. No app, no account.',
    3000,
    function(){
      return '<div class="chat">' +
        '<div class="bub out">hi</div>' +
        '<div class="bub in">Namaste! Welcome to ' + d.brand + ' 🎉<br>' +
          'Tambola on WhatsApp — grab your friends and let\\'s play.' +
          '<div class="btnrow"><span class="chip">Play Tambola</span>' +
          '<span class="chip">Join a game</span><span class="chip">Options</span></div></div>' +
      '</div>';
    },
  ]);

  scenes.push([
    d.hi ? 'खिलाड़ियों की संख्या बताइए। रूम बन जाता है और लिंक मिल जाता है।'
         : 'Say how many are playing. You get a room and a link to share.',
    3400,
    function(){
      return '<div class="chat">' +
        '<div class="bub out">Play Tambola</div>' +
        '<div class="bub in">How many players will be joining, including you?</div>' +
        '<div class="bub out">4</div>' +
        '<div class="bub in">Your game room is ready! 🎉<br><b>Game code: MP4K9T</b><br>' +
          'The link to share is waiting inside your game room.' +
          '<div class="btnrow"><span class="chip">Open game room</span></div></div>' +
      '</div>';
    },
  ]);

  scenes.push([
    d.hi ? 'दोस्त लिंक टैप करते हैं और अंदर आ जाते हैं। शुरू करने के बाद कोई नहीं जुड़ सकता।'
         : 'Friends tap the link and they are in. <b>Once you start, nobody else can join.</b>',
    3600,
    function(){
      return '<div class="lobby">' +
        '<div style="font-weight:700;font-size:14px">Waiting for players</div>' +
        '<div class="muted" style="font-size:12.5px">4 of 4 joined</div>' +
        ['Rekha','Amruta','Ravi','Meera'].map(function(nm,i){
          return '<div class="who"><span class="av">' + nm[0] + '</span>' + nm +
            (i === 0 ? ' <span class="chip" style="padding:1px 6px;font-size:10px">host</span>' : '') +
            '</div>';
        }).join('') +
        '<div class="warnbox">Once you start, <b>nobody else can join</b> — latecomers ' +
          'are turned away.</div>' +
      '</div>' +
      '<div class="sealed">🎟️<div style="font-weight:700;margin-top:6px">Your ticket is sealed</div>' +
        '<div class="muted" style="font-size:12.5px">It opens the moment the game starts.</div></div>';
    },
  ]);

  scenes.push([
    d.hi ? 'गिनती शुरू। टिकट अभी खुलेगा।'
         : 'A short countdown, and the tickets open.',
    2600,
    function(){
      return '<div class="cd"><div><div class="ring"><div class="n" id="wtCd">3</div></div>' +
        '<div class="muted" style="text-align:center;margin-top:14px">Get your ticket ready…</div>' +
        '</div></div>';
    },
    function(){
      var n = 3;
      var t = setInterval(function(){
        var el = document.getElementById('wtCd');
        if (!el) return clearInterval(t);
        n--; el.textContent = n > 0 ? n : '▶';
        if (n <= 0) clearInterval(t);
      }, 800);
      return function(){ clearInterval(t); };
    },
  ]);

  scenes.push([
    d.hi ? 'हर ' + d.interval + ' सेकंड में एक नंबर। यह आपके टिकट पर है — आपको खुद ढूँढना है।'
         : 'A number every ' + d.interval + ' seconds. This one <b>is</b> on the ticket — but ' +
           'nothing on screen says so. Spotting it is the game.',
    4200,
    function(){
      return callout(mine[0], 1) + answers(null) + ticket() + prizeBar();
    },
  ]);

  scenes.push([
    d.hi ? 'सही टैप करने पर निशान लग जाता है।'
         : 'Tap <b>I have it</b> and the dauber lands. The board never marks it for you.',
    3000,
    function(){
      marked[mine[0]] = true;
      return callout(mine[0], 1) + answers('yes') + ticket() + prizeBar();
    },
  ]);

  scenes.push([
    d.hi ? 'जो नंबर आपके टिकट पर नहीं है — बस "मेरे पास नहीं" दबाइए।'
         : 'A number that is not yours costs nothing. Say so and wait for the next.',
    3000,
    function(){
      return callout(notMine[0], 2) + answers('no') + ticket() + prizeBar();
    },
  ]);

  scenes.push([
    d.hi ? 'चूक गए तो वह नंबर वापस नहीं आता। यही सबसे महँगी गलती है।'
         : 'Miss one and it does not come back. <b>An unmarked number cannot win a prize.</b>',
    4200,
    function(){
      return callout(mine[1], 3) + answers(null) + ticket({ oops: mine[1] }) +
        '<div class="muted" style="font-size:12.5px;margin-top:8px;color:#f0b8b8">' +
        (d.hi ? 'यह आपके टिकट पर था — निशान नहीं लगा।'
              : 'That one was on the ticket and went unmarked.') + '</div>';
    },
  ]);

  scenes.push([
    d.hi ? 'पंक्ति पूरी होते ही इनाम जल उठता है। दावा करना आपका काम है।'
         : 'Complete a pattern and the prize lights up. <b>Claiming it is still your tap.</b>',
    4000,
    function(){
      mine.forEach(function(v){ marked[v] = true; });
      return callout(mine[mine.length - 1], 9) + ticket() +
        prizeBar('top_line') +
        '<div class="muted" style="font-size:12.5px;margin-top:8px;color:var(--gold)">' +
        (d.prizes[1] ? d.prizes[1].label : 'Top Line') +
        (d.hi ? ' — दावा कीजिए!' : ' — tap it to claim!') + '</div>';
    },
  ]);

  scenes.push([
    d.hi ? 'दावा मंज़ूर। यह अब आपका है।'
         : 'Claimed. It is checked against the numbers actually called, not against your marks.',
    3200,
    function(){
      return callout(mine[mine.length - 1], 9) + ticket() + prizeBar(null, 'top_line');
    },
  ]);

  scenes.push([
    d.hi ? 'कभी भी बाहर निकल सकते हैं — लेकिन वापस नहीं आ सकते।'
         : 'You can leave at any time — but <b>you cannot rejoin</b>.',
    4000,
    function(){
      return '<div class="askbox"><h4>Leave this game?</h4>' +
        '<div class="muted" style="font-size:13px">Your ticket is forfeited and any prizes ' +
        'still to come are out of reach.</div>' +
        '<div class="warnbox"><b>You cannot rejoin.</b> This game is closed to you once you ' +
        'leave, even if you still have the link.</div>' +
        '<div class="ans" style="margin-top:12px">' +
        '<span class="hit">Keep playing</span><span>Leave</span></div></div>';
    },
  ]);

  scenes.push([
    d.hi ? 'खेल खत्म होने पर वजह साफ़ दिखती है।'
         : 'When it ends, the board says why — and who ended it.',
    3600,
    function(){
      return '<div class="ended"><div class="lbl">Game over</div>' +
        '<div class="why"><b>Meera</b> completed a full ticket. That is Full House, ' +
        'and the game ends here.</div></div>' +
        '<div style="margin-top:9px" class="muted">Prizes, and how accurately everyone ' +
        'marked, are revealed now — never during the game.</div>';
    },
  ]);

  scenes.push([
    d.hi ? 'रिपोर्ट, फीडबैक और पूरा इतिहास — सब व्हाट्सएप पर।'
         : 'Your report arrives on WhatsApp, with feedback and your full play history.',
    4200,
    function(){
      return '<div class="chat">' +
        '<div class="bub in">Your full report for game <b>MP4K9T</b> — your ticket, every ' +
          'number called, and how you marked it.</div>' +
        '<div class="bub in">How was that game?' +
          '<div class="btnrow"><span class="chip">Provide Feedback</span></div></div>' +
        '<div class="bub in">Options → <b>Get my play history</b>' +
          '<div class="btnrow"><span class="chip">Get my history</span></div></div>' +
      '</div>';
    },
  ]);

  // ---- the projector ----------------------------------------------------
  var i = 0, timer = null, barTimer = null, cleanup = null, playing = false;

  function paint(){
    if (cleanup) { cleanup(); cleanup = null; }
    var sc = scenes[i];
    S.innerHTML = sc[2]();
    C.innerHTML = sc[0];
    ST.textContent = (i + 1) + ' / ' + scenes.length;
    if (sc[3]) cleanup = sc[3]();

    // The bar is driven by the same duration the timer uses, so it always
    // reaches the end exactly as the scene changes.
    B.style.transition = 'none'; B.style.width = '0%';
    if (barTimer) clearTimeout(barTimer);
    barTimer = setTimeout(function(){
      B.style.transition = 'width ' + sc[1] + 'ms linear';
      B.style.width = '100%';
    }, 30);
  }

  function advance(){
    i++;
    if (i >= scenes.length) { i = scenes.length - 1; stop(true); return; }
    paint();
    timer = setTimeout(advance, scenes[i][1]);
  }

  function start(fromBeginning){
    if (fromBeginning) { i = 0; marked = {}; }
    playing = true; PB.textContent = L.pause;
    paint();
    if (timer) clearTimeout(timer);
    timer = setTimeout(advance, scenes[i][1]);
  }

  function stop(finished){
    playing = false;
    if (timer) clearTimeout(timer);
    if (barTimer) clearTimeout(barTimer);
    B.style.transition = 'none';
    PB.textContent = finished ? L.again : L.play;
  }

  PB.onclick = function(){
    if (playing) return stop(false);
    start(i >= scenes.length - 1);
  };
  SK.textContent = L.next;
  SK.onclick = function(){
    if (timer) clearTimeout(timer);
    i = (i + 1) % scenes.length;
    if (i === 0) marked = {};
    paint();
    if (playing) timer = setTimeout(advance, scenes[i][1]);
  };

  // Starts by itself, so the page explains the game without being asked. It is
  // silent and on-page, so this cannot be the autoplay that annoys anyone.
  start(true);
})();
`;
