/**
 * The player's whole play history, as one downloadable page.
 *
 * Same rules as the game report: no build step, no framework, no external
 * request, and "Save as PDF" from any phone browser has to produce a clean
 * document. That last constraint is what shapes everything here.
 *
 * The charts are hand-drawn SVG rather than a library, for three reasons that
 * all matter more than the convenience would have:
 *
 *   1. A charting library is 200KB+ over a phone connection, for four small
 *      pictures.
 *   2. Canvas-based charts print as a blurry raster or, on some phones, as
 *      nothing at all. SVG prints as vector, at whatever resolution the PDF
 *      is rendered.
 *   3. It keeps the page a single file with no network dependency, so it still
 *      works months later from a saved copy.
 */
import { config } from '../config/env.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const PRIZE_LABELS = {
  jaldi5: 'Jaldi 5',
  top_line: 'Top Line',
  middle_line: 'Middle Line',
  bottom_line: 'Bottom Line',
  corners: 'Corners',
  full_house: 'Full House',
};

const fmtDate = (v) => (v
  ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

const fmtDateTime = (v) => (v
  ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '—');

/** Green for better, red for worse — with "better" sometimes meaning "less". */
function movementChip(m) {
  if (!m || m.label === '—') return '';
  const good = m.lowerIsBetter ? m.direction === 'down' : m.direction === 'up';
  const cls = m.direction === 'flat' ? 'flat' : good ? 'up' : 'down';
  const arrow = m.direction === 'up' ? '▲' : m.direction === 'down' ? '▼' : '·';
  return `<span class="chip ${cls}">${arrow} ${esc(m.label)}</span>`;
}

/**
 * A bar chart as inline SVG.
 *
 * Bars rather than a line: activity is a count per day, and a line between two
 * days someone did not play implies a smooth journey that did not happen.
 */
function barChart(rows, { key, label, height = 120 }) {
  if (!rows.length) return '<div class="empty">Nothing to chart yet.</div>';

  const w = 720;
  const h = height;
  const pad = { l: 30, r: 8, t: 8, b: 22 };
  const max = Math.max(...rows.map((r) => Number(r[key]) || 0), 1);
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const slot = innerW / rows.length;
  const barW = Math.max(2, Math.min(26, slot * 0.68));

  const bars = rows.map((r, i) => {
    const v = Number(r[key]) || 0;
    const bh = (v / max) * innerH;
    const x = pad.l + i * slot + (slot - barW) / 2;
    const y = pad.t + innerH - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2" fill="#8b1e3f"><title>${esc(r.day ?? r.hour)}: ${v} ${esc(label)}</title></rect>`;
  }).join('');

  // Only the first, middle and last labels — 90 dates along an axis is a smear.
  const ticks = [0, Math.floor(rows.length / 2), rows.length - 1]
    .filter((v, i, a) => a.indexOf(v) === i && rows[v])
    .map((i) => {
      const x = pad.l + i * slot + slot / 2;
      const raw = rows[i].day ?? `${rows[i].hour}:00`;
      const text = rows[i].day ? fmtDate(rows[i].day) : raw;
      return `<text x="${x.toFixed(1)}" y="${h - 6}" class="ax" text-anchor="middle">${esc(text)}</text>`;
    }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${esc(label)}">
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" class="axis"/>
    <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${w - pad.r}" y2="${pad.t + innerH}" class="axis"/>
    <text x="6" y="${pad.t + 9}" class="ax">${max}</text>
    <text x="6" y="${pad.t + innerH}" class="ax">0</text>
    ${bars}${ticks}
  </svg>`;
}

/** Accuracy per game, oldest to newest — the improvement picture. */
function lineChart(games) {
  const played = games.filter((g) => g.decisions > 0).slice().reverse();
  if (played.length < 2) return '<div class="empty">Play a couple more games and a trend appears here.</div>';

  const w = 720;
  const h = 140;
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const step = played.length > 1 ? innerW / (played.length - 1) : 0;

  const pts = played.map((g, i) => {
    const x = pad.l + i * step;
    const y = pad.t + innerH - (g.accuracyPct / 100) * innerH;
    return { x, y, g };
  });

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#d4a537"><title>${esc(p.g.code)}: ${p.g.accuracyPct}%</title></circle>`).join('');

  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Accuracy per game">
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + innerH}" class="axis"/>
    <line x1="${pad.l}" y1="${pad.t + innerH}" x2="${w - pad.r}" y2="${pad.t + innerH}" class="axis"/>
    <text x="4" y="${pad.t + 9}" class="ax">100%</text>
    <text x="10" y="${pad.t + innerH}" class="ax">0</text>
    <path d="${path}" fill="none" stroke="#d4a537" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
    <text x="${pad.l}" y="${h - 6}" class="ax">oldest</text>
    <text x="${w - pad.r}" y="${h - 6}" class="ax" text-anchor="end">newest</text>
  </svg>`;
}

export function historyPage(d) {
  const t = d.totals;
  const a = d.accuracy;
  const imp = d.improvement;

  const prizeRows = Object.entries(PRIZE_LABELS).map(([key, label]) => {
    const n = d.prizes.byKind[key] || 0;
    return `<li class="${n ? '' : 'none'}">${esc(label)}<b>${n}</b></li>`;
  }).join('');

  const gameRows = d.games.map((g) => `
    <tr>
      <td class="nowrap">${esc(fmtDate(g.created_at))}</td>
      <td class="mono">${esc(g.code)}</td>
      <td>${g.is_host ? '<span class="tag host">host</span>' : 'player'}${g.left_at ? ' <span class="tag left">left</span>' : ''}</td>
      <td class="num">${g.seats}</td>
      <td class="num">${g.numbers_called}</td>
      <td class="num">${g.decisions ? `${g.correct}/${g.answered}` : '—'}</td>
      <td class="num"><b>${g.answered ? `${g.accuracyPct}%` : '—'}</b></td>
      <td class="num">${g.missed}</td>
      <td class="num">${g.wrong_taps}</td>
      <td>${g.prizeList.length
        ? g.prizeList.map((p) => `<span class="tag win">${esc(PRIZE_LABELS[p] || p)}</span>`).join(' ')
        : '<span class="dim">—</span>'}</td>
      <td class="dim">${esc((g.ended_reason || g.status || '').replace(/_/g, ' '))}</td>
    </tr>`).join('');

  const boardRows = d.leaderboard.map((p, i) => `
    <tr class="${p.isYou ? 'you' : ''}">
      <td class="num">${i + 1}</td>
      <td>${p.isYou ? '<b>You</b>' : esc(p.display_name || 'A player')}</td>
      <td class="num">${p.games_together}</td>
      <td class="num">${p.accuracyPct}%</td>
      <td class="num"><b>${p.prizes}</b></td>
    </tr>`).join('');

  const adviceList = d.advice.map((line) => `<li>${esc(line)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.player.name)} - play history - ${esc(d.brand)}</title>
