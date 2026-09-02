/**
 * The two player-facing forms: feedback, and support.
 *
 * Both open from a WhatsApp link, on a phone, often in WhatsApp's own browser.
 * So: one screen, no scrolling to find the button, everything inline, and a
 * finish state that sends them back to the chat rather than leaving them on a
 * dead page wondering whether it worked.
 *
 * Fields the platform already knows are pre-filled, and the number is masked -
 * it is shown so the player can confirm it is theirs, not so it can be edited.
 */
import { config } from '../config/env.js';
import { QUERY_TYPES } from '../services/support.service.js';

const SHELL = (title, body, script, extraCss = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#16151a">
<title>${esc(config.brandName)} — ${esc(title)}</title>
<style>
:root{
  --maroon:#8b1e3f; --maroon-deep:#5c0f2b; --gold:#d4a537;
  --bg:#16151a; --panel:#1f1d24; --line:#332f3b; --text:#e8e6e3; --dim:#9a94a5;
  --ok:#10b981; --bad:#c04b4b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  padding-bottom:env(safe-area-inset-bottom)}
.wrap{max-width:480px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:23px;margin:0 0 4px;color:var(--gold)}
.lede{color:var(--dim);font-size:14.5px;margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
label{display:block;font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.08em;color:var(--dim);margin:14px 0 6px}
label:first-of-type{margin-top:0}
input,select,textarea{width:100%;border-radius:11px;border:1px solid var(--line);
  background:rgba(0,0,0,.25);color:var(--text);padding:12px;font:15px system-ui;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--gold)}
input[readonly]{color:var(--dim);background:rgba(0,0,0,.15)}
textarea{resize:vertical;min-height:110px}
.hint{font-size:12px;color:var(--dim);margin-top:5px}
.btn{display:block;width:100%;padding:15px;border-radius:12px;border:0;cursor:pointer;
  font:700 16px system-ui;background:var(--gold);color:#2b2118;margin-top:18px;
  text-align:center;text-decoration:none}
.btn[disabled]{opacity:.45;cursor:default}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.err{color:var(--bad);font-size:13.5px;margin-top:10px;min-height:1.2em}

/* the finish screen */
#done{display:none;text-align:center;padding:26px 16px;position:relative;overflow:hidden}
#done .tick{width:78px;height:78px;border-radius:50%;margin:0 auto 14px;
  background:linear-gradient(160deg,var(--maroon),var(--maroon-deep));
  border:2px solid var(--gold);display:grid;place-items:center;font-size:38px;
  animation:pop .5s cubic-bezier(.2,1.5,.4,1)}
@keyframes pop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1)}}
#done h2{font-size:21px;margin:0 0 6px;color:var(--gold)}
#done p{color:var(--dim);font-size:14.5px;margin:0}
.ref{display:inline-block;margin-top:14px;padding:9px 16px;border-radius:10px;
  background:rgba(212,165,55,.12);border:1px solid rgba(212,165,55,.35);
  font:700 18px ui-monospace,Menlo,monospace;color:var(--gold);letter-spacing:.08em}
.confetti{position:absolute;top:-10px;width:8px;height:13px;animation:fall linear forwards}
@keyframes fall{0%{transform:translateY(-20px) rotate(0);opacity:1}
  100%{transform:translateY(360px) rotate(720deg);opacity:0}}

/* stars */
.stars{display:flex;gap:6px;justify-content:center;margin:6px 0 2px}
.stars button{flex:1;background:transparent;border:1px solid var(--line);border-radius:12px;
  padding:12px 0;font-size:26px;cursor:pointer;line-height:1;transition:transform .1s}
.stars button:active{transform:scale(.94)}
.stars button.on{border-color:var(--gold);background:rgba(212,165,55,.12)}
.rating-label{text-align:center;color:var(--gold);font-weight:700;min-height:1.4em;font-size:14px}
${extraCss}
</style>
</head>
<body>
<div class="wrap">
  <div id="form">${body}</div>

  <div class="card" id="done">
    <div class="tick" id="tick">🎉</div>
    <h2 id="doneTitle">Thank you!</h2>
    <p id="doneText"></p>
    <div id="doneRef"></div>
    <a class="btn" id="backToWa" href="https://wa.me/${esc(config.whatsapp.businessNumber)}">
      Back to WhatsApp
    </a>
  </div>
</div>
<script>
${script}

/** Drawn, not imported — this page loads on a weak mobile connection. */
function celebrate(){
  var host = document.getElementById('done');
  var colours = ['#d4a537','#ffffff','#10b981','#ff6b8a','#f7dfa5'];
  for (var i = 0; i < 28; i++) {
    var bit = document.createElement('span');
    bit.className = 'confetti';
    bit.style.left = Math.random() * 100 + '%';
    bit.style.background = colours[i % colours.length];
    bit.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
    bit.style.animationDelay = (Math.random() * 0.5) + 's';
    host.appendChild(bit);
  }
}

/**
 * Sends them back to the chat by itself.
 *
 * A form that finishes and just sits there leaves people unsure it worked, so
 * this hands them back to WhatsApp — where the confirmation is already waiting.
 */
