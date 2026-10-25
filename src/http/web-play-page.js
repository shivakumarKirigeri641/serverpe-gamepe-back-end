/**
 * Web entry for Tambola and Tap Bakra: sign in with a mobile number and a
 * one-time code, then host, join, or play.
 *
 * Self-contained so web play keeps working even when the marketing site is
 * unavailable.
 *
 * ── Why sign-in, not just a name ──────────────────────────────────────────
 *
 * The first version asked only for a name and minted a fresh player on every
 * host and every join. That meant one person tapping an invite twice took two
 * seats, and nobody ever had a history to come back to. A verified number is a
 * stable identity: the same person is the same player every time, on every
 * device, and joinGame hands back the seat they already have.
 *
 * ── A note for whoever edits the script below ─────────────────────────────
 *
 * This file is a template literal that contains a browser script. The script
 * deliberately uses no backticks and no backslashes: either would be consumed
 * by the outer template, and the page would ship a script that does not parse
 * - which fails silently, as a page where nothing responds.
 */
import { config } from "../config/env.js";

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Values for the script, with < escaped so no value can close the tag. */
const blob = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

export function webPlayPage({
  mode = "web",
  prefillCode = "",
  signInAvailable = true,
  otpLength = 6,
  // Defaults to false rather than true: a caller that forgets to pass this
  // should leave a switched-off game off, not advertise it back into
  // existence.
  bakraAvailable = false,
  // Hand Cricket (2026-10-25): its card, and a friend's invite code from ?cricket=CODE.
  cricketAvailable = false,
  cricketCode = "",
} = {}) {
  const policies = String(config.policiesUrl || "https://mastipe.in/policies").replace(/\/+$/, "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(config.brandName)} - Play</title>
<style>
:root{--bg:#0e1116;--card:#181d24;--line:#293242;--ink:#eaf0f7;--muted:#9eb0c8;--brand:#f5b83d;--ok:#40b37d;--bad:#d66}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 500px at 15% -10%,#1d2533,transparent),var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:22px 14px 36px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),transparent),var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:14px}
h1{margin:0;font-size:1.65rem}
h2{margin:0;font-size:1.1rem}
p{margin:.5rem 0 0;color:var(--muted)}
.row{display:grid;gap:10px;margin-top:12px}
@media(min-width:680px){.row.cols-2{grid-template-columns:1fr 1fr}}
label{font-size:12px;color:var(--muted);display:block;margin-bottom:4px}
input,select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:#0f141b;color:var(--ink);font-size:16px}
input.code{letter-spacing:.35em;font:700 22px ui-monospace,Menlo,monospace;text-align:center}
.phonebox{display:flex;align-items:stretch}
.phonebox span{display:flex;align-items:center;padding:0 12px;border:1px solid var(--line);border-right:0;border-radius:10px 0 0 10px;background:#141a22;color:var(--muted)}
.phonebox input{border-radius:0 10px 10px 0}
button{padding:11px 14px;border-radius:10px;border:0;background:var(--brand);color:#2d2209;font-weight:800;cursor:pointer;font-size:15px}
button.alt{background:#222a37;color:#d8e3f3;border:1px solid #344255}
button.link{background:none;color:var(--muted);padding:6px 0;font-weight:600;text-decoration:underline}
button[disabled]{opacity:.55;cursor:default}
small{color:var(--muted)}
.msg{margin-top:10px;min-height:1.4em;font-size:14px}
.msg.bad{color:var(--bad)} .msg.ok{color:var(--ok)}
.split{display:grid;gap:14px}
@media(min-width:720px){.split{grid-template-columns:1fr 1fr}}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--muted)}
.check input{width:20px;height:20px;margin-top:1px;flex:none}
.check a{color:var(--brand)}
.check.flag{color:var(--bad)}
.hidden{display:none !important}
.who{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap}
.pill{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 10px}
.return{border-color:rgba(245,184,61,.5)}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Play on the web</h1>
    <p>No app needed. Sign in with your mobile number, then host a game${
      bakraAvailable ? ", join one, or play Tap Bakra" : " or join one"
    }${cricketAvailable ? " - or play Hand Cricket" : ""}.</p>

    <!-- ── unavailable ──────────────────────────────────────────────── -->
    <section class="card hidden" id="unavailable">
      <h2>Sign-in is not available right now</h2>
      <p>We cannot send sign-in codes at the moment. Please try again a little later.</p>
    </section>

    <!-- ── step 1: the number ───────────────────────────────────────── -->
    <!--
      ── joining an invite: a name, and in ──────────────────────────────

      Shown instead of the number form when somebody arrives with a room
      code, which is how every invited player arrives. They are standing in a
      room with a game about to start; sending them off to an SMS app is how
      a host ends up waiting with half a table.

      The host still signs in properly. They are the organiser, the repeat
      visitor, and the number actually worth having.
    -->
    <section class="card hidden" id="stepGuest">
      <h2 id="guestTitle">Join the game</h2>
      <p><span id="guestWhat">Room</span> <b id="guestCode"></b>. Just your name - no number needed.</p>
      <div class="row">
        <div>
          <label>Your name - shown to the other players</label>
          <input id="guestName" maxlength="40" autocomplete="given-name" placeholder="Priya" />
        </div>
        <label class="check" id="guestConsentRow">
          <input type="checkbox" id="guestConsent" />
          <span>I agree to the <a href="${esc(policies)}/terms" target="_blank" rel="noopener">Terms</a>
            and <a href="${esc(policies)}/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
            Entertainment only - no betting, no money.</span>
        </label>
        <button id="guestBtn">Join game</button>
        <button class="link" id="guestSignInBtn">I have a number - sign in instead</button>
        <div id="guestMsg" class="msg"></div>
      </div>
    </section>

    <section class="card hidden" id="stepPhone">
      <h2>Your mobile number</h2>
      <p>We will send a ${otpLength}-digit code by SMS.</p>
      <div class="row">
        <div class="phonebox">
          <span>+91</span>
          <input id="phone" type="tel" inputmode="numeric" autocomplete="tel-national"
                 maxlength="14" placeholder="98765 43210" />
        </div>
        <button id="sendBtn">Send code</button>
        <div id="phoneMsg" class="msg"></div>
      </div>
    </section>

    <!-- ── step 2: the code ─────────────────────────────────────────── -->
    <section class="card hidden" id="stepCode">
      <h2>Enter the code</h2>
      <p>Sent to <b id="sentTo"></b>. <button class="link" id="changeBtn">Change number</button></p>
      <div class="row">
        <div>
          <label>${otpLength}-digit code</label>
          <input id="code" class="code" type="text" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="${otpLength}" placeholder="${"•".repeat(otpLength)}" />
        </div>
        <div>
          <label>Your name - shown to other players (first time only)</label>
          <input id="name" maxlength="40" autocomplete="given-name" placeholder="Priya" />
        </div>
        <!--
          Unticked, always. A pre-ticked box is not consent. A player who has
          already agreed is not made to tick it again - the server only
          requires it when there is no agreement on record.
        -->
        <label class="check" id="consentRow">
          <input type="checkbox" id="consent" />
          <span>I agree to the <a href="${esc(policies)}/terms" target="_blank" rel="noopener">Terms</a>
            and <a href="${esc(policies)}/privacy" target="_blank" rel="noopener">Privacy Policy</a>.
            Entertainment only - no betting, no money.</span>
        </label>
        <button id="verifyBtn">Continue</button>
        <button class="link" id="resendBtn" disabled>Resend code</button>
        <div id="codeMsg" class="msg"></div>
      </div>
    </section>

    <!-- ── signed in ────────────────────────────────────────────────── -->
    <div class="hidden" id="home">
      <section class="card">
        <div class="who">
          <div><h2 id="hello">Welcome</h2><small id="whoPhone"></small></div>
          <button class="alt" id="logoutBtn">Sign out</button>
        </div>
      </section>

      <section class="card return hidden" id="activeCard">
        <h2>You are in a game</h2>
        <p>Room <b id="activeCode"></b> - your seat is waiting.</p>
        <div class="row"><button id="activeBtn">Go back to your game</button></div>
      </section>

      <div class="split">
        <section class="card">
          <h2>Host a Tambola game</h2>
          <div class="row">
            <div>
              <label>Players expected, including you</label>
              <input id="hostPlayers" type="number" inputmode="numeric" min="2" max="200" value="6" />
            </div>
            <button id="hostBtn">Create game</button>
            <small>You will get a link to share with everyone.</small>
            <div id="hostMsg" class="msg"></div>
          </div>
        </section>

        <section class="card">
          <h2>Join a Tambola game</h2>
          <div class="row">
            <div>
              <label>Game code</label>
              <input id="joinCode" maxlength="10" autocapitalize="characters"
                     value="${esc(prefillCode)}" placeholder="ABC123" />
            </div>
            <button class="alt" id="joinBtn">Join game</button>
            <small>Your host has the 6-character code.</small>
            <div id="joinMsg" class="msg"></div>
          </div>
        </section>
      </div>

      ${
        bakraAvailable
          ? `<section class="card">
        <h2>Tap Bakra</h2>
        <p>Tap fast, think faster. Ten questions, sixty seconds, on your own.</p>
        <div class="row">
          <button id="bakraBtn">Play Tap Bakra</button>
          <div id="bakraMsg" class="msg"></div>
        </div>
      </section>`
          : ""
      }

      ${
        cricketAvailable
          ? `<section class="card" id="cricketCard">
        <h2>🏏 Hand Cricket</h2>
        <p>Show a number from 1 to 6 - same number as the bowler and you are OUT. Two overs, two wickets, then chase.</p>
        <div class="row cols-2">
          <div>
            <label>Against the bot</label>
            <select id="crLevel">
              <option value="easy">Easy</option>
              <option value="medium" selected>Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <button id="crBotBtn" style="align-self:end">Play vs bot</button>
        </div>
        <div class="row cols-2">
          <button class="alt" id="crFriendBtn">Play a friend</button>
          <div style="display:flex;gap:8px">
            <input id="crCode" maxlength="10" autocapitalize="characters" placeholder="Match code" value="${esc(cricketCode)}" />
            <button class="alt" id="crJoinBtn">Join</button>
          </div>
        </div>
        <small>Play a friend gives you a link to send them on WhatsApp - they join with just a name.</small>
        <div id="crMsg" class="msg"></div>
      </section>`
          : ""
      }
    </div>
  </div>

<script>
window.__PLAY__ = ${blob({ mode, prefillCode, signInAvailable, otpLength, cricketCode })};
(function(){
  var CFG = window.__PLAY__;
  var TOKEN_KEY = 'mastipe.play.token';
  var marker = '/public/play';
  var at = location.pathname.indexOf(marker);
  var apiBase = at >= 0 ? location.pathname.slice(0, at) : '';
  var $ = function(id){ return document.getElementById(id); };

  /* localStorage can throw in private modes and some in-app browsers. The
     page must still work there - it just will not remember the sign-in. */
  function getToken(){ try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t){ try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function clearToken(){ try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  var memToken = getToken();
  var phone = '';
  var resendTimer = 0;

  function call(method, path, body){
    var headers = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (memToken) headers['Authorization'] = 'Bearer ' + memToken;
    return fetch(apiBase + path, {
      method: method, headers: headers, body: body ? JSON.stringify(body) : undefined,
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(payload){
        if (!res.ok) {
          var err = new Error(payload.error || ('Something went wrong (' + res.status + ')'));
          err.code = payload.code; err.status = res.status;
          err.retryAfter = payload.retryAfterSeconds;
          throw err;
        }
        return payload.data || payload;
      });
    });
  }

  /*
   * Journey beacon.
   *
   * Tells the server the steps it cannot otherwise see - the page opening, a
   * number being typed, a code being typed, and giving up part-way. Without
   * these, somebody who lands from an ad and leaves is completely invisible.
   *
   * Deliberately fire-and-forget: the catch swallows everything, so a blocked
   * request, an ad blocker or an offline phone can never surface an error or
   * hold up the thing the person is actually trying to do.
   */
  var reached = 'landed';
  function beacon(step, extra){
    reached = step;
    var body = { step: step };
    if (extra && extra.phone) body.phone = extra.phone;
    if (extra && extra.at) body.at = extra.at;
    try {
      fetch(apiBase + '/public/play/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function(){});
    } catch (e) { /* never */ }
  }

  function show(el, msg, ok){
    if (!el) return;
    el.className = 'msg ' + (ok ? 'ok' : 'bad');
    el.textContent = msg || '';
  }

  function screen(id){
    ['unavailable', 'stepGuest', 'stepPhone', 'stepCode', 'home'].forEach(function(s){
      $(s).classList.toggle('hidden', s !== id);
    });
  }

  function busy(btn, on, label){
    btn.disabled = on;
    if (label) btn.textContent = label;
  }

  /* ── step 1 ─────────────────────────────────────────────────────────── */

  function sendCode(){
    var btn = $('sendBtn');
    var digits = $('phone').value.replace(/[^0-9]/g, '');
    if (digits.length === 12 && digits.indexOf('91') === 0) digits = digits.slice(2);
    if (digits.length === 11 && digits.charAt(0) === '0') digits = digits.slice(1);
    if (digits.length !== 10) { show($('phoneMsg'), 'Enter your 10-digit mobile number.'); return; }

    // Raised here rather than on keystrokes: one beacon when a complete,
    // plausible number has been entered, not one per character typed.
    beacon('phone_entered', { phone: digits });

    busy(btn, true, 'Sending...');
    show($('phoneMsg'), '');
    call('POST', '/public/play/otp/request', { phone: digits }).then(function(out){
      phone = digits;
      $('sentTo').textContent = out.sentTo || ('+91 ' + digits);
      screen('stepCode');
      startResend(out.resendAfterSeconds || 30);
      setTimeout(function(){ $('code').focus(); }, 50);
    }).catch(function(err){
      if (err.code === 'sms_unavailable') { screen('unavailable'); return; }
      show($('phoneMsg'), err.message);
    }).then(function(){ busy(btn, false, 'Send code'); });
  }

  function startResend(seconds){
    var btn = $('resendBtn');
    var left = seconds;
    clearInterval(resendTimer);
    btn.disabled = true;
    btn.textContent = 'Resend code in ' + left + 's';
    resendTimer = setInterval(function(){
      left -= 1;
      if (left <= 0) {
        clearInterval(resendTimer);
        btn.disabled = false;
        btn.textContent = 'Resend code';
      } else {
        btn.textContent = 'Resend code in ' + left + 's';
      }
    }, 1000);
  }

  /* ── step 2 ─────────────────────────────────────────────────────────── */

  function verify(){
    var btn = $('verifyBtn');
    var code = $('code').value.replace(/[^0-9]/g, '');
    /*
     * A RANGE, not an exact length.
     *
     * This used to insist on exactly CFG.otpLength digits, which silently
     * made standing codes (OTP_FIXED_CODES) unusable: a four-digit one was
     * rejected here and never reached the server, so a correct code looked
     * like a typo.
     *
     * The page is not told which numbers have a standing code, on purpose -
     * that would let anyone discover it by asking for a code on a number they
     * do not own. So the client check is only a courtesy against an obvious
     * slip, and the server remains the one that decides.
     */
    if (code.length < 4 || code.length > 8) { show($('codeMsg'), 'Enter the ' + CFG.otpLength + '-digit code.'); return; }

    beacon('code_entered');

    $('consentRow').classList.remove('flag');
    busy(btn, true, 'Checking...');
    show($('codeMsg'), '');
    call('POST', '/public/play/otp/verify', {
      phone: phone,
      code: code,
      displayName: $('name').value,
      consent: $('consent').checked === true,
    }).then(function(out){
      memToken = out.token;
      setToken(out.token);
      clearInterval(resendTimer);
      enterHome(out.player, null, true);
    }).catch(function(err){
      if (err.code === 'consent_required') $('consentRow').classList.add('flag');
      if (err.code === 'name_required') $('name').focus();
      if (err.code === 'expired' || err.code === 'locked' || err.code === 'used') $('code').value = '';
      show($('codeMsg'), err.message);
    }).then(function(){ busy(btn, false, 'Continue'); });
  }

  /* ── signed in ──────────────────────────────────────────────────────── */

  function enterHome(player, active, justSignedIn){
    // Signed in and through: closing the tab from here is not abandoning
    // anything, so stop the pagehide beacon reporting a drop-off that did
    // not happen. The server already recorded the sign-in itself.
    reached = 'done';
    $('hello').textContent = player && player.name ? ('Hi, ' + player.name) : 'Welcome';
    $('whoPhone').textContent = player ? player.phone : '';

    var card = $('activeCard');
    if (active && active.boardUrl) {
      $('activeCode').textContent = active.code;
      $('activeBtn').onclick = function(){ location.href = active.boardUrl; };
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
    screen('home');

    // Arrived from an invite link: take them straight to the room they were
    // invited to, rather than making them find the Join button and press it.
    if (justSignedIn && CFG.prefillCode) join();
    // The same for a Hand Cricket invite - signed in already, or just now.
    else if (CFG.cricketCode) crJoin();
  }

  function goTo(url){ location.href = url; }

  function signedOut(err){
    if (err && err.status === 401) {
      memToken = null; clearToken(); screen('stepPhone');
      show($('phoneMsg'), 'Please sign in again.');
      return true;
    }
    return false;
  }

  function host(){
    var btn = $('hostBtn');
    busy(btn, true, 'Creating...');
    show($('hostMsg'), '');
    call('POST', '/public/play/host', { expectedPlayers: Number($('hostPlayers').value) })
      .then(function(out){ show($('hostMsg'), 'Opening your game room...', true); goTo(out.boardUrl); })
      .catch(function(err){ if (!signedOut(err)) show($('hostMsg'), err.message); })
      .then(function(){ busy(btn, false, 'Create game'); });
  }

  function join(){
    var btn = $('joinBtn');
    var code = $('joinCode').value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!code) { show($('joinMsg'), 'Enter the game code.'); return; }
    busy(btn, true, 'Joining...');
    show($('joinMsg'), '');
    call('POST', '/public/play/join', { code: code })
      .then(function(out){ show($('joinMsg'), 'Opening your game room...', true); goTo(out.boardUrl); })
      .catch(function(err){ if (!signedOut(err)) show($('joinMsg'), err.message); })
      .then(function(){ busy(btn, false, 'Join game'); });
  }

${
  bakraAvailable
    ? `  function bakra(){
    var btn = $('bakraBtn');
    busy(btn, true, 'Starting...');
    show($('bakraMsg'), '');
    var lang = (navigator.language || 'en').toLowerCase().indexOf('hi') === 0 ? 'hi' : 'en';
    call('POST', '/public/play/bakra', { lang: lang })
      .then(function(out){ goTo(out.url); })
      .catch(function(err){ if (!signedOut(err)) show($('bakraMsg'), err.message); })
      .then(function(){ busy(btn, false, 'Play Tap Bakra'); });
  }`
    : "  // The second game is switched off; its handler is not emitted."
}

  /* Hand Cricket. Defined even when the card is left out, so an invite arriving
     while the game is off answers with the server's honest refusal instead of a
     script error. */
  function crLang(){ return (navigator.language || 'en').toLowerCase().indexOf('hi') === 0 ? 'hi' : 'en'; }
  function crGo(path, body, btn, label){
    if (btn) busy(btn, true, 'Starting...');
    show($('crMsg'), '');
    return call('POST', path, body)
      .then(function(out){ goTo(out.url); })
      .catch(function(err){ if (!signedOut(err)) show($('crMsg') || $('guestMsg'), err.message); })
      .then(function(){ if (btn) busy(btn, false, label); });
  }
  function crBot(){ crGo('/public/play/cricket/bot', { level: $('crLevel').value, lang: crLang() }, $('crBotBtn'), 'Play vs bot'); }
  function crFriend(){ crGo('/public/play/cricket/friend', { lang: crLang() }, $('crFriendBtn'), 'Play a friend'); }
  function crJoin(){
    var box = $('crCode');
    var code = String((box && box.value) || CFG.cricketCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!code) { show($('crMsg'), 'Enter the match code.'); return; }
    crGo('/public/play/cricket/join', { code: code }, $('crJoinBtn'), 'Join');
  }

  function logout(){
    call('POST', '/public/play/logout').catch(function(){}).then(function(){
      memToken = null; clearToken();
      $('code').value = '';
      screen('stepPhone');
    });
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */

  function joinAsGuest(){
    var btn = $('guestBtn');
    var name = $('guestName').value.trim();
    if (name.length < 2) { show($('guestMsg'), 'Please tell us your name.'); return; }
    if ($('guestConsent').checked !== true) {
      $('guestConsentRow').classList.add('flag');
      show($('guestMsg'), 'Please accept the terms to continue.');
      return;
    }
    $('guestConsentRow').classList.remove('flag');
    busy(btn, true, 'Joining...');
    show($('guestMsg'), '');
    call('POST', '/public/play/guest', { displayName: name, consent: true })
      .then(function(out){
        memToken = out.token;
        setToken(out.token);
        reached = 'done';
        // Straight into the room they were invited to. They came from a link
        // with a code in it; making them now find and press Join would be a
        // step for nothing. A Hand Cricket invite goes to its match instead.
        if (CFG.cricketCode) return call('POST', '/public/play/cricket/join', { code: CFG.cricketCode })
          .then(function(out){ return { boardUrl: out.url }; });
        return call('POST', '/public/play/join', { code: CFG.prefillCode });
      })
      .then(function(out){ show($('guestMsg'), 'Opening your game room...', true); goTo(out.boardUrl); })
      .catch(function(err){ show($('guestMsg'), err.message); })
      .then(function(){ busy(btn, false, 'Join game'); });
  }

  $('guestBtn').onclick = joinAsGuest;
  $('guestName').onkeydown = function(e){ if (e.key === 'Enter') joinAsGuest(); };
  $('guestSignInBtn').onclick = function(){ screen('stepPhone'); $('phone').focus(); };
  $('sendBtn').onclick = sendCode;
  $('phone').onkeydown = function(e){ if (e.key === 'Enter') sendCode(); };
  $('verifyBtn').onclick = verify;
  $('code').onkeydown = function(e){ if (e.key === 'Enter') verify(); };
  $('resendBtn').onclick = function(){ $('phone').value = phone; sendCode(); };
  $('changeBtn').onclick = function(){ clearInterval(resendTimer); screen('stepPhone'); $('phone').focus(); };
  $('hostBtn').onclick = host;
  $('joinBtn').onclick = join;
  // Conditional because the card is left out of the document entirely when the
  // game is switched off. Assigning onclick on null throws, and a throw here
  // takes down every handler below it - including sign-in. One switched-off
  // game must not cost anybody the ability to log in.
${bakraAvailable ? "  $('bakraBtn').onclick = bakra;" : ''}
${cricketAvailable ? "  $('crBotBtn').onclick = crBot;\n  $('crFriendBtn').onclick = crFriend;\n  $('crJoinBtn').onclick = crJoin;" : ''}
  $('logoutBtn').onclick = logout;

  /* ── start ──────────────────────────────────────────────────────────── */

  /*
   * The arrival, and the giving up.
   *
   * 'landed' fires once per page load - this is the one that tells you a
   * Status ad actually produced a visit rather than only an impression.
   *
   * 'abandoned' goes out on pagehide, carrying the furthest step they got to,
   * which is the number you actually want: how many typed a mobile number and
   * then left. pagehide rather than beforeunload because it is the only one
   * mobile Safari reliably fires, and keepalive on the fetch is what lets the
   * request survive the page being torn down. Nothing is sent once they are
   * in - a player who reached the game has not abandoned anything.
   */
  beacon('landed');

  window.addEventListener('pagehide', function(){
    if (reached !== 'landed' && reached !== 'done') beacon('abandoned', { at: reached });
  });

  /*
   * Where a new arrival starts.
   *
   * With a room code in the URL they were invited: name and in. Without one
   * they came to host or to find their own games, which needs a number.
   *
   * Note sign-in being unavailable no longer blocks an invited player -
   * guests need no SMS at all, so a provider outage stops new hosts but a
   * game already being set up can still fill. That is deliberate: it would be
   * perverse for the room to empty because of something only the host needs.
   */
  var invited = !!(CFG.prefillCode || CFG.cricketCode);
  // A Hand Cricket invite says so on the welcome card.
  function guestCard(){
    if (CFG.cricketCode) {
      $('guestTitle').textContent = 'Your friend challenged you to Hand Cricket';
      $('guestWhat').textContent = 'Match';
      $('guestCode').textContent = CFG.cricketCode;
      $('guestBtn').textContent = 'Play';
    } else {
      $('guestCode').textContent = CFG.prefillCode;
    }
    screen('stepGuest');
  }

  if (memToken) {
    call('GET', '/public/play/me').then(function(me){
      enterHome(me.player, me.activeGame, false);
    }).catch(function(){
      // An expired or revoked session is ordinary; start again.
      memToken = null; clearToken();
      if (invited) guestCard();
      else if (!CFG.signInAvailable) screen('unavailable');
      else screen('stepPhone');
    });
  } else if (invited) {
    guestCard();
  } else if (!CFG.signInAvailable) {
    screen('unavailable');
  } else {
    screen('stepPhone');
  }
})();
</script>
</body>
</html>`;
}