<style>
:root{
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5;
  --gold:#d4a537; --maroon:#8b1e3f; --ok:#3fa46a; --no:#c04b4b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:820px;margin:0 auto;padding:16px 14px 60px}

header{border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:18px}
.brand{color:var(--gold);font-weight:800;letter-spacing:.02em}
h1{margin:8px 0 2px;font-size:25px;letter-spacing:-.3px}
.sub{color:var(--dim);font-size:13.5px}

h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);
  margin:26px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line)}

.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:10px 0}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px}
.stat .k{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);font-weight:700}
.stat .v{font-size:26px;font-weight:800;margin-top:4px;line-height:1.1}
.stat .n{font-size:12px;color:var(--dim);margin-top:2px}
.gold{color:var(--gold)}

.chip{display:inline-block;font-size:11.5px;font-weight:700;padding:2px 7px;border-radius:99px;
  border:1px solid var(--line);color:var(--dim)}
.chip.up{color:var(--ok);border-color:rgba(63,164,106,.4);background:rgba(63,164,106,.1)}
.chip.down{color:var(--no);border-color:rgba(192,75,75,.4);background:rgba(192,75,75,.1)}

.kv{list-style:none;margin:0;padding:0}
.kv li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line)}
.kv li:last-child{border-bottom:0}
.kv li.none{color:var(--dim)}
.kv b{font-variant-numeric:tabular-nums}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
  padding:8px 7px;border-bottom:1px solid var(--line);font-weight:700;white-space:nowrap}