function finish(opts){
  document.getElementById('form').style.display = 'none';
  var done = document.getElementById('done');
  done.style.display = 'block';
  document.getElementById('doneTitle').textContent = opts.title;
  document.getElementById('doneText').textContent = opts.text;
  if (opts.reference) {
    document.getElementById('doneRef').innerHTML =
      '<div class="ref">' + opts.reference + '</div>';
  }
  if (opts.tick) document.getElementById('tick').textContent = opts.tick;
  celebrate();
  setTimeout(function(){ window.location.href = document.getElementById('backToWa').href; }, 4000);
}
</script>
</body>
</html>`;

/* ------------------------------------------------------------- feedback */

export function feedbackPage({ player, game }) {
  const body = `
  <h1>How was it?</h1>
  <p class="lede">${game
    ? `Your thoughts on game <b>${esc(game.code)}</b>.`
    : `Your thoughts on ${esc(config.brandName)}.`} Twenty seconds, and it genuinely shapes what we build.</p>

  <div class="card">
    <label>Your rating</label>
    <div class="stars" id="stars">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}">☆</button>`).join('')}
    </div>
    <div class="rating-label" id="ratingLabel"></div>

    <label>Anything you'd like to add? <span style="text-transform:none;font-weight:400">(optional)</span></label>
    <textarea id="comment" placeholder="What worked, what didn't, what you'd change…" maxlength="1000"></textarea>
    <div class="hint">If we publish this as a testimonial we'll only ever show your first name — never your number.</div>

    <button class="btn" id="submit" disabled>Send feedback</button>
    <div class="err" id="err"></div>
  </div>`;

  const script = `
  var rating = 0;
  var LABELS = { 1:'Not great', 2:'Could be better', 3:'It was ok', 4:'Really good', 5:'Loved it!' };

  document.querySelectorAll('#stars button').forEach(function(b){
    b.onclick = function(){
      rating = Number(b.dataset.n);
      document.querySelectorAll('#stars button').forEach(function(x){
        var on = Number(x.dataset.n) <= rating;
        x.classList.toggle('on', on);
        x.textContent = on ? '★' : '☆';
      });
      document.getElementById('ratingLabel').textContent = LABELS[rating];
      document.getElementById('submit').disabled = false;
    };
  });

  document.getElementById('submit').onclick = function(){
    var btn = this;
    btn.disabled = true; btn.textContent = 'Sending…';
    fetch(location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: rating, comment: document.getElementById('comment').value }),
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) throw new Error(res.j.error || 'Could not send that');
        finish({
          title: 'Thank you!',
          text: 'Your feedback is in. We read every one of these.',
          tick: rating >= 4 ? '🎉' : '💛',
        });
      })
      .catch(function(e){
        document.getElementById('err').textContent = e.message;
        btn.disabled = false; btn.textContent = 'Send feedback';
      });
  };`;

  return SHELL('Feedback', body, script);
}

/* -------------------------------------------------------------- support */

export function supportPage({ player, maskedNumber, tickets }) {
  const recent = tickets?.length
    ? `<div class="card" style="margin-top:12px">
         <label style="margin:0 0 8px">Your recent requests</label>
         ${tickets.map((t) => `
           <div style="display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--line);font-size:13.5px">
             <span style="font:700 13px ui-monospace,Menlo,monospace;color:var(--gold)">${esc(t.reference)}</span>
             <span style="color:var(--dim);text-transform:capitalize">${esc(String(t.status).replace(/_/g, ' '))}</span>
           </div>`).join('')}
         <div class="hint" style="margin-top:8px">Send <b>status ${esc(tickets[0].reference)}</b> on WhatsApp any time.</div>
       </div>`
    : '';

  const body = `
  <h1>Contact support</h1>
  <p class="lede">Tell us what's up. We reply on WhatsApp, usually the same day.</p>

  <div class="card">
    <label>Your name</label>
    <input id="name" value="${esc(player.name)}" maxlength="80">

    <label>WhatsApp number</label>
    <input value="${esc(maskedNumber)}" readonly>
    <div class="hint">We'll reply to this number. It can't be changed here.</div>

    <label>Email <span style="text-transform:none;font-weight:400">(optional)</span></label>
    <input id="email" type="email" placeholder="you@example.com" maxlength="120">

    <label>What's it about?</label>
    <select id="queryType">
      ${QUERY_TYPES.map((q) => `<option value="${esc(q.key)}">${esc(q.label)}</option>`).join('')}
    </select>

    <label>Your message</label>
    <textarea id="message" placeholder="As much detail as you can — a game code helps a lot." maxlength="2000"></textarea>

    <button class="btn" id="submit">Send to support</button>
    <div class="err" id="err"></div>
  </div>
  ${recent}`;

  const script = `
  document.getElementById('submit').onclick = function(){
    var btn = this;
    var message = document.getElementById('message').value.trim();
    var name = document.getElementById('name').value.trim();
    var err = document.getElementById('err');

    if (message.length < 10) { err.textContent = 'Please tell us a little more — at least a sentence.'; return; }
    if (!name) { err.textContent = 'Please tell us your name.'; return; }

    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Sending…';

    fetch(location.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        email: document.getElementById('email').value.trim(),
        queryType: document.getElementById('queryType').value,
        message: message,
      }),
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(res){
        if (!res.ok) throw new Error(res.j.error || 'Could not send that');
        finish({
          title: 'We have your message',
          text: 'Keep this reference — we have sent it to you on WhatsApp too.',
          reference: res.j.data.reference,
          tick: '🎫',
        });
      })
      .catch(function(e){
        err.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Send to support';
      });
  };`;

  return SHELL('Support', body, script);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
