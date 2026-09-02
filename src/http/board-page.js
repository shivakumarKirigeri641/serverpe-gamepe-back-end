/**
 * The board page: lobby, play and results in one self-contained document.
 *
 * No build step, no framework, no external requests. It is opened inside
 * WhatsApp's in-app browser on a phone that may be on a weak connection, so
 * everything - styles, script, fonts - ships inline and the page renders on
 * first paint.
 *
 * The client is deliberately dumb: it never computes game state. It renders
 * whatever the server sends, and on any doubt it re-fetches the whole
 * snapshot rather than trying to patch what it thinks it missed.
 */
import { config } from '../config/env.js';

export function boardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16151a">
<title>${esc(config.brandName)} - Tambola</title>
<style>
:root{
  --ink:#2b2118; --paper:#f4ecd8; --paper-edge:#e2d5b8;
  --maroon:#8b1e3f; --maroon-deep:#5c0f2b; --gold:#d4a537;
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5;
  --ok:#3fa46a; --no:#c04b4b;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--text);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-text-size-adjust:100%;
  padding-bottom:env(safe-area-inset-bottom);
}
.wrap{max-width:520px;margin:0 auto;padding:12px 12px 96px}

/* ---- header ---- */
header{display:flex;align-items:center;gap:10px;padding:6px 2px 12px}
.brand{font-weight:700;letter-spacing:.02em;color:var(--gold)}
.code{margin-left:auto;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--panel);border:1px solid var(--line);padding:6px 9px;border-radius:7px;letter-spacing:.12em}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.dot.off{background:var(--no)}
.dot.wait{background:var(--gold)}