td{padding:8px 7px;border-bottom:1px solid var(--line);vertical-align:top}
tr.you{background:rgba(212,165,55,.07)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mono{font-family:ui-monospace,Menlo,monospace;letter-spacing:.06em}
.nowrap{white-space:nowrap}
.dim{color:var(--dim)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}

.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:5px;
  border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.host{color:var(--gold);border-color:rgba(212,165,55,.4)}
.tag.win{color:var(--ok);border-color:rgba(63,164,106,.4)}
.tag.left{color:var(--no);border-color:rgba(192,75,75,.4)}

.chart{width:100%;height:auto;display:block;margin:4px 0}
.chart .axis{stroke:var(--line);stroke-width:1}
.chart .ax{fill:var(--dim);font-size:10px}
.empty{color:var(--dim);font-size:13px;padding:10px 0}

.advice{margin:0;padding-left:18px}
.advice li{margin:7px 0}

.btn{display:block;width:100%;padding:14px;border-radius:12px;border:0;cursor:pointer;
  background:var(--gold);color:#2b2118;font:700 15px system-ui;margin:22px 0 8px}
footer{color:var(--dim);font-size:11.5px;text-align:center;margin-top:16px;line-height:1.7}

/* Save as PDF: drop the dark ground, keep the substance. A dark page prints as
   a wall of ink, and most phones will not print the background at all - which
   would leave pale text on white. */
@media print{
  :root{--bg:#fff;--panel:#fff;--line:#d8d3cc;--text:#1a1a1a;--dim:#57525c}
  body{background:#fff;color:#1a1a1a;font-size:11pt}
  .wrap{max-width:none;padding:0}
  .noprint{display:none!important}
  .card,.stat{break-inside:avoid;page-break-inside:avoid}
  table{font-size:9.5pt}
  tr{break-inside:avoid}
  h2{break-after:avoid}
  .chart rect{fill:#8b1e3f}
  .chart path{stroke:#8b1e3f}
  .chart circle{fill:#8b1e3f}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="brand">${esc(d.brand)}</div>
  <h1>${esc(d.player.name)} — play history</h1>
  <div class="sub">
    ${t.games > 0
      ? `${esc(fmtDate(t.first_game_at))} to ${esc(fmtDate(t.last_game_at))} · ${t.days_played} day${t.days_played === 1 ? '' : 's'} played`
      : 'No games played yet'}
    <br>Generated ${esc(fmtDateTime(d.generatedAt))}
  </div>
</header>

<h2>At a glance</h2>
<div class="stats">
  <div class="stat"><div class="k">Games played</div><div class="v gold">${t.games}</div>
    <div class="n">${t.finished} finished${t.abandoned ? `, ${t.abandoned} ended early` : ''}</div></div>
  <div class="stat"><div class="k">As host</div><div class="v">${t.as_host}</div>
    <div class="n">${t.as_player} as a player${t.left_early ? ` · left ${t.left_early} early` : ''}</div></div>
  <div class="stat"><div class="k">Prizes won</div><div class="v gold">${d.prizes.total}</div>
    <div class="n">${d.prizes.rejected} claim${d.prizes.rejected === 1 ? '' : 's'} refused</div></div>
  <div class="stat"><div class="k">Marking accuracy</div><div class="v">${a.accuracyPct}%</div>
    <div class="n">${a.correct} of ${a.answered} answered</div></div>
</div>

<h2>Who you are</h2>
<div class="card">
  <ul class="kv">
    <li>Name<b>${esc(d.player.name)}</b></li>
    <li>WhatsApp<b>+${esc(d.player.waId)}</b></li>
    <li>First seen<b>${esc(fmtDate(d.player.joinedAt))}</b></li>
    <li>Last seen<b>${esc(fmtDateTime(d.player.lastSeenAt))}</b></li>
    ${d.player.city || d.player.region
      ? `<li>Usually plays from<b>${esc([d.player.city, d.player.region].filter(Boolean).join(', '))}</b></li>` : ''}
    ${d.player.device ? `<li>On<b>${esc(d.player.device)}</b></li>` : ''}
  </ul>
</div>

<h2>Prizes</h2>
<div class="card"><ul class="kv">${prizeRows}</ul></div>

<h2>How you mark your ticket</h2>
<div class="card">
  <ul class="kv">
    <li>Numbers you were offered<b>${a.decisions}</b></li>
    <li>You answered<b>${a.answered} · ${a.responsePct}%</b></li>
    <li>Marked correctly<b>${a.correct} · ${a.accuracyPct}% of answered</b></li>
    <li>On your ticket but missed<b>${a.missed}</b></li>
    <li>Tapped but not on your ticket<b>${a.wrong_taps}</b></li>
    <li>Never answered<b>${a.no_response}</b></li>
    <li>Average time to answer<b>${a.avg_seconds ?? '—'}s</b></li>
  </ul>
  <div class="dim" style="font-size:12px;margin-top:10px">
    A missed number is the costly one — it cannot win a prize. A wrong tap costs
    nothing, because prizes are checked against the numbers actually called, not
    against what you marked. Accuracy counts only the numbers you answered, so a
    game where your connection dropped does not count against you.
  </div>
</div>

<h2>Are you improving?</h2>
<div class="card">
  ${imp.enough ? `
    <ul class="kv">
      <li>Accuracy<b>${imp.accuracy.now}% ${movementChip(imp.accuracy)}<span class="dim" style="font-weight:400"> from ${imp.accuracy.before}%</span></b></li>
      <li>Missed per game<b>${imp.missed.now} ${movementChip(imp.missed)}<span class="dim" style="font-weight:400"> from ${imp.missed.before}</span></b></li>
      <li>Wrong taps per game<b>${imp.wrongTaps.now} ${movementChip(imp.wrongTaps)}<span class="dim" style="font-weight:400"> from ${imp.wrongTaps.before}</span></b></li>
    </ul>
    <div class="dim" style="font-size:12px;margin-top:10px">
      Your ${imp.window} most recent games against your ${imp.window} earliest.
    </div>`
    : `<div class="empty">
        You have played ${imp.have} game${imp.have === 1 ? '' : 's'}. After ${imp.needed},
        this section compares your recent games with your earliest ones — before that,
        a "trend" would just be one good or bad afternoon.
       </div>`}
</div>

<h2>Accuracy, game by game</h2>
<div class="card">${lineChart(d.games)}</div>

<h2>When you play</h2>
<div class="card">
  <div class="dim" style="font-size:12px;margin-bottom:4px">Games per day</div>
  ${barChart(d.byDay, { key: 'games', label: 'games' })}
  <div class="dim" style="font-size:12px;margin:14px 0 4px">Games by hour of day</div>
  ${barChart(d.byHour, { key: 'games', label: 'games' })}
</div>

<h2>Every game you have played</h2>
<div class="card scroll">
  <table>
    <thead><tr>
      <th>Date</th><th>Room</th><th>Role</th><th class="num">Players</th>
      <th class="num">Called</th><th class="num">Correct</th><th class="num">Accuracy</th>
      <th class="num">Missed</th><th class="num">Wrong</th><th>Prizes</th><th>Ended</th>
    </tr></thead>
    <tbody>${gameRows || '<tr><td colspan="11" class="dim">No games yet.</td></tr>'}</tbody>
  </table>
</div>

<h2>The people you play with</h2>
<div class="card scroll">
  <table>
    <thead><tr>
      <th class="num">#</th><th>Player</th><th class="num">Games together</th>
      <th class="num">Accuracy</th><th class="num">Prizes</th>
    </tr></thead>
    <tbody>${boardRows || '<tr><td colspan="5" class="dim">Nobody yet.</td></tr>'}</tbody>
  </table>
  <div class="dim" style="font-size:12px;margin-top:10px">
    Ranked over the games you were both in — not the whole platform.
  </div>
</div>

<h2>What to work on</h2>
<div class="card"><ul class="advice">${adviceList}</ul></div>

<button class="btn noprint" onclick="window.print()">Save as PDF / Print</button>

<footer>
  ${esc(config.business.legalName)}<br>
  This report is about one player and is generated from your own game record.
</footer>

</div>
</body>
</html>`;
}
