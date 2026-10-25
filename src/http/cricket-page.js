/**
 * Hand Cricket: the page a match is played on.
 *
 * One self-contained document - toss, play and scorecard - like the Tap Bakra
 * page, so a player on a patchy connection downloads the game once. No
 * framework, no build step.
 *
 * The page never knows the other side's number before the ball is settled: it
 * is told only that they have picked. Against a friend it asks the server
 * every second and a half for what changed; against the bot every pick comes
 * back already settled.
 *
 * ── A note for whoever edits the script below ─────────────────────────────
 *
 * This file is a template literal that contains a browser script. The script
 * deliberately uses no backticks and no backslashes: either would be consumed
 * by the outer template, and the page would ship a script that does not parse.
 */
import { config } from '../config/env.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Values for the script, with < escaped so no value can close the tag. */
const blob = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const CSS = `
:root{--bg:#0e1116;--card:#181d24;--line:#293242;--ink:#eaf0f7;--muted:#9eb0c8;--gold:#f5b83d;--pitch:#1d6b3e;--pitch2:#155231;--ok:#40b37d;--bad:#e05d5d}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{background:#0e1116}
body{margin:0;min-height:100vh;background:radial-gradient(900px 420px at 50% -10%,#1d3a2a,transparent) no-repeat,var(--bg);color:var(--ink);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:14px 14px 40px}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.brand{font-weight:900;font-size:1.15rem;letter-spacing:-.2px}
.chip{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 10px;white-space:nowrap}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),transparent),var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin-top:12px}
.board{background:linear-gradient(180deg,var(--pitch),var(--pitch2));border-color:#2c7c4d}
.side{display:flex;align-items:center;justify-content:space-between;padding:6px 2px}
.side+.side{border-top:1px solid rgba(255,255,255,.12)}
.side .nm{font-weight:700;display:flex;align-items:center;gap:8px;min-width:0}
.side .nm span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side .sc{font:800 1.35rem ui-monospace,Menlo,monospace}
.side .ov{font-size:12px;color:#cfe6d7;margin-left:6px;font-weight:600}
.you{font-size:10px;font-weight:800;background:var(--gold);color:#2d2209;border-radius:6px;padding:1px 5px}
.need{margin-top:8px;font-size:14px;color:#e7f5ec;text-align:center;font-weight:600}
h2{margin:0;font-size:1.1rem}
p{margin:.45rem 0 0;color:var(--muted)}
.role{text-align:center;font-weight:900;letter-spacing:.08em;font-size:13px;color:var(--gold)}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.pad button{aspect-ratio:1.25;border-radius:16px;border:1px solid #3a4658;background:#222a37;color:var(--ink);font:900 2rem system-ui;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
.pad button small{font-size:.9rem;font-weight:600;color:var(--muted)}
.pad button:active{transform:scale(.96);background:#2b3546}
.pad button[disabled]{opacity:.45}
.pad button.mine{background:var(--gold);color:#2d2209;border-color:var(--gold)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.btn{padding:13px 14px;border-radius:12px;border:0;background:var(--gold);color:#2d2209;font-weight:900;font-size:16px;cursor:pointer;width:100%}
.btn.alt{background:#222a37;color:#d8e3f3;border:1px solid #344255}
.btn.sel{outline:3px solid var(--gold);outline-offset:2px}
.btn[disabled]{opacity:.5}
.reveal{text-align:center;padding:10px 6px}
.reveal .nums{display:flex;justify-content:center;gap:22px;margin-top:6px}
.reveal .n{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12px;color:var(--muted)}
.reveal .n b{font:900 2.2rem system-ui;color:var(--ink)}
.reveal .what{margin-top:6px;font:900 1.4rem system-ui}
.what.out{color:var(--bad)} .what.runs{color:var(--ok)}
.pop{animation:pop .35s ease-out}
@keyframes pop{0%{transform:scale(.85);opacity:.2}100%{transform:scale(1);opacity:1}}
.balls{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;justify-content:center}
.ball{min-width:30px;height:30px;border-radius:999px;display:grid;place-items:center;font:800 13px ui-monospace,Menlo,monospace;background:#26303e;color:var(--ink);padding:0 6px}
.ball.w{background:var(--bad);color:#fff} .ball.six{background:var(--gold);color:#2d2209}
.wait{text-align:center;color:var(--muted);margin-top:12px}
.dots:after{content:'...';animation:d 1.2s steps(4,end) infinite}
@keyframes d{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
.code{font:900 2.2rem ui-monospace,Menlo,monospace;letter-spacing:.3em;text-align:center;color:var(--gold);margin-top:8px}
.result{text-align:center;font:900 1.35rem system-ui;color:var(--gold)}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px}
td{padding:6px 4px;border-top:1px solid var(--line)} td:last-child{text-align:right;font-family:ui-monospace,Menlo,monospace}
.links{display:flex;justify-content:center;gap:16px;margin-top:18px;font-size:14px}
.links a,.lnk{color:var(--muted);background:none;border:0;text-decoration:underline;cursor:pointer;font-size:14px}
.msg{margin-top:10px;min-height:1.3em;font-size:14px;color:var(--bad);text-align:center}
.note{font-size:12px;color:var(--muted);text-align:center;margin-top:14px}
`;

