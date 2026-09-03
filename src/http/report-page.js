/**
 * The per-player game report.
 *
 * Sent to every player by WhatsApp when a game ends, and readable forever
 * afterwards from the same signed link. It is the answer to "what actually
 * happened" - their ticket, every number in order, what they tapped, whether
 * they were right, and how long they took.
 *
 * Printable: the print stylesheet drops the dark ground and the chrome so
 * "Save as PDF" from any phone or browser produces a clean document. That is
 * deliberately used instead of generating PDFs server-side - it needs no
 * library, no fonts and no rendering service, and it always matches what the
 * player is looking at.
 */
export function reportPage(data) {
  const d = JSON.stringify(data);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16151a">
<title>${esc(data.brand)} — Game ${esc(data.game.code)} report</title>
<style>
:root{
  --ink:#2b2118; --paper:#f4ecd8; --maroon:#8b1e3f; --gold:#d4a537;
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5;
  --ok:#3fa46a; --no:#c04b4b; --miss:#7a748a;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:16px 14px 60px}
h1{font-size:20px;margin:0;color:var(--gold)}
h2{font-size:15px;margin:0 0 10px;color:var(--gold)}
.sub{color:var(--dim);font-size:13px;margin-top:3px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.grid{display:grid;gap:12px}
@media(min-width:640px){ .grid.two{grid-template-columns:1fr 1fr} }
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:13.5px}
dt{color:var(--dim)} dd{margin:0;text-align:right;font-weight:600}
.big{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
.kpi{flex:1;min-width:120px;background:var(--panel);border:1px solid var(--line);
  border-radius:12px;padding:12px}
.kpi .v{font-size:24px;font-weight:800;color:var(--gold);line-height:1.1}
.kpi .k{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin-top:3px}

/* the ticket, same paper as the board */
.ticket{background:var(--paper);color:var(--ink);border-radius:4px;overflow:hidden}
table.tk{border-collapse:collapse;width:100%;table-layout:fixed}
table.tk td{border:1px solid rgba(139,30,63,.45);height:46px;text-align:center;
  font:600 18px/1 Georgia,serif;position:relative}
table.tk td.blank{background:repeating-linear-gradient(45deg,transparent,transparent 5px,
  rgba(139,30,63,.055) 5px,rgba(139,30,63,.055) 10px)}
table.tk td.called::after{content:"";position:absolute;inset:50% auto auto 50%;
  width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
  background:radial-gradient(circle at 36% 32%,rgba(16,185,129,.72),rgba(4,120,87,.58) 70%)}
table.tk td.called{color:#06301f}

/* the number-by-number log */
table.log{border-collapse:collapse;width:100%;font-size:13px}
table.log th{position:sticky;top:0;background:var(--panel);text-align:left;
  font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);
  padding:8px 8px;border-bottom:1px solid var(--line)}
table.log td{padding:7px 8px;border-bottom:1px solid var(--line)}
table.log tr:last-child td{border-bottom:0}
.num{font-weight:800;color:var(--gold)}
.tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700}
.t-yes{background:rgba(63,164,106,.15);color:var(--ok)}
.t-no{background:rgba(192,75,75,.15);color:var(--no)}
.t-none{background:rgba(122,116,138,.15);color:var(--miss)}
.ok{color:var(--ok);font-weight:700} .bad{color:var(--no);font-weight:700}
.scroll{max-height:60vh;overflow:auto;margin:0 -4px}
.prizes{list-style:none;padding:0;margin:0}
.prizes li{display:flex;padding:7px 0;border-top:1px solid var(--line);font-size:13.5px}
.prizes li:first-child{border-top:0}
.prizes b{margin-left:auto;color:var(--gold)}
.prizes li.none b{color:var(--dim);font-weight:400}
.btn{display:block;width:100%;padding:14px;border-radius:12px;border:0;cursor:pointer;
  font:700 15px system-ui;background:var(--gold);color:#2b2118;margin-top:12px;text-align:center;
  text-decoration:none}

/* Save as PDF: drop the dark ground, print the substance. */
@media print{
  @page{ margin:12mm }
  body{background:#fff;color:#000}
  .wrap{max-width:none;padding:0}
  .card{border:1px solid #ccc;background:#fff;break-inside:avoid}
  h1,h2,.kpi .v,.num,.prizes b{color:#7d0f22}
  .sub,dt,.kpi .k,table.log th{color:#555}
  table.log th{background:#f2f2f2}
  table.log td{border-bottom:1px solid #ddd}
  .scroll{max-height:none;overflow:visible}
  .noprint{display:none!important}
}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
(function(){
  "use strict";
  var d = ${d};
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function when(v){ if(!v) return '—';
    return new Date(v).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',
      day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }

  var called = {};
  d.timeline.forEach(function(t){ called[t.value] = true; });

  var acc = d.accuracy ||
    {correct:0,total:0,missed:0,wrongTaps:0,noResponse:0,answered:0};
  // Out of what they answered. A number nobody responded to is reported on its
  // own below rather than folded into an accuracy figure it would drag down.
  var pct = acc.answered ? Math.round(acc.correct/acc.answered*100) : 0;
  var mineWon = d.prizes.filter(function(p){ return p.winner === d.you.name; });

  var h = '';
  h += '<div style="display:flex;align-items:flex-start;gap:12px;padding:6px 2px 4px">' +
    '<div><h1>Game ' + esc(d.game.code) + ' — your report</h1>' +
    '<div class="sub">' + esc(d.you.name) + (d.you.isHost ? ' (host)' : '') +
    ' &middot; ' + when(d.game.endedAt || d.game.startedAt) + '</div></div></div>';

  // Said plainly, above the numbers. Without it the accuracy figure below
  // reads as inattention rather than as a deliberate exit.
  if (d.you.leftAt) {
    h += '<div class="card" style="border-color:rgba(192,75,75,.45)">' +
      '<b>You left this game early.</b> ' +
      '<span class="sub">Everything below covers the whole game — the numbers ' +
      'called after you left were never yours to mark.</span></div>';
  }

  h += '<div class="big">' +
    kpi(acc.correct + '/' + acc.answered, 'Marked correctly') +
    kpi(pct + '%', 'Accuracy') +
    kpi(mineWon.length, 'Prizes won') +
  '</div>';

  // The three ways a number can go wrong, kept apart because they mean
  // different things: one cost you a prize, one cost you nothing, and one may
  // not have been your doing at all.
  h += '<div class="card"><h2>Where the numbers went</h2><dl>' +
    row('On your ticket, and you marked it', acc.correct) +
    row('On your ticket, but you said no', acc.missed) +
    row('Marked, but not on your ticket', acc.wrongTaps) +
    row('Never answered', acc.noResponse) +
  '</dl><p class="sub" style="margin:8px 0 0">' +
    'Marking a number you did not have costs nothing — prizes are checked ' +
    'against the numbers actually called, never against your marks. Saying ' +
    'no to one you did have is the only mistake that can cost you a prize.' +
  '</p></div>';

  h += '<div class="grid two">';

  h += '<div class="card"><h2>Game</h2><dl>' +
    row('Room code', d.game.code) +
    row('Host', d.host || '—') +
    row('Players', d.game.expectedPlayers) +
    row('Numbers called', d.game.numbersCalled + ' of 90') +
    row('Every', d.game.drawInterval + 's') +
    row('Started', when(d.game.startedAt)) +
    row('Ended', when(d.game.endedAt)) +
    row('Ended because', (d.game.endedReason || '—').replace(/_/g,' ')) +
  '</dl></div>';

  h += '<div class="card"><h2>Prizes</h2><ul class="prizes">' +
    d.prizes.map(function(p){
      var you = p.winner === d.you.name;
      return '<li class="' + (p.winner ? '' : 'none') + '">' + esc(p.label) +
        '<b>' + (p.winner ? (you ? 'You 🎉' : esc(p.winner)) : 'unclaimed') + '</b></li>';
    }).join('') + '</ul></div>';

  h += '</div>';

  if (d.ticket) {
    h += '<div class="card"><h2>Your ticket</h2>' +
      '<div class="sub" style="margin-bottom:10px">Marked cells are numbers that were called.</div>' +
      '<div class="ticket"><table class="tk"><tbody>' +
      d.ticket.grid.map(function(r){
        return '<tr>' + r.map(function(v){
          if (v === null) return '<td class="blank"></td>';
          return '<td class="' + (called[v] ? 'called' : '') + '">' + v + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  h += '<div class="card"><h2>Every number, and what you did</h2>' +
    '<div class="sub" style="margin-bottom:10px">' +
    'This is the full record. Claims were validated against the numbers actually ' +
    'called, never against your taps.</div>' +
    '<div class="scroll"><table class="log"><thead><tr>' +
    '<th>#</th><th>Number</th><th>Called at</th><th>You tapped</th><th>Right?</th><th>Took</th>' +
    '</tr></thead><tbody>' +
    d.timeline.map(function(t){
      var tag = t.answer === 'yes' ? '<span class="tag t-yes">I have it</span>'
              : t.answer === 'no' ? '<span class="tag t-no">Not on mine</span>'
              : '<span class="tag t-none">no response</span>';
      var right = t.wasCorrect === true ? '<span class="ok">✓</span>'
                : t.wasCorrect === false ? '<span class="bad">✗</span>'
                : '<span style="color:var(--miss)">—</span>';
      return '<tr><td>' + t.seq + '</td>' +
        '<td class="num">' + t.value + '</td>' +
        '<td>' + when(t.drawnAt) + '</td>' +
        '<td>' + tag + '</td>' +
        '<td>' + right + '</td>' +
        '<td>' + (t.tookSeconds === null ? '—' : t.tookSeconds.toFixed(1) + 's') + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';

  if (d.claims.length) {
    h += '<div class="card"><h2>Your claims</h2><ul class="prizes">' +
      d.claims.map(function(c){
        return '<li>' + esc(c.claim_type.replace(/_/g,' ')) +
          ' <span class="sub" style="margin-left:8px">' + esc(c.reason || '') + '</span>' +
          '<b class="' + (c.status === 'awarded' ? 'ok' : 'bad') + '">' + c.status + '</b></li>';
      }).join('') + '</ul></div>';
  }

  h += '<div class="card"><h2>How everyone marked</h2><ul class="prizes">' +
    d.leaderboard.map(function(p){
      var you = p.name === d.you.name;
      var pd = p.answered || p.total;
      var pp = pd ? Math.round(p.correct/pd*100) : 0;
      return '<li>' + (you ? '<b style="color:var(--gold)">You</b>' : esc(p.name)) +
        '<b>' + p.correct + '/' + pd + ' &middot; ' + pp + '%</b></li>';
    }).join('') + '</ul></div>';

  h += '<button class="btn noprint" onclick="window.print()">Save as PDF / Print</button>';

  document.getElementById('app').innerHTML = h;

  function kpi(v,k){ return '<div class="kpi"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }
  function row(k,v){ return '<dt>' + k + '</dt><dd>' + esc(v) + '</dd>'; }
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
