import { apiPath, env } from '../config/env.js';
import { whatsappReturnUrl } from './board-token.js';

/**
 * The player's board, as a real web page.
 *
 * Served as one self-contained document — no external scripts, fonts or
 * stylesheets — because it opens in whatever browser WhatsApp hands it to,
 * often on a slow connection, and a blocked CDN would leave a blank screen
 * mid-game. It polls for state rather than holding a socket open, for the same
 * reason: a phone that sleeps and wakes recovers on its own.
 */
export function renderBoardPage(token: string): string {
  const base = `${apiPath('/public/board')}/${encodeURIComponent(token)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(env.BRAND_NAME)} — Your Ticket</title>
<style>
  :root {
    --maroon: #7d0f22;
    --maroon-dark: #5c0a19;
    --gold: #f0a202;
    --green: #1f9d55;
    --ink: #1e2733;
    --muted: #6b7684;
    --line: #e2e7ee;
    --bg: #f6f3ef;
    --card: #ffffff;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--ink);
    padding: 12px 12px 28px; max-width: 560px; margin: 0 auto;
    font-size: 16px; line-height: 1.45;
  }
  .card { background: var(--card); border-radius: 16px; box-shadow: 0 1px 3px rgba(20,25,35,.08); margin-bottom: 12px; overflow: hidden; }
  .bar { background: linear-gradient(135deg, var(--maroon), var(--maroon-dark)); color: #fff; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .bar strong { font-size: 18px; letter-spacing: .3px; }
  .bar span { font-size: 13px; opacity: .9; }

  .call { text-align: center; padding: 20px 16px 18px; }
  .call .num {
    font-size: 68px; font-weight: 800; line-height: 1;
    color: var(--maroon); font-variant-numeric: tabular-nums;
  }
  .call .nick { color: var(--muted); font-size: 15px; font-style: italic; margin-top: 6px; min-height: 20px; }
  .call .progress { color: var(--muted); font-size: 13px; margin-top: 10px; }

  table.ticket { width: 100%; border-collapse: separate; border-spacing: 3px; padding: 10px 10px 4px; }
  table.ticket td {
    height: 46px; text-align: center; border-radius: 9px; font-size: 18px;
    font-weight: 600; font-variant-numeric: tabular-nums; background: #fff;
    border: 1px solid var(--line); color: var(--ink);
  }
  table.ticket td.blank { background: #eef1f5; border-color: #eef1f5; }
  table.ticket td.marked { background: var(--green); border-color: var(--green); color: #fff; }
  table.ticket td.latest { background: var(--gold); border-color: var(--gold); color: #3a2a00; animation: pop .5s ease; }
  @keyframes pop { 0% { transform: scale(.75); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }

  /* The called number blinks for two seconds so it is impossible to miss,
     then settles — the player still has to find it on their own ticket. */
  .call .num.blink { animation: blink 0.4s steps(1) 5; }
  @keyframes blink { 0%,100% { color: var(--maroon); } 50% { color: var(--gold); } }
  .call.flash { animation: flash 2s ease-out 1; border-radius: 16px; }
  @keyframes flash { 0% { background: #fff3d6; } 100% { background: transparent; } }

  .lobby { padding: 6px 16px 16px; }
  .lobby .count { font-size: 34px; font-weight: 800; color: var(--maroon); text-align: center; }
  .lobby .of { font-size: 15px; color: var(--muted); text-align: center; margin-top: 2px; }
  .lobby .need { text-align:center; color: var(--muted); font-size: 13px; margin-top: 8px; }
  .lobby .names { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin: 14px 0 4px; }
  .lobby .names span { background:#eef1f5; border-radius:999px; padding:6px 12px; font-size:13px; font-weight:600; }
  .code { text-align:center; font-size: 26px; font-weight: 800; letter-spacing: 3px; color: var(--ink); margin: 4px 0 2px; }

  .meta { display: flex; justify-content: space-between; padding: 4px 14px 14px; color: var(--muted); font-size: 13px; }

  .ask { padding: 4px 12px 14px; }
  .ask p { margin: 0 0 10px; font-weight: 600; text-align: center; }
  .row { display: flex; gap: 8px; }
  button {
    flex: 1; font: inherit; font-weight: 600; padding: 13px 10px; border-radius: 11px;
    border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--green); border-color: var(--green); color: #fff; }
  button.ghost { background: #fff; }
  button.danger { color: #b3122b; border-color: #f0c9cf; }
  button:disabled { opacity: .45; cursor: default; }
  /* The option they actually chose stays legible while both are locked. */
  button.picked { opacity: 1; box-shadow: 0 0 0 2px var(--ink) inset; }
  button.primary.picked { box-shadow: 0 0 0 2px #0d5c33 inset; }
  button:active { transform: translateY(1px); }

  .answered { text-align: center; color: var(--muted); font-size: 14px; padding: 6px 0 4px; }
  .waiting { padding: 6px 14px 16px; text-align: center; }
  .waiting .tick { color: var(--green); font-weight: 700; font-size: 15px; }
  .waiting .msg { color: var(--muted); font-size: 14px; margin-top: 4px; }
  .waiting .track { height: 7px; background: #eef1f5; border-radius: 999px; margin: 12px auto 0; max-width: 260px; overflow: hidden; }
  .waiting .fill { height: 100%; background: var(--green); border-radius: 999px; transition: width .4s ease; }
  .dots::after { content: ''; animation: dots 1.4s steps(4, end) infinite; }
  /* Indeterminate bar for the moment between the last answer and the next
     number. Without it the pause reads as the page having frozen. */
  .fetching .track { overflow: hidden; }
  .fetching .fill { width: 40% !important; animation: sweep 0.9s ease-in-out infinite; }
  @keyframes sweep { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  .fetching .msg { color: var(--maroon); font-weight: 600; }
  @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }

  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); margin: 0; padding: 14px 16px 6px; }
  ul.prizes { list-style: none; margin: 0; padding: 0 12px 12px; }
  ul.prizes li { display: flex; align-items: center; gap: 10px; padding: 8px 4px; border-bottom: 1px solid var(--line); }
  ul.prizes li:last-child { border-bottom: 0; }
  ul.prizes .name { flex: 1; font-weight: 600; }
  ul.prizes .won { color: var(--muted); font-size: 13px; font-weight: 500; }
  ul.prizes button { flex: 0 0 auto; padding: 8px 14px; font-size: 14px; }

  .called { padding: 0 14px 14px; display: flex; flex-wrap: wrap; gap: 5px; }
  .called b { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 28px; padding: 0 5px;
              border-radius: 7px; background: #eef1f5; color: var(--muted); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .called b.mine { background: var(--green); color: #fff; }

  .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
           background: var(--ink); color: #fff; padding: 11px 18px; border-radius: 999px;
           font-size: 14px; opacity: 0; pointer-events: none; transition: opacity .25s; max-width: 90vw; text-align: center; }
  .toast.show { opacity: 1; }

  .over { text-align: center; padding: 26px 20px 22px; }
  .over .big { font-size: 40px; }
  .over h1 { font-size: 22px; margin: 10px 0 4px; }
  .over p { color: var(--muted); margin: 6px 0 0; }
  .over .cta { display: block; margin-top: 18px; padding: 14px; border-radius: 12px; background: var(--green);
               color: #fff; text-decoration: none; font-weight: 700; }
  .over .promo { display: block; margin-top: 10px; padding: 13px; border-radius: 12px; background: #fff;
                 border: 1px solid var(--line); color: var(--maroon); text-decoration: none; font-weight: 600; }
  .footer { text-align: center; color: var(--muted); font-size: 12px; padding: 6px 0 0; }
  .offline { display: none; text-align: center; background: #fff4d6; color: #7a5b00; font-size: 13px; padding: 8px; border-radius: 10px; margin-bottom: 10px; }
  .offline.show { display: block; }
</style>
</head>
<body>
<div class="offline" id="offline">Reconnecting…</div>
<div id="app"><div class="card"><div class="call"><div class="nick">Loading your ticket…</div></div></div></div>
<div class="toast" id="toast"></div>

<script>
(function () {
  var BASE = ${JSON.stringify(base)};
  var WA = ${JSON.stringify(whatsappReturnUrl())};
  var PROMO_URL = ${JSON.stringify(env.PROMO_URL)};
  var PROMO_TEXT = ${JSON.stringify(env.PROMO_TEXT)};
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var offlineEl = document.getElementById('offline');
  var state = null, busy = false, timer = null, lastSeq = -1, pollMs = 3000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function post(path, body) {
    if (busy) return Promise.resolve(null);
    busy = true;
    return fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        busy = false;
        if (j && j.message) toast(j.message);
        return refresh();
      })
      .catch(function () { busy = false; toast('Could not reach the game. Try again.'); });
  }

  function refresh() {
    return fetch(BASE + '/state', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        offlineEl.classList.remove('show');
        state = j.data || j;
        render();
        retune();
      })
      .catch(function () { offlineEl.classList.add('show'); });
  }

  function ticketHtml(s) {
    var rows = '';
    for (var r = 0; r < s.grid.length; r++) {
      var cells = '';
      for (var c = 0; c < s.grid[r].length; c++) {
        var v = s.grid[r][c];
        if (v === null) { cells += '<td class="blank"></td>'; continue; }
        var cls = s.called.indexOf(v) >= 0 ? (v === s.currentNumber ? 'latest' : 'marked') : '';
        cells += '<td class="' + cls + '">' + v + '</td>';
      }
      rows += '<tr>' + cells + '</tr>';
    }
    return '<table class="ticket">' + rows + '</table>';
  }

  function calledHtml(s) {
    if (!s.called.length) return '';
    var out = '';
    // Newest first: what a player scans for is the number just called.
    for (var i = s.called.length - 1; i >= 0; i--) {
      var n = s.called[i];
      out += '<b class="' + (s.myNumbers.indexOf(n) >= 0 ? 'mine' : '') + '">' + n + '</b>';
    }
    return '<div class="card"><h2>Called so far (' + s.called.length + ')</h2><div class="called">' + out + '</div></div>';
  }

  function prizesHtml(s) {
    var items = '';
    for (var i = 0; i < s.prizes.length; i++) {
      var p = s.prizes[i];
      items += '<li><span class="name">' + esc(p.label) + '</span>' +
        (p.wonBy
          ? '<span class="won">' + esc(p.wonBy) + '</span>'
          : '<button data-claim="' + esc(p.key) + '">Claim</button>') +
        '</li>';
    }
    return '<div class="card"><h2>Prizes</h2><ul class="prizes">' + items + '</ul></div>';
  }

  function lobbyHtml(s) {
    var names = s.playerNames.map(function (n) { return '<span>' + esc(n) + '</span>'; }).join('');
    var target = s.expectedPlayers ? ' of ' + s.expectedPlayers : '';
    var enough = s.canStart;

    var action = s.isHost
      ? '<div class="row" style="margin-top:14px">' +
          '<button class="primary" data-start="1"' + (enough ? '' : ' disabled') + '>' +
          (enough ? 'Start game' : 'Need ' + (s.minPlayers - s.playersJoined) + ' more') + '</button></div>'
      : '<div class="answered" style="margin-top:12px"><strong>The host has to start the game.</strong>' +
        '<br>Hang on a few seconds — this page starts by itself.</div>';

    return '<div class="card"><div class="bar"><strong>' + esc(s.brand) + '</strong>' +
      '<span>Waiting to start</span></div>' +
      '<div class="lobby">' +
        '<div class="code">' + esc(s.roomCode) + '</div>' +
        '<div class="count">' + s.playersJoined + target + '</div>' +
        '<div class="of">player' + (s.playersJoined === 1 ? '' : 's') + ' joined</div>' +
        '<div class="need">Minimum ' + s.minPlayers + ' to start</div>' +
        '<div class="names">' + names + '</div>' +
        action +
        '<div class="row" style="margin-top:8px">' +
          '<button class="ghost" data-invite="1">Invite friends</button>' +
          '<button class="danger" data-exit="1">Leave</button>' +
        '</div>' +
      '</div></div>' +
      '<div class="footer">This page updates by itself as friends join.</div>';
  }

  function overHtml(s) {
    var lines = s.prizes.filter(function (p) { return p.wonBy; })
      .map(function (p) { return esc(p.label) + ' — ' + esc(p.wonBy); }).join('<br>');
    return '<div class="card"><div class="over">' +
      '<div class="big">' + (s.iWon ? '🏆' : '🎉') + '</div>' +
      '<h1>' + (s.iWon ? 'Congratulations!' : 'Thanks for playing!') + '</h1>' +
      '<p>Room ' + esc(s.roomCode) + ' · ' + s.called.length + ' numbers called</p>' +
      (lines ? '<p>' + lines + '</p>' : '<p>No prizes were claimed.</p>') +
      '<a class="cta" href="' + WA + '">Back to WhatsApp — tell us how it went</a>' +
      '<a class="promo" href="' + PROMO_URL + '" target="_blank" rel="noopener">' + esc(PROMO_TEXT) + '</a>' +
      '</div></div>' +
      '<div class="footer">You can close this page.</div>';
  }

  function render() {
    var s = state;
    if (!s) return;

    if (s.status !== 'running' && s.status !== 'lobby') { app.innerHTML = overHtml(s); return; }

    if (s.status === 'lobby') { app.innerHTML = lobbyHtml(s); return; }

    var isNew = s.currentSeq !== lastSeq && s.currentNumber;
    if (isNew) lastSeq = s.currentSeq;

    var head = '<div class="card"><div class="bar"><strong>' + esc(s.brand) + '</strong>' +
      '<span>Room ' + esc(s.roomCode) + ' · Ticket ' + s.entryNo + '</span></div>';

    var call = '<div class="call' + (isNew ? ' flash' : '') + '">' +
      '<div class="num' + (isNew ? ' blink' : '') + '">' + (s.currentNumber || '–') + '</div>' +
      '<div class="nick">' + esc(s.currentNickname || '') + '</div>' +
      '<div class="progress">' + s.currentSeq + ' of ' + s.totalNumbers + ' called</div></div>';

    var ask = '';
    if (s.status === 'running' && s.currentNumber) {
      if (s.answered) {
        var pct = s.players ? Math.round((s.answeredCount / s.players) * 100) : 100;
        var fetching = s.waitingFor === 0;
        var msg = fetching
          ? 'Everyone answered — fetching the next number'
          : 'Waiting for ' + s.waitingFor + ' more player' + (s.waitingFor === 1 ? '' : 's');
        // The buttons stay on screen but disabled: removing them made it look
        // like the game had moved on, and the player could not see what they
        // had picked.
        var locked = '<div class="ask"><div class="row">' +
          '<button class="primary' + (s.myAnswer === true ? ' picked' : '') + '" disabled>Yes, I have it</button>' +
          '<button class="ghost' + (s.myAnswer === false ? ' picked' : '') + '" disabled>Not on my ticket</button>' +
          '</div></div>';

        ask = locked + '<div class="waiting' + (fetching ? ' fetching' : '') + '">' +
          '<div class="tick">Answered ✓</div>' +
          '<div class="msg dots">' + msg + '</div>' +
          '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
          '<div class="msg" style="margin-top:8px">' + s.answeredCount + ' of ' + s.players + ' answered' +
          (s.waitingFor > 0 ? ' · next number in up to ' + s.drawIntervalSeconds + 's' : '') +
          '</div></div>';
      } else {
        ask = '<div class="ask"><p>Is ' + s.currentNumber + ' on your ticket?</p><div class="row">' +
          '<button class="primary" data-ack="yes">Yes, I have it</button>' +
          '<button class="ghost" data-ack="no">Not on my ticket</button></div></div>';
      }
    }

    var meta = '<div class="meta"><span>' + s.markedCount + ' of ' + s.myNumbers.length + ' marked</span>' +
      '<span>' + esc(s.playerName) + '</span></div>';

    app.innerHTML = head + call + ticketHtml(s) + meta + ask + '</div>' +
      prizesHtml(s) + calledHtml(s) +
      '<div class="card"><div class="ask"><div class="row">' +
      '<button class="danger" data-exit="1">Exit this game</button></div></div></div>';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t) return;
    if (t.dataset.start) { t.disabled = true; post('/start', {}); }
    else if (t.dataset.invite) {
      var msg = 'Join my ' + state.brand + ' Tambola game! Tap: ' + state.inviteUrl;
      if (navigator.share) { navigator.share({ text: msg }).catch(function () {}); }
      else if (navigator.clipboard) { navigator.clipboard.writeText(msg); toast('Invite copied — paste it to your friends'); }
      else { window.open(state.inviteUrl, '_blank'); }
    }
    else if (t.dataset.ack) { t.disabled = true; post('/ack', { hasNumber: t.dataset.ack === 'yes' }); }
    else if (t.dataset.claim) { t.disabled = true; post('/claim', { claimType: t.dataset.claim }); }
    else if (t.dataset.exit) {
      if (confirm('Leave this game? You will stop receiving numbers and cannot rejoin this round.')) {
        post('/exit', {});
      }
    }
  });

  // Poll slowly while people are still answering, quickly once everyone has —
  // the next number is milliseconds away and the player is watching for it.
  function retune() {
    var fast = state && state.status === 'running' && state.answered && state.waitingFor === 0;
    var wanted = fast ? 600 : 3000;
    if (wanted === pollMs) return;
    pollMs = wanted;
    clearInterval(timer);
    timer = setInterval(refresh, pollMs);
  }

  refresh();
  timer = setInterval(refresh, pollMs);
  // Catch up immediately when the player returns to the tab.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