export function cricketPage({ token, apiBase, state, stats, lang, feedbackUrl, supportUrl }) {
  const playUrl = `${apiBase || ''}/public/play`;
  return `<!doctype html>
<html lang="${lang === 'hi' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0e1116">
<meta name="robots" content="noindex">
<title>Hand Cricket - ${esc(config.brandName)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top"><div class="brand">🏏 Hand Cricket</div><span class="chip" id="modeChip"></span></div>
  <div id="app"></div>
  <div class="msg" id="msg"></div>
  <div class="links">
    <a href="${esc(playUrl)}" id="backLink">All games</a>
    <a href="${esc(feedbackUrl)}" target="_blank" rel="noopener">Feedback</a>
    <a href="${esc(supportUrl)}" target="_blank" rel="noopener">Help</a>
  </div>
  <p class="note">Entertainment only - no betting, no money.</p>
</div>
<script>
window.__CR__ = ${blob({ token, apiBase: apiBase || '', state, stats, lang: lang === 'hi' ? 'hi' : 'en' })};
(function(){
  var CFG = window.__CR__;
  var S = CFG.state;
  var busy = false;
  var tossCall = null;
  var shownBall = S.lastBall ? (S.lastBall.innings + ':' + S.lastBall.ball_no) : null;
  var reveal = null;
  var pollTimer = 0;
  var $ = function(id){ return document.getElementById(id); };

  var EN = {
    vsBot: 'vs Bot', vsFriend: 'vs Friend', batting: 'YOU ARE BATTING', bowling: 'YOU ARE BOWLING',
    batHint: 'Show a number. If the bowler shows the same one, you are OUT.',
    bowlHint: 'Show the same number as the batter to get them OUT.',
    toss: 'The toss', callIt: 'Call it - odd or even?', odd: 'Odd', even: 'Even',
    tossPick: 'Now show a number for the toss', theyCall: ' calls the toss. Show your number.',
    wonToss: 'You won the toss!', lostToss: ' won the toss', choose: 'Bat or bowl first?', bat: 'Bat first', bowl: 'Bowl first',
    choosing: ' is choosing', waitingFor: 'Waiting for ', waitingFriend: 'Waiting for your friend to join',
    share: 'Send this to your friend', shareWa: 'Share on WhatsApp', copy: 'Copy link', copied: 'Link copied',
    you: 'You', out: 'OUT!', runs: ' runs', run: ' run', need: 'Need ', off: ' off ', ballsLeft: ' balls', target: 'Target ',
    again: 'Play again', rematch: 'Rematch', joinRematch: 'Your friend wants a rematch - join', leave: 'Leave match',
    over: 'Match over', called: 'Match called off', scorecard: 'Scorecard', inn: ['', '1st innings', '2nd innings'], shareResult: 'Share result',
    sum: 'Sum ', isOdd: ' - odd', isEven: ' - even', yourStats: 'Your record: ', played: ' played, ', won: ' won, best ',
    pick: 'Pick', inviteText: 'Play Hand Cricket with me on MastiPe! Tap to join: '
  };
  var HI = {
    vsBot: 'बॉट से', vsFriend: 'दोस्त से', batting: 'आप बल्लेबाज़ी कर रहे हैं', bowling: 'आप गेंदबाज़ी कर रहे हैं',
    batHint: 'एक नंबर दिखाएँ। गेंदबाज़ ने वही नंबर दिखाया तो आप आउट।',
    bowlHint: 'बल्लेबाज़ जैसा ही नंबर दिखाएँ और उसे आउट करें।',
    toss: 'टॉस', callIt: 'बोलिए - ऑड या ईवन?', odd: 'ऑड', even: 'ईवन',
    tossPick: 'अब टॉस के लिए एक नंबर दिखाएँ', theyCall: ' टॉस बोलेंगे। अपना नंबर दिखाएँ।',
    wonToss: 'आपने टॉस जीता!', lostToss: ' ने टॉस जीता', choose: 'पहले बल्लेबाज़ी या गेंदबाज़ी?', bat: 'पहले बल्लेबाज़ी', bowl: 'पहले गेंदबाज़ी',
    choosing: ' चुन रहे हैं', waitingFor: 'इंतज़ार: ', waitingFriend: 'आपके दोस्त के जुड़ने का इंतज़ार',
    share: 'यह अपने दोस्त को भेजें', shareWa: 'WhatsApp पर भेजें', copy: 'लिंक कॉपी करें', copied: 'लिंक कॉपी हो गया',
    you: 'आप', out: 'आउट!', runs: ' रन', run: ' रन', need: 'चाहिए ', off: ' रन, ', ballsLeft: ' गेंदें बाकी', target: 'लक्ष्य ',
    again: 'फिर खेलें', rematch: 'रीमैच', joinRematch: 'आपका दोस्त रीमैच चाहता है - जुड़ें', leave: 'मैच छोड़ें',
    over: 'मैच खत्म', called: 'मैच रद्द', scorecard: 'स्कोरकार्ड', inn: ['', 'पहली पारी', 'दूसरी पारी'], shareResult: 'नतीजा भेजें',
    sum: 'जोड़ ', isOdd: ' - ऑड', isEven: ' - ईवन', yourStats: 'आपका रिकॉर्ड: ', played: ' खेले, ', won: ' जीते, सबसे अच्छा ',
    pick: 'चुनें', inviteText: 'MastiPe पर मेरे साथ हैंड क्रिकेट खेलो! जुड़ने के लिए टैप करें: '
  };
  var L = CFG.lang === 'hi' ? HI : EN;
  var HAND = ['', '☝️', '✌️', '🤟', '🖖', '🖐️', '👍'];

  function e(s){ return String(s == null ? '' : s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;'); }
  function opp(){ return S.you === 1 ? 2 : 1; }
  function nameOf(side){ return side === S.you ? L.you : S.names[side]; }
  function overs(b){ return Math.floor(b / 6) + '.' + (b % 6); }
  function inningsOf(side){ return S.batFirst ? (S.batFirst === side ? 1 : 2) : null; }
  function say(m){ $('msg').textContent = m || ''; }

  function call(method, path, body){
    return fetch(CFG.apiBase + '/cricket/' + CFG.token + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : { 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(p){
        if (!res.ok) { var er = new Error(p.error || 'Something went wrong'); er.code = p.code; throw er; }
        return p;
      });
    });
  }

  function apply(next){
    var key = next.lastBall ? (next.lastBall.innings + ':' + next.lastBall.ball_no) : null;
    if (key && key !== shownBall) { reveal = next.lastBall; shownBall = key; }
    var tossNow = !S.toss && next.toss;
    S = next;
    if (tossNow) reveal = { toss: true };
    render();
    schedule();
  }

  function act(path, body){
    if (busy) return;
    busy = true; say('');
    call('POST', path, body).then(apply).catch(function(er){
      say(er.message);
      if (er.code === 'stale' || er.code === 'already') refresh();
    }).then(function(){ busy = false; render(); });
  }

  function refresh(){ return call('GET', '/state').then(apply).catch(function(){}); }

  function needsPoll(){
    if (S.mode !== 'friend') return false;
    if (S.status === 'abandoned') return false;
    if (S.status === 'finished') return !S.rematchUrl;
    return true;
  }
  function schedule(){
    clearTimeout(pollTimer);
    if (needsPoll()) pollTimer = setTimeout(refresh, S.status === 'finished' ? 3000 : 1500);
  }

  /* ── pieces ─────────────────────────────────────────────────────────── */

  function board(){
    var h = '<div class="card board">';
    [1, 2].forEach(function(side){
      var inn = inningsOf(side);
      var sc = inn ? S.score[inn] : null;
      var bat = S.status === 'playing' && S.batting === side;
      h += '<div class="side"><div class="nm">' + (bat ? '🏏' : (S.status === 'playing' ? '⚾' : '')) +
        '<span>' + e(S.names[side]) + '</span>' + (side === S.you ? '<em class="you">' + e(L.you) + '</em>' : '') + '</div>' +
        '<div class="sc">' + (sc && (sc.balls || (S.status === 'playing' && inn === S.innings)) ? (sc.runs + '/' + sc.wkts + '<span class="ov">(' + overs(sc.balls) + ')</span>') : '-') + '</div></div>';
    });
    if (S.status === 'playing' && S.innings === 2) {
      var sc2 = S.score[2];
      var need = S.target - sc2.runs;
      var left = S.overs * 6 - sc2.balls;
      h += '<div class="need">' + e(L.target + S.target) + ' · ' + e(L.need + need + L.off + left + L.ballsLeft) + '</div>';
    }
    return h + '</div>';
  }

  function pad(disabled){
    var h = '<div class="pad">';
    for (var n = 1; n <= 6; n++) {
      h += '<button data-n="' + n + '"' + (S.myPick === n ? ' class="mine"' : '') + (disabled ? ' disabled' : '') + '>' + n + '<small>' + HAND[n] + '</small></button>';
    }
    return h + '</div>';
  }

  function revealBox(){
    if (!reveal) return '';
    if (reveal.toss && S.toss) {
      var a = S.toss.picks[1], b = S.toss.picks[2];
      if (a == null || b == null) return '';
      var sum = a + b;
      return '<div class="card reveal pop"><div class="nums">' +
        '<div class="n"><b>' + (S.you === 1 ? a : b) + '</b>' + e(L.you) + '</div>' +
        '<div class="n"><b>' + (S.you === 1 ? b : a) + '</b>' + e(S.names[opp()]) + '</div></div>' +
        '<div class="what">' + e(L.sum + sum + (sum % 2 ? L.isOdd : L.isEven)) + '</div></div>';
    }
    if (!reveal.innings) return '';
    var mine = reveal.batter === S.you ? reveal.bat_pick : reveal.bowl_pick;
    var theirs = reveal.batter === S.you ? reveal.bowl_pick : reveal.bat_pick;
    var what = reveal.is_out ? '<div class="what out">' + e(L.out) + '</div>'
      : '<div class="what runs">+' + reveal.runs + e(reveal.runs === 1 ? L.run : L.runs) + '</div>';
    return '<div class="card reveal pop"><div class="nums">' +
      '<div class="n"><b>' + mine + '</b>' + e(L.you) + '</div>' +
      '<div class="n"><b>' + theirs + '</b>' + e(S.names[opp()]) + '</div></div>' + what + '</div>';
  }

  function ballsStrip(){
    var list = (S.balls || []).filter(function(b){ return b.innings === S.innings; });
    if (!list.length) return '';
    var h = '<div class="balls">';
    list.slice(-12).forEach(function(b){
      h += '<span class="ball' + (b.is_out ? ' w' : (b.runs === 6 ? ' six' : '')) + '">' + (b.is_out ? 'W' : b.runs) + '</span>';
    });
    return h + '</div>';
  }

  function scorecard(){
    var h = '<div class="card"><h2>' + e(L.scorecard) + '</h2><table>';
    [1, 2].forEach(function(inn){
      if (!S.batFirst) return;
      var side = inn === 1 ? S.batFirst : (S.batFirst === 1 ? 2 : 1);
      var sc = S.score[inn];
      h += '<tr><td>' + e(S.names[side]) + ' · ' + e(L.inn[inn]) + '</td><td>' + sc.runs + '/' + sc.wkts + ' (' + overs(sc.balls) + ')</td></tr>';
    });
    h += '</table>';
    var all = (S.balls || []);
    if (all.length) {
      [1, 2].forEach(function(inn){
        var bs = all.filter(function(b){ return b.innings === inn; });
        if (!bs.length) return;
        h += '<div class="balls">';
        bs.forEach(function(b){ h += '<span class="ball' + (b.is_out ? ' w' : (b.runs === 6 ? ' six' : '')) + '">' + (b.is_out ? 'W' : b.runs) + '</span>'; });
        h += '</div>';
      });
    }
    return h + '</div>';
  }

  /* ── screens ────────────────────────────────────────────────────────── */

  function render(){
    $('modeChip').textContent = S.mode === 'bot' ? (L.vsBot + ' · ' + (S.level || '')) : L.vsFriend;
    var h = '';
    var st = S.status;

    if (st === 'waiting') {
      var link = S.inviteUrl || '';
      h += '<div class="card"><h2>' + e(L.waitingFriend) + '<span class="dots"></span></h2>' +
        '<p>' + e(L.share) + '</p><div class="code">' + e(S.code) + '</div>' +
        '<div class="row"><button class="btn" id="waShare">' + e(L.shareWa) + '</button><button class="btn alt" id="copyBtn">' + e(L.copy) + '</button></div></div>';
      $('app').innerHTML = h;
      $('waShare').onclick = function(){ location.href = 'https://wa.me/?text=' + encodeURIComponent(L.inviteText + link); };
      $('copyBtn').onclick = function(){
        try { navigator.clipboard.writeText(link).then(function(){ say(''); $('copyBtn').textContent = L.copied; }); }
        catch (x) { prompt(L.copy, link); }
      };
      return;
    }

    h += board();

    if (st === 'toss') {
      var caller = S.tossCaller === S.you;
      h += '<div class="card"><h2>🪙 ' + e(L.toss) + '</h2>';
      if (S.myPick != null) {
        h += '<div class="wait">' + e(L.waitingFor + S.names[opp()]) + '<span class="dots"></span></div>';
      } else if (caller && !S.tossCall) {
        h += '<p>' + e(L.callIt) + '</p><div class="row">' +
          '<button class="btn alt' + (tossCall === 'odd' ? ' sel' : '') + '" data-call="odd">' + e(L.odd) + '</button>' +
          '<button class="btn alt' + (tossCall === 'even' ? ' sel' : '') + '" data-call="even">' + e(L.even) + '</button></div>';
        if (tossCall) h += '<p>' + e(L.tossPick) + '</p>' + pad(busy);
      } else {
        h += '<p>' + e(caller ? L.tossPick : (S.names[opp()] + L.theyCall)) + '</p>' + pad(busy);
      }
      h += '</div>';
    } else if (st === 'choose') {
      h += revealBox();
      if (S.toss && S.toss.winner === S.you) {
        h += '<div class="card"><h2>' + e(L.wonToss) + '</h2><p>' + e(L.choose) + '</p><div class="row">' +
          '<button class="btn" data-choice="bat">🏏 ' + e(L.bat) + '</button><button class="btn alt" data-choice="bowl">⚾ ' + e(L.bowl) + '</button></div></div>';
      } else {
        h += '<div class="card wait">' + e(S.names[opp()] + L.lostToss + ' · ' + S.names[opp()] + L.choosing) + '<span class="dots"></span></div>';
      }
    } else if (st === 'playing') {
      h += revealBox();
      var batting = S.batting === S.you;
      h += '<div class="card"><div class="role">' + e(batting ? L.batting : L.bowling) + '</div>' +
        '<p style="text-align:center">' + e(batting ? L.batHint : L.bowlHint) + '</p>';
      if (S.myPick != null) h += pad(true) + '<div class="wait">' + e(L.waitingFor + S.names[opp()]) + '<span class="dots"></span></div>';
      else h += pad(busy);
      h += ballsStrip() + '</div>';
    } else {
      h += revealBox();
      var res = st === 'finished' ? (S.result || L.over) : (S.result || L.called);
      var icon = st === 'finished' ? (S.winner === S.you ? '🏆 ' : (S.winner === 0 ? '🤝 ' : '')) : '';
      h += '<div class="card"><div class="result">' + icon + e(res) + '</div>';
      if (CFG.stats && CFG.stats.played) {
        h += '<p style="text-align:center">' + e(L.yourStats + CFG.stats.played + L.played + CFG.stats.won + L.won + (CFG.stats.best || 0)) + '</p>';
      }
      if (S.rematchUrl && S.mode === 'friend') {
        h += '<div class="row" style="grid-template-columns:1fr"><button class="btn" id="joinRematch">' + e(L.joinRematch) + '</button></div>';
      } else {
        h += '<div class="row"><button class="btn" id="againBtn">' + e(S.mode === 'bot' ? L.again : L.rematch) + '</button>' +
          '<button class="btn alt" id="shareRes">' + e(L.shareResult) + '</button></div>';
      }
      h += '</div>' + scorecard();
    }

    if (['toss', 'choose', 'playing'].indexOf(st) >= 0) {
      h += '<div style="text-align:center;margin-top:10px"><button class="lnk" id="leaveBtn">' + e(L.leave) + '</button></div>';
    }

    $('app').innerHTML = h;
    wire();
  }

  function wire(){
    var pads = document.querySelectorAll('.pad button');
    for (var i = 0; i < pads.length; i++) {
      pads[i].onclick = function(){
        var n = Number(this.getAttribute('data-n'));
        if (S.status === 'toss' && S.tossCaller === S.you && !S.tossCall && !tossCall) { say(L.callIt); return; }
        act('/pick', { n: n, turn: S.turn, call: tossCall });
      };
    }
    var calls = document.querySelectorAll('[data-call]');
    for (var j = 0; j < calls.length; j++) {
      calls[j].onclick = function(){ tossCall = this.getAttribute('data-call'); render(); };
    }
    var ch = document.querySelectorAll('[data-choice]');
    for (var k = 0; k < ch.length; k++) {
      ch[k].onclick = function(){ act('/choose', { choice: this.getAttribute('data-choice') }); };
    }
    if ($('againBtn')) $('againBtn').onclick = function(){
      if (busy) return; busy = true;
      call('POST', '/again', {}).then(function(o){ location.href = o.url; })
        .catch(function(er){ say(er.message); busy = false; });
    };
    if ($('joinRematch')) $('joinRematch').onclick = function(){ location.href = S.rematchUrl; };
    if ($('shareRes')) $('shareRes').onclick = function(){
      var t = '🏏 Hand Cricket on MastiPe: ' + (S.result || '') + ' - ' + location.origin + CFG.apiBase + '/public/play';
      location.href = 'https://wa.me/?text=' + encodeURIComponent(t);
    };
    if ($('leaveBtn')) $('leaveBtn').onclick = function(){
      if (confirm(L.leave + '?')) act('/leave', {});
    };
  }

  render();
  schedule();
  document.addEventListener('visibilitychange', function(){ if (!document.hidden && needsPoll()) refresh(); });
})();
</script>
</body>
</html>`;
}