/* ---- called number banner ---- */
.callout{
  background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border-radius:16px;padding:16px;text-align:center;position:relative;overflow:hidden;
  box-shadow:0 6px 20px rgba(0,0,0,.35);
}
.callout .num{
  font:800 68px/1 ui-rounded,system-ui,sans-serif;color:#fff;
  text-shadow:0 3px 0 rgba(0,0,0,.25); letter-spacing:-.02em;
}
.callout .num.pop{animation:pop .45s cubic-bezier(.2,1.5,.4,1)}
@keyframes pop{0%{transform:scale(.4);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
.callout .tag{color:#f7dfa5;font-size:14px;margin-top:6px;min-height:1.4em}
.callout .seq{position:absolute;top:10px;left:12px;font-size:11px;color:#f7dfa5;opacity:.75}
.timer{position:absolute;top:8px;right:10px;width:34px;height:34px}
.timer circle{fill:none;stroke-width:3}
.timer .bg{stroke:rgba(255,255,255,.18)}
.timer .fg{stroke:var(--gold);stroke-linecap:round;transition:stroke-dashoffset .95s linear}
.timer text{fill:#f7dfa5;font-size:12px;text-anchor:middle;dominant-baseline:central}

/* ---- yes / no ---- */
.answer{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
.answer button{
  padding:14px 8px;border-radius:12px;border:1px solid var(--line);
  background:var(--panel);color:var(--text);font:600 15px system-ui;cursor:pointer;
  transition:transform .08s,background .15s;
}
.answer button:active{transform:scale(.97)}
.answer button.yes.on{background:var(--ok);border-color:var(--ok);color:#fff}
.answer button.no.on{background:var(--no);border-color:var(--no);color:#fff}
.answer button[disabled]{opacity:.45;cursor:default}
.nudge{text-align:center;font-size:13px;color:var(--dim);min-height:1.3em;margin:-4px 0 8px}
.nudge.good{color:var(--ok)} .nudge.bad{color:var(--gold)}

/* ---- waiting for the rest of the table ---- */
.waiting{
  display:flex;align-items:center;gap:10px;justify-content:center;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:12px;margin:10px 0;font-size:14px;color:var(--dim);
}
.waiting .spin{
  width:15px;height:15px;border-radius:50%;flex:none;
  border:2px solid var(--line);border-top-color:var(--gold);
  animation:spin .9s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.waiting b{color:var(--text)}
.waiting .left{margin-left:auto;font:700 15px ui-monospace,Menlo,monospace;color:var(--gold)}

/* ---- the invite link, for the host ---- */
.invite{background:rgba(212,165,55,.08);border:1px solid rgba(212,165,55,.3);
  border-radius:12px;padding:12px;margin-top:14px}
.invite-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;
  color:var(--gold);font-weight:700;margin-bottom:8px}
.invite-row{display:flex;gap:8px;align-items:stretch}
.invite-row code{flex:1;min-width:0;background:rgba(0,0,0,.35);border-radius:8px;
  padding:10px;font:12px/1.35 ui-monospace,Menlo,monospace;color:var(--text);
  word-break:break-all;max-height:52px;overflow:hidden}
.copy{flex:none;padding:0 16px;border-radius:8px;border:0;cursor:pointer;
  background:var(--gold);color:#2b2118;font:700 13px system-ui}
.copy.done{background:var(--ok);color:#fff}
.invite-hint{font-size:12px;color:var(--dim);margin-top:8px}

/* ---- a player waiting in the lobby ---- */
.waiting-host{display:flex;gap:12px;align-items:center;margin-top:14px;
  background:rgba(255,255,255,.04);border:1px solid var(--line);
  border-radius:12px;padding:13px}
.waiting-host .pulse{width:11px;height:11px;border-radius:50%;background:var(--gold);
  flex:none;animation:pulse 1.6s ease-out infinite}
@keyframes pulse{
  0%{box-shadow:0 0 0 0 rgba(212,165,55,.6)}
  70%{box-shadow:0 0 0 11px rgba(212,165,55,0)}
  100%{box-shadow:0 0 0 0 rgba(212,165,55,0)}
}

/* ---- the 5-second countdown before the first number ---- */
#countdown{
  position:fixed;inset:0;z-index:60;display:grid;place-items:center;
  background:radial-gradient(circle at 50% 45%,rgba(92,15,43,.97),rgba(12,11,15,.99) 70%);
  backdrop-filter:blur(3px);
}
#countdown .ring{
  width:200px;height:200px;border-radius:50%;display:grid;place-items:center;
  border:3px solid rgba(212,165,55,.35);
  box-shadow:0 0 60px rgba(212,165,55,.28), inset 0 0 40px rgba(212,165,55,.12);
}
#countdown .n{
  font:800 96px/1 ui-rounded,system-ui,sans-serif;color:var(--gold);
  text-shadow:0 0 40px rgba(212,165,55,.5);
}
/* Re-triggered on each tick, so every digit lands with the same beat. */
#countdown .n.tick{animation:tick .9s cubic-bezier(.2,1.4,.35,1)}
@keyframes tick{0%{transform:scale(.35);opacity:0}45%{transform:scale(1.14);opacity:1}100%{transform:scale(1);opacity:1}}

/* The ring beats once per second, like a pulse. Two quick squeezes per beat -
   a single ease looks like breathing; a double looks like a heart. */
#countdown .ring{animation:heartbeat 1s ease-in-out infinite}
@keyframes heartbeat{
  0%{transform:scale(1)}
  14%{transform:scale(1.07)}
  28%{transform:scale(1)}
  42%{transform:scale(1.05)}
  70%,100%{transform:scale(1)}
}
#countdown .cap{margin-top:22px;text-align:center;color:#f7dfa5;font-size:15px;letter-spacing:.04em}

/* The moment it hits zero. */
#countdown .go{
  font:800 44px/1.1 ui-rounded,system-ui;color:var(--gold);text-align:center;
  animation:burst .6s cubic-bezier(.2,1.5,.35,1);
}
@keyframes burst{0%{transform:scale(.4) rotate(-6deg);opacity:0}
  60%{transform:scale(1.15) rotate(2deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
#countdown.go-time .ring{
  animation:none;border-color:rgba(212,165,55,.8);
  box-shadow:0 0 120px rgba(212,165,55,.55), inset 0 0 60px rgba(212,165,55,.25);
}

/* ---- game over celebration ---- */
.celebrate{
  position:relative;overflow:hidden;text-align:center;
  background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border:1px solid rgba(212,165,55,.4);border-radius:16px;padding:26px 16px;margin:10px 0;
}
.celebrate .cup{font-size:52px;line-height:1;animation:bounce 1.1s ease-in-out infinite}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
.celebrate h2{margin:10px 0 4px;font-size:15px;letter-spacing:.16em;text-transform:uppercase;color:#f7dfa5}
.celebrate .who{font:800 30px/1.15 ui-rounded,system-ui;color:#fff;margin:6px 0}
.celebrate .what{color:var(--gold);font-weight:700;font-size:17px}
.celebrate .sub{color:#f7dfa5;opacity:.85;font-size:13px;margin-top:10px}
/* Confetti is drawn, not imported - no asset request on a weak connection. */
.confetti{position:absolute;top:-12px;width:9px;height:14px;opacity:.9;
  animation:fall linear forwards}
@keyframes fall{
  0%{transform:translateY(-20px) rotate(0);opacity:1}
  100%{transform:translateY(420px) rotate(720deg);opacity:0}
}

/* ---- the ticket: printed paper ---- */
.ticket{
  background:var(--paper);color:var(--ink);border-radius:4px;margin:12px 0;
  box-shadow:0 4px 14px rgba(0,0,0,.4);
  /* faint fibre texture, no image request */
  background-image:radial-gradient(rgba(139,30,63,.05) 1px,transparent 1px);
  background-size:7px 7px;
}
.ticket .stub{
  display:flex;align-items:center;gap:8px;padding:7px 10px;
  border-bottom:1px dashed var(--paper-edge);
  font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;
  color:var(--maroon);text-transform:uppercase;
}
.ticket .stub .no{margin-left:auto;opacity:.65;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;table-layout:fixed}
td{
  border:1px solid rgba(139,30,63,.45); height:52px; text-align:center; position:relative;
  font:600 20px/1 Georgia,"Times New Roman",serif; color:var(--ink);
}
td.blank{background:repeating-linear-gradient(45deg,transparent,transparent 5px,
  rgba(139,30,63,.055) 5px,rgba(139,30,63,.055) 10px)}
/* the dauber blot: number stays readable underneath */
td.marked::after{
  content:"";position:absolute;inset:50% auto auto 50%;
  width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;
  /* Emerald on cream: complementary to the maroon rules, far brighter than a
     red blot on warm paper, and the number stays legible underneath. */
  background:radial-gradient(circle at 36% 32%,rgba(16,185,129,.78),rgba(4,120,87,.62) 70%);
  box-shadow:0 0 0 1px rgba(4,120,87,.25) inset, 0 1px 4px rgba(4,120,87,.35);
  animation:stamp .3s cubic-bezier(.2,1.6,.4,1);
}
@keyframes stamp{0%{transform:scale(.2);opacity:0}70%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
td.marked{color:#06301f;font-weight:700}
td.hit{box-shadow:inset 0 0 0 3px var(--gold)}

/* ---- called numbers panel ---- */
details.called{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:10px 0}
details.called summary{padding:11px 13px;cursor:pointer;font-size:14px;color:var(--dim);list-style:none}
details.called summary::-webkit-details-marker{display:none}
details.called summary::after{content:"▾";float:right;transition:transform .2s}
details.called[open] summary::after{transform:rotate(180deg)}
.grid90{display:grid;grid-template-columns:repeat(10,1fr);gap:3px;padding:0 10px 12px}
.grid90 span{
  aspect-ratio:1;display:grid;place-items:center;border-radius:5px;
  font:600 11px ui-monospace,Menlo,monospace;background:#26232d;color:#5f5a6b;
}
.grid90 span.on{background:var(--maroon);color:#fff}
.grid90 span.last{background:var(--gold);color:#2b2118}

/* ---- claims ---- */
.claims{
  position:fixed;left:0;right:0;bottom:0;background:rgba(22,21,26,.97);
  border-top:1px solid var(--line);padding:8px 10px calc(8px + env(safe-area-inset-bottom));
  backdrop-filter:blur(8px);
}
.claims .row{display:flex;gap:6px;overflow-x:auto;max-width:520px;margin:0 auto;scrollbar-width:none}
.claims .row::-webkit-scrollbar{display:none}
.claims button{
  flex:none;padding:9px 12px;border-radius:9px;border:1px solid var(--line);
  background:var(--panel);color:var(--dim);font:600 13px system-ui;cursor:pointer;white-space:nowrap;
}
.claims button.able{border-color:var(--gold);color:var(--gold);
  animation:glow 1.6s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(212,165,55,.35)}50%{box-shadow:0 0 0 6px rgba(212,165,55,0)}}
.claims button.gone{opacity:.4;text-decoration:line-through;cursor:default}
.claims button.mine{background:var(--gold);color:#2b2118;border-color:var(--gold);text-decoration:none}

/* ---- lobby / results ---- */
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0}
.card h2{margin:0 0 4px;font-size:17px;color:var(--gold)}
.muted{color:var(--dim);font-size:14px}
.plist{list-style:none;padding:0;margin:12px 0 0}
.plist li{display:flex;align-items:center;gap:9px;padding:8px 0;border-top:1px solid var(--line)}
.plist li:first-child{border-top:0}
.av{width:30px;height:30px;border-radius:50%;background:var(--maroon);display:grid;place-items:center;
  font:700 13px system-ui;color:#fff;flex:none}
.tagpill{margin-left:auto;font-size:11px;color:var(--gold);border:1px solid var(--gold);
  padding:2px 7px;border-radius:99px}
.btn{display:block;width:100%;padding:15px;border-radius:12px;border:0;cursor:pointer;
  font:700 16px system-ui;background:var(--gold);color:#2b2118;margin-top:12px}
.btn[disabled]{opacity:.4;cursor:default}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.warn{background:rgba(212,165,55,.1);border:1px solid rgba(212,165,55,.35);
  border-radius:10px;padding:11px;font-size:13px;color:#f7dfa5;margin-top:12px}
.prizes{list-style:none;padding:0;margin:8px 0 0}
.prizes li{display:flex;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.prizes li b{margin-left:auto;color:var(--gold);font-weight:600}
.prizes li.none b{color:var(--dim);font-weight:400}

/* ---- toast feed ---- */
#toasts{position:fixed;top:8px;left:0;right:0;display:flex;flex-direction:column;
  align-items:center;gap:6px;pointer-events:none;z-index:20}
.toast{background:var(--maroon);color:#fff;padding:9px 15px;border-radius:99px;
  font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.4);animation:drop .3s}
@keyframes drop{from{transform:translateY(-14px);opacity:0}}
.hidden{display:none!important}
</style>
</head>
<body>
<div id="toasts"></div>
<div class="wrap">
  <header>
    <span class="dot wait" id="conn" title="connecting"></span>
    <span class="brand">${esc(config.brandName)}</span>
    <span class="code" id="code">------</span>
  </header>
  <div id="view"><p class="muted">Loading your game…</p></div>
</div>
<div class="claims hidden" id="claimbar"><div class="row" id="claimrow"></div></div>

<script>
(function(){
  "use strict";
  var TOKEN = location.pathname.split('/board/')[1].split('/')[0];
  var BASE  = location.pathname.split('/board/')[0] + '/board/' + TOKEN;

  var state = null, es = null, tick = null, answeredSeq = 0, lastRendered = '';

  var view = document.getElementById('view');
  var conn = document.getElementById('conn');
  var claimbar = document.getElementById('claimbar');
  var claimrow = document.getElementById('claimrow');

  // ---- helpers ----
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function initials(n){ return String(n||'?').trim().charAt(0).toUpperCase(); }
  function post(path, body){
    return fetch(BASE + path, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})
    }).then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); });
  }
  function toast(msg){
    var el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(function(){ el.remove(); }, 4200);
  }
  function setConn(cls, title){ conn.className = 'dot ' + cls; conn.title = title; }

  // ---- live connection ----
  // EventSource reconnects by itself; we only have to re-sync state when it
  // does, which is what makes a suspended in-app browser recover cleanly.
  function connect(){
    if (es) es.close();
    es = new EventSource(BASE + '/stream');

    es.addEventListener('open', function(){ setConn('', 'live'); });
    es.addEventListener('error', function(){ setConn('off', 'reconnecting…'); });

    es.addEventListener('state', function(e){ apply(JSON.parse(e.data)); });
    es.addEventListener('state_stale', function(){ refresh(); });

    // The host has started. Everyone counts down together; the first number is
    // scheduled to land exactly as this reaches zero.
    es.addEventListener('started', function(e){
      var d = JSON.parse(e.data || '{}');
      runCountdown(d.countdownSeconds || 5);
    });

    es.addEventListener('draw', function(e){
      var d = JSON.parse(e.data);
      if (!state) return refresh();
      hideCountdown();
      state.game.status = 'running';
      state.draws.push({seq:d.seq, value:d.value, tagline:d.tagline});
      state.current = d;
      state.secondsLeft = d.intervalSeconds;
      state.yourAnswer = null;
      state.progress = {answered:0, total: state.progress ? state.progress.total : state.joined};
      answeredSeq = 0;
      render(true);
      refreshClaims();
    });

    // Somebody else answered - update the "waiting for N" line without a fetch.
    es.addEventListener('answers', function(e){
      var d = JSON.parse(e.data);
      if (!state || !state.current || d.seq !== state.current.seq) return;
      state.progress = {answered:d.answered, total:d.total};
      paintWaiting();
    });

    es.addEventListener('claim', function(e){
      var c = JSON.parse(e.data);
      toast(c.winner + ' claimed ' + c.label + '!');
      refreshClaims();
    });

    es.addEventListener('game_over', function(e){
      var d = JSON.parse(e.data || '{}');
      hideCountdown();
      lastWinner = d;
      refresh();
    });
  }

  // ---- countdown ----
  var lastWinner = null, countdownTimer = null;

  function runCountdown(seconds){
    hideCountdown();
    var el = document.createElement('div');
    el.id = 'countdown';
    el.innerHTML = '<div><div class="ring"><div class="n" id="cdN"></div></div>' +
      '<div class="cap">Get your ticket ready…</div></div>';
    document.body.appendChild(el);

    var n = seconds;
    var node = document.getElementById('cdN');
    var cap = el.querySelector('.cap');

    var paint = function(){
      if (n > 0) {
        node.textContent = n;
        // Re-trigger the animation by removing and re-adding the class.
        node.className = 'n'; void node.offsetWidth; node.className = 'n tick';
      } else {
        // Zero: the heartbeat stops, the ring flares, and the numbers start.
        el.classList.add('go-time');
        node.innerHTML = '<span class="go">BINGO!</span>';
        cap.textContent = 'Numbers starting…';
      }
    };

    paint();
    countdownTimer = setInterval(function(){
      n--;
      if (n < 0) { hideCountdown(); refresh(); return; }
      paint();
      // Hold "BINGO!" on screen for a moment before the board appears, rather
      // than flashing it for a frame.
      if (n === 0) { clearInterval(countdownTimer); countdownTimer = setTimeout(function(){
        hideCountdown(); refresh();
      }, 1100); }
    }, 1000);
  }

  function hideCountdown(){
    // Could be either by now - the last tick swaps the interval for a timeout.
    if (countdownTimer) { clearInterval(countdownTimer); clearTimeout(countdownTimer); countdownTimer = null; }
    var el = document.getElementById('countdown');
    if (el) el.remove();
  }

  function refresh(){
    return fetch(BASE + '/state').then(function(r){
      if (!r.ok) throw new Error('state ' + r.status);
      return r.json();
    }).then(apply).catch(function(){ setConn('off','offline'); });
  }
  function refreshClaims(){
    return fetch(BASE + '/state').then(function(r){ return r.json(); })
      .then(function(s){ state.prizes = s.prizes; renderClaims(); });
  }

  function apply(s){
    var wasStatus = state && state.game.status;
    state = s;
    document.getElementById('code').textContent = s.game.code;
    setConn('', 'live');
    render(wasStatus !== s.game.status);
  }

  // ---- rendering ----
  function render(force){
    if (!state) return;
    var key = state.game.status;
    if (key === 'lobby') renderLobby();
    else if (key === 'running') renderGame(force);
    else renderOver();
  }

  function renderLobby(){
    claimbar.classList.add('hidden');
    var s = state;
    var need = Math.max(0, s.minPlayers - s.joined);
    // s.expected lives under s.game, not at the top level. Reading the wrong
    // one rendered "1 of undefined joined".
    var expected = s.game.expected;
    var html = '<div class="card">' +
      '<h2>Waiting for players</h2>' +
      '<div class="muted">' + s.joined + ' of ' + expected + ' joined' +
        (need > 0 ? ' &middot; ' + need + ' more needed to start' : '') + '</div>' +
      '<ul class="plist">' + s.players.map(function(p){
        return '<li><span class="av">' + esc(initials(p.name)) + '</span>' + esc(p.name) +
          (p.isHost ? '<span class="tagpill">host</span>' : '') + '</li>';
      }).join('') + '</ul>';

    if (s.you.isHost) {
      // The link, visibly, with one tap to copy it. A host who cannot find the
      // link cannot fill the room, and reading a URL aloud is not an option.
      if (s.invite) {
        html += '<div class="invite">' +
          '<div class="invite-label">Share this link with your players</div>' +
          '<div class="invite-row">' +
            '<code id="inviteLink">' + esc(s.invite) + '</code>' +
            '<button class="copy" id="copyBtn">Copy</button>' +
          '</div>' +
          '<div class="invite-hint">Paste it into your WhatsApp group. They tap it, ' +
            'accept the terms, and they are in.</div>' +
        '</div>';
      }

      var missing = Math.max(0, expected - s.joined);
      html += '<button class="btn" id="startBtn"' + (s.canStart ? '' : ' disabled') + '>' +
        'Start Game' + (missing > 0 ? ' with ' + s.joined + ' of ' + expected : '') + '</button>' +
        '<div class="warn">' +
          (missing > 0
            ? '<b>' + missing + ' of your ' + expected + ' players ' +
              (missing === 1 ? 'has' : 'have') + ' not joined yet.</b> '
            : '') +
          'Once you start, <b>nobody else can join</b> — latecomers will be turned away. ' +
          esc(s.brand) + ' becomes the host and calls the numbers, and you play as an ' +
          'ordinary player from then on.' +
        '</div>';
    } else {
      // A player waiting needs to know WHO they are waiting for and that
      // something is still happening - otherwise a quiet screen reads as broken.
      html += '<div class="waiting-host">' +
        '<span class="pulse"></span>' +
        '<div><b>Waiting for ' + esc(s.hostName || 'your host') + ' to start</b>' +
        '<div class="muted" style="font-size:13px;margin-top:2px">' +
          s.joined + ' of ' + expected + ' here' +
          (need > 0 ? ' · ' + need + ' more needed' : ' · ready when they are') +
        '</div></div></div>' +
        '<div class="muted" style="margin-top:10px;font-size:13.5px">' +
          'Your ticket is sealed until the game begins. Keep this screen open — ' +
          'it starts by itself.</div>';
    }

    // The ticket stays sealed until the game starts. Showing it in the lobby
    // gives people minutes to study it, which is not how tambola is played -
    // the first look should come with the first number.
    html += '</div>' +
      '<div class="card" style="text-align:center">' +
        '<div style="font-size:34px;line-height:1;margin-bottom:8px">🎟️</div>' +
        '<h2>Your ticket is sealed</h2>' +
        '<div class="muted">It opens the moment the game starts.</div>' +
      '</div>';

    setView(html, 'lobby-' + s.joined + '-' + s.canStart);

    var copyBtn = document.getElementById('copyBtn');
    if (copyBtn) copyBtn.onclick = function(){
      var link = document.getElementById('inviteLink').textContent;
      var done = function(){
        copyBtn.textContent = 'Copied!';
        copyBtn.classList.add('done');
        setTimeout(function(){ copyBtn.textContent = 'Copy'; copyBtn.classList.remove('done'); }, 1800);
      };
      // The async clipboard API needs a secure context, which the WhatsApp
      // in-app browser does not always provide. Fall back to the old trick.
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(link).then(done, legacy);
      } else { legacy(); }

      function legacy(){
        var ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); }
        catch (e) { toast('Press and hold the link to copy it'); }
        ta.remove();
      }
    };

    var b = document.getElementById('startBtn');
    if (b) b.onclick = function(){
      b.disabled = true; b.textContent = 'Starting…';
      post('/start').then(function(r){
        if (r.status !== 200) { toast(r.body.error || 'Could not start'); b.disabled = false; b.textContent = 'Start Game'; }
      });
    };
  }

  function renderGame(force){
    var s = state, cur = s.current;
    var html = '<div class="callout">' +
      (cur ? '<div class="seq">Number ' + cur.seq + ' of 90</div>' : '') +
      timerSvg() +
      '<div class="num' + (force ? '' : ' pop') + '" id="num">' + (cur ? cur.value : '–') + '</div>' +
      '<div class="tag">' + esc(cur ? cur.tagline : 'Get ready…') + '</div>' +
    '</div>' +
    '<div class="answer">' +
      '<button class="yes" id="yes">✓ I have it</button>' +
      '<button class="no" id="no">✗ Not on mine</button>' +
    '</div>' +
    '<div id="waitBox"></div>' +
    '<div class="nudge" id="nudge"></div>' +
    ticketHtml() + calledHtml();

    setView(html, 'game');
    wireAnswers();
    // Also on first paint, not only on later patches - otherwise the panel
    // renders as an empty bar until the second number arrives.
    updateCalled();
    updateTicket();
    startTimer();
    claimbar.classList.remove('hidden');
    renderClaims();
  }

  function renderOver(){
    claimbar.classList.add('hidden');
    if (tick) clearInterval(tick);
    hideCountdown();
    var r = state.results || {prizes:[], players:[]};
    var fullHouse = state.game.endedReason === 'full_house';
    var abandoned = state.game.endedReason === 'abandoned';
    var reason = fullHouse ? 'Full House! That is game.'
      : abandoned ? 'Too few players were left to carry on.'
      : 'All 90 numbers called.';

    // Who took the Full House - from the results, so a reload still shows it.
    var champ = (r.prizes.filter(function(p){ return p.key === 'full_house'; })[0] || {}).winner
      || (lastWinner && lastWinner.winner) || null;
    var youWon = champ && state.you && champ === state.you.name;

    var html = '';
    // No trophy and no confetti for an abandoned game - nobody won.
    if (abandoned) {
      html += '<div class="card" style="text-align:center">' +
        '<div style="font-size:38px;line-height:1;margin-bottom:6px">🛑</div>' +
        '<h2>Game ended early</h2>' +
        '<div class="muted">' + (lastWinner && lastWinner.leaver
          ? esc(lastWinner.leaver) + ' left, which left too few players to carry on.'
          : 'Too few players were left to carry on.') +
        ' No prizes were awarded.</div></div>';
    } else if (fullHouse && champ) {
      html += '<div class="celebrate" id="celebrate">' +
        '<div class="cup">' + (youWon ? '🏆' : '🎉') + '</div>' +
        '<h2>' + (youWon ? 'You did it' : 'Full House') + '</h2>' +
        '<div class="who">' + esc(champ) + '</div>' +
        '<div class="what">wins the Full House!</div>' +
        '<div class="sub">' + (youWon
          ? 'Every number on your ticket was called. Beautifully played.'
          : 'That brings the game to a close. Well played, everyone.') + '</div>' +
      '</div>';
    }

    html += '<div class="card"><h2>Game over</h2>' +
      '<div class="muted">' + esc(reason) + '</div>' +
      '<ul class="prizes">' + r.prizes.map(function(p){
        return '<li class="' + (p.winner ? '' : 'none') + '">' + esc(p.label) +
          '<b>' + esc(p.winner || 'unclaimed') + '</b></li>';
      }).join('') + '</ul></div>';

    // Only now is it revealed how accurately each player marked their own
    // ticket. During the game the server never says.
    if (r.players.length) {
      html += '<div class="card"><h2>How accurately you marked</h2>' +
        '<div class="muted">Your taps against what was actually called.</div>' +
        '<ul class="prizes">' +
        r.players.map(function(p){
          var pct = p.total ? Math.round((p.correct / p.total) * 100) : 0;
          var you = state.you && p.name === state.you.name;
          return '<li>' + (you ? '<b style="color:var(--gold)">You</b>' : esc(p.name)) +
            '<b>' + p.correct + '/' + p.total + ' &middot; ' + pct + '%</b></li>';
        }).join('') + '</ul></div>';
    }

    html += '<div class="card" style="text-align:center">' +
      '<h2>Thanks for playing!</h2>' +
      '<div class="muted">Head back to WhatsApp — we have sent you your game report, ' +
      'and you can rate the game there.</div>' +
      '<a class="btn" style="display:block;margin-top:12px;text-decoration:none" ' +
      'href="https://wa.me/' + esc(state.businessNumber || '') + '">Back to WhatsApp</a>' +
      '</div>' + ticketHtml();

    setView(html, 'over');
    if (fullHouse && champ && !abandoned) confetti();
  }

  /** A short burst of drawn confetti. No asset request, no library. */
  function confetti(){
    var host = document.getElementById('celebrate');
    if (!host) return;
    var colours = ['#d4a537', '#ffffff', '#10b981', '#ff6b8a', '#f7dfa5'];
    for (var i = 0; i < 34; i++) {
      var bit = document.createElement('span');
      bit.className = 'confetti';
      bit.style.left = Math.random() * 100 + '%';
      bit.style.background = colours[i % colours.length];
      bit.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
      bit.style.animationDelay = (Math.random() * 0.7) + 's';
      host.appendChild(bit);
    }
    setTimeout(function(){
      host.querySelectorAll('.confetti').forEach(function(c){ c.remove(); });
    }, 4200);
  }

  /** Replaces the view only when the shape actually changed, so the ticket
   *  does not visibly re-mount on every single draw. */
  function setView(html, key){
    if (key === 'game' && lastRendered === 'game') { patchGame(); return; }
    view.innerHTML = html;
    lastRendered = key;
  }

  function patchGame(){
    var cur = state.current;
    var num = document.getElementById('num');
    if (num && cur && num.textContent !== String(cur.value)) {
      num.textContent = cur.value;
      num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
      var seqEl = document.querySelector('.callout .seq');
      if (seqEl) seqEl.textContent = 'Number ' + cur.seq + ' of 90';
      document.querySelector('.callout .tag').textContent = cur.tagline;
      document.getElementById('nudge').textContent = '';
      document.getElementById('nudge').className = 'nudge';
    }
    updateTicket(); updateCalled(); wireAnswers(); startTimer();
  }

  // ---- ticket ----
  function ticketHtml(){
    var t = state.ticket; if (!t) return '';
    var marked = state.marked || [];
    var rows = t.grid.map(function(row){
      return '<tr>' + row.map(function(v){
        if (v === null) return '<td class="blank"></td>';
        return '<td data-n="' + v + '" class="' + (marked.indexOf(v) >= 0 ? 'marked' : '') + '">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="ticket"><div class="stub">' + esc(state.brand) +
      '<span class="no">Ticket ' + esc(state.game.code) + '</span></div>' +
      '<table><tbody>' + rows + '</tbody></table></div>';
  }

  function updateTicket(){
    var marked = state.marked || [];
    var cur = state.current;
    document.querySelectorAll('.ticket td[data-n]').forEach(function(td){
      var n = Number(td.dataset.n);
      td.classList.toggle('marked', marked.indexOf(n) >= 0);
      td.classList.toggle('hit', !!(cur && cur.value === n));
    });
  }

  // ---- called numbers ----
  function calledHtml(){
    return '<details class="called"><summary id="calledSum"></summary>' +
      '<div class="grid90" id="grid90"></div></details>';
  }
  function updateCalled(){
    var sum = document.getElementById('calledSum');
    var grid = document.getElementById('grid90');
    if (!sum || !grid) return;
    var drawn = {}; state.draws.forEach(function(d){ drawn[d.value] = true; });
    var last = state.current ? state.current.value : null;
    sum.textContent = 'Numbers called (' + state.draws.length + ' of 90)';
    if (grid.childElementCount !== 90) {
      var h = '';
      for (var i = 1; i <= 90; i++) h += '<span data-v="' + i + '">' + i + '</span>';
      grid.innerHTML = h;
    }
    grid.querySelectorAll('span').forEach(function(el){
      var v = Number(el.dataset.v);
      el.className = drawn[v] ? (v === last ? 'on last' : 'on') : '';
    });
  }

  // ---- answering ----
  function wireAnswers(){
    var cur = state.current;
    var yes = document.getElementById('yes'), no = document.getElementById('no');
    if (!yes || !no) return;

    // A reopened page must respect an answer already given, so this trusts the
    // server's yourAnswer rather than only what this tab remembers.
    var given = state.yourAnswer || (cur && answeredSeq === cur.seq ? 'given' : null);
    yes.disabled = no.disabled = !cur || !!given;
    yes.classList.toggle('on', state.yourAnswer === 'yes');
    no.classList.toggle('on', state.yourAnswer === 'no');

    yes.onclick = function(){ answer('yes'); };
    no.onclick  = function(){ answer('no'); };
    paintWaiting();
  }

  /**
   * "Waiting for the others" - only shown once this player has answered.
   * Before that the countdown in the banner is the thing to look at.
   */
  function paintWaiting(){
    var box = document.getElementById('waitBox');
    if (!box) return;
    var p = state.progress || {answered:0,total:0};
    var mine = state.yourAnswer || (state.current && answeredSeq === state.current.seq);

    if (!mine || !state.current) { box.innerHTML = ''; return; }

    var others = Math.max(0, p.total - p.answered);
    box.innerHTML = '<div class="waiting">' +
      (others > 0 ? '<span class="spin"></span>' : '<span>✓</span>') +
      '<span>' + (others > 0
        ? 'Waiting for <b>' + others + '</b> more player' + (others === 1 ? '' : 's') + '…'
        : 'Everyone has answered - next number coming up') + '</span>' +
      '<span class="left" id="waitLeft"></span>' +
    '</div>';
  }

  function answer(a){
    var cur = state.current; if (!cur) return;
    answeredSeq = cur.seq;
    var yes = document.getElementById('yes'), no = document.getElementById('no');
    yes.disabled = no.disabled = true;
    (a === 'yes' ? yes : no).classList.add('on');

    post('/answer', {seq:cur.seq, answer:a}).then(function(r){
      var n = document.getElementById('nudge');
      if (r.status !== 200) {
        n.textContent = r.body.error || 'Could not record that';
        yes.disabled = no.disabled = false;
        return;
      }
      var d = r.body;

      // Always reflect the answer the SERVER stored. On a double tap the second
      // one is discarded, and showing the tap that did not count would be a lie.
      a = d.answer;
      state.yourAnswer = a;
      state.progress = {answered:d.answered, total:d.total};

      yes.classList.toggle('on', a === 'yes');
      no.classList.toggle('on', a === 'no');

      // The ticket follows the PLAYER'S OWN answer, and the server does not say
      // whether it was right. Marking is theirs to get right; how they did is
      // revealed when the game ends. A wrong tap costs accuracy and nothing
      // else - claims are validated against the numbers actually called.
      if (a === 'yes' && state.marked.indexOf(d.value) < 0) state.marked.push(d.value);
      if (a === 'no') {
        var at = state.marked.indexOf(d.value);
        if (at >= 0) state.marked.splice(at, 1);
      }

      n.textContent = '';
      n.className = 'nudge';
      updateTicket(); paintWaiting(); refreshClaims();
    });
  }

  // ---- countdown ----
  function timerSvg(){
    return '<svg class="timer" viewBox="0 0 36 36">' +
      '<circle class="bg" cx="18" cy="18" r="15"></circle>' +
      '<circle class="fg" id="ring" cx="18" cy="18" r="15" ' +
        'transform="rotate(-90 18 18)" stroke-dasharray="94.2" stroke-dashoffset="0"></circle>' +
      '<text x="18" y="18" id="ringT"></text></svg>';
  }
  function startTimer(){
    if (tick) clearInterval(tick);
    var left = state.secondsLeft == null ? state.game.drawInterval : state.secondsLeft;
    var total = state.game.drawInterval || 12;
    paint();
    tick = setInterval(function(){ left = Math.max(0, left - 1); paint(); }, 1000);
    function paint(){
      var ring = document.getElementById('ring'), t = document.getElementById('ringT');
      if (!ring) return;
      ring.setAttribute('stroke-dashoffset', String(94.2 * (1 - Math.max(0, left) / total)));
      t.textContent = left > 0 ? left : '';
      var wl = document.getElementById('waitLeft');
      if (wl) wl.textContent = left > 0 ? left + 's' : '';
    }
  }

  // ---- claims ----
  function renderClaims(){
    if (!state.prizes) return;
    claimrow.innerHTML = state.prizes.map(function(p){
      var cls = p.awarded ? (p.awarded.isYou ? 'mine' : 'gone') : (p.eligible ? 'able' : '');
      var label = p.awarded ? p.label + ' · ' + p.awarded.winner : p.label;
      return '<button data-k="' + p.key + '" class="' + cls + '"' +
        (p.awarded ? ' disabled' : '') + '>' + esc(label) + '</button>';
    }).join('');

    claimrow.querySelectorAll('button[data-k]').forEach(function(b){
      b.onclick = function(){
        b.disabled = true;
        post('/claim', {claimType:b.dataset.k}).then(function(r){
          if (!r.body.ok) { toast(r.body.reason || 'Not yet!'); b.disabled = false; }
          refreshClaims();
        });
      };
    });
  }

  // ---- boot ----
  refresh().then(connect);

  // A backgrounded in-app browser can silently freeze the stream. Re-syncing
  // whenever the page becomes visible again is what makes that invisible.
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) { refresh(); if (!es || es.readyState === 2) connect(); }
  });
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
