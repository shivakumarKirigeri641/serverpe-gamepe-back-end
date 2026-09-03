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
/* Sound is on by default but must be one tap away from off: this is played in
   living rooms, on speakerphone, next to someone watching television. */
.mute{
  margin-left:auto;background:none;border:1px solid var(--line);border-radius:8px;
  color:var(--text);font-size:13px;line-height:1;padding:6px 8px;cursor:pointer;
}
.mute.off{opacity:.45}
.code{margin-left:8px;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
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
/* Tinted from the start, not only once chosen.
   Two identical grey buttons make the player read both labels every single
   number. Colour lets them answer by position and glance - and green/red is
   the one pairing everyone already knows. Kept pale: a saturated pair would
   compete with the called number, which is the thing they are meant to look
   at. */
.answer button{
  padding:14px 8px;border-radius:12px;cursor:pointer;
  border:1px solid transparent;color:var(--text);font:600 15px system-ui;
  transition:transform .12s cubic-bezier(.2,1.4,.4,1),background .18s,border-color .18s,box-shadow .18s;
}
.answer button.yes{background:rgba(63,164,106,.16);border-color:rgba(63,164,106,.45)}
.answer button.no {background:rgba(192,75,75,.14);border-color:rgba(192,75,75,.42)}

/* Waiting for an answer, the pair breathes very slightly. Enough to read as
   "your turn", far too little to be a distraction over ninety numbers. */
.answer.awaiting button.yes{animation:breatheYes 2.4s ease-in-out infinite}
.answer.awaiting button.no {animation:breatheNo  2.4s ease-in-out infinite}
@keyframes breatheYes{
  0%,100%{box-shadow:0 0 0 0 rgba(63,164,106,0)}
  50%    {box-shadow:0 0 0 5px rgba(63,164,106,.10)}
}
@keyframes breatheNo{
  0%,100%{box-shadow:0 0 0 0 rgba(192,75,75,0)}
  50%    {box-shadow:0 0 0 5px rgba(192,75,75,.09)}
}

.answer button:active{transform:scale(.95)}

/* The chosen one fills in and gives a single confident pop. The other fades
   back rather than vanishing, so the pair still reads as a choice that was
   made rather than a button that disappeared. */
.answer button.yes.on{background:var(--ok);border-color:var(--ok);color:#fff;animation:chosen .32s cubic-bezier(.2,1.6,.4,1)}
.answer button.no.on {background:var(--no);border-color:var(--no);color:#fff;animation:chosen .32s cubic-bezier(.2,1.6,.4,1)}
@keyframes chosen{
  0%  {transform:scale(.94)}
  55% {transform:scale(1.06)}
  100%{transform:scale(1)}
}

.answer button[disabled]{cursor:default}
.answer button[disabled]:not(.on){opacity:.4;filter:saturate(.4)}

@media (prefers-reduced-motion: reduce){
  .answer.awaiting button.yes,
  .answer.awaiting button.no,
  .answer button.yes.on,
  .answer button.no.on{animation:none}
}
/* Only ever carries an error ("could not record that"). There is no
   right/wrong styling because the board never tells a player whether their
   answer was correct - that comes at the end of the game. */
.nudge{text-align:center;font-size:13px;color:var(--dim);min-height:1.3em;margin:-4px 0 8px}

/* ---- waiting for the rest of the table ---- */
/* Always rendered, even before there is anything to say.
   It used to appear only after the player answered, which pushed the ticket
   and the whole board down the screen at the exact moment they were looking at
   it - the numbers they had just been reading slid out from under their eyes.
   The box now holds its place and only its contents fade in. */
.waiting{
  display:flex;align-items:center;gap:10px;justify-content:center;
  background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:12px;margin:10px 0;font-size:14px;color:var(--dim);
  min-height:45px;
  transition:opacity .2s;
}
.waiting.blank{
  /* Invisible but still measured: visibility, not display. */
  visibility:hidden;
}
.waiting .spin{
  width:15px;height:15px;border-radius:50%;flex:none;
  border:2px solid var(--line);border-top-color:var(--gold);
  animation:spin .9s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.waiting b{color:var(--text)}

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

/* ---- leaving the game --------------------------------------------------
   Deliberately quiet. Exit is a real action with no undo, but it is not the
   thing a player came here to do, so it does not get to look like one of the
   answer buttons. Small, muted, and at the bottom - findable when wanted,
   invisible when not. */
.exitrow{display:flex;justify-content:center;margin:18px 0 4px}
.exitbtn{
  background:none;border:1px solid var(--line);border-radius:10px;
  color:var(--dim);font:600 13px system-ui;padding:9px 16px;cursor:pointer;
}
.exitbtn:active{transform:scale(.97)}

/* The confirmation. A modal is the right shape here and the wrong shape for
   the end of a game: this one is asking a question that needs an answer, and
   the game genuinely should not continue behind it. */
/* No backdrop-filter here on purpose. The blur is decorative, WhatsApp's
   in-app browser renders it inconsistently, and where it misbehaves it makes
   the dialog itself look half-transparent - which is worse than no blur at all. A
   plain 92% ground does the job everywhere. */
#leaveask{
  position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:22px;
  background:rgba(10,9,13,.92);animation:fadein .2s ease-out;
}
@keyframes fadein{from{opacity:0}to{opacity:1}}
#leaveask .box{
  background:var(--panel);border:1px solid var(--line);border-radius:16px;
  padding:20px;max-width:360px;width:100%;
}
#leaveask h3{margin:0 0 10px;font:800 19px/1.3 system-ui;color:var(--text)}
#leaveask p{margin:0 0 10px;font-size:14px;line-height:1.6;color:var(--dim)}
#leaveask .warn{
  background:rgba(192,75,75,.1);border:1px solid rgba(192,75,75,.35);
  border-radius:10px;padding:11px 13px;font-size:13.5px;color:#f0b8b8;margin:12px 0 4px;
}
#leaveask .row{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:16px}
#leaveask button{padding:13px 10px;border-radius:11px;font:700 14px system-ui;cursor:pointer;border:1px solid var(--line)}
#leaveask .stay{background:var(--gold);border-color:var(--gold);color:#2b2118}
#leaveask .go{background:transparent;color:var(--no);border-color:rgba(192,75,75,.5)}

/* Someone else walked out. */
.leftnote{
  background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;
  padding:13px;margin:10px 0;font-size:14px;color:var(--dim);text-align:center;
}
.leftnote b{color:var(--text)}

/* ---- how the game ended -------------------------------------------------
   The first thing on the results screen, and always present: whatever else
   happened, a player is owed a plain sentence saying why the game stopped.

   This deliberately replaced a full-screen overlay. Covering the board the
   instant the last number lands reads as an error dialog, not an ending - it
   arrives without warning, hides what the player was looking at, and has to be
   dismissed. An inline banner says the same thing, in the same place the
   results are about to appear, without taking the screen away from anyone. */
.ended{
  background:linear-gradient(160deg,rgba(139,30,63,.5),rgba(92,15,43,.55));
  border:1px solid rgba(212,165,55,.35);border-radius:14px;
  padding:16px 16px 14px;margin:10px 0;
}
.ended .label{
  font:700 11px/1 system-ui;letter-spacing:.16em;text-transform:uppercase;
  color:var(--gold);opacity:.9;
}
.ended .why{margin-top:9px;font:600 16px/1.5 system-ui;color:var(--text)}
.ended .why b{color:var(--gold)}
/* The return strip. Part of the banner, never on top of it. */
.ended .ret{
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  margin-top:14px;padding-top:12px;border-top:1px solid rgba(212,165,55,.2);
  font-size:13px;color:var(--dim);
}
/* [hidden] only sets display:none at the lowest specificity, so the rule
   above would beat it and leave an empty strip with a divider above it. */
.ended .ret[hidden]{display:none}
.ended .ret .n{
  width:24px;height:24px;border-radius:50%;flex:none;display:grid;place-items:center;
  background:rgba(212,165,55,.16);border:1px solid rgba(212,165,55,.45);
  font:700 12px ui-monospace,Menlo,monospace;color:var(--gold);
}
.ended .ret .stay{
  margin-left:auto;font-size:13px;color:var(--dim);text-decoration:underline;
  background:none;border:0;cursor:pointer;padding:4px 0;
}
/* The results fade in rather than snapping into place, so the change of
   screen reads as the game finishing rather than something going wrong. */
.overview-in{animation:easein .45s ease-out}
@keyframes easein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

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
/* There is deliberately no style for "the number being called is on this
   ticket". Highlighting it would answer the question the player is being
   asked. See updateTicket(). */

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
/* A fixed grid, never a scroller.
   Six prizes used to sit in a horizontal scroller, which meant Full House -
   the one everybody is playing for - was off-screen on a phone until you
   thought to swipe a bar you had no reason to think was swipeable. Three
   across, two down, every cell exactly one third: the layout cannot move,
   whatever the buttons say. */
.claims .row{
  display:grid;grid-template-columns:repeat(3,1fr);gap:6px;
  max-width:520px;margin:0 auto;
}
@media (min-width:560px){
  /* Room for one row once the screen allows it, still six equal cells. */
  .claims .row{grid-template-columns:repeat(6,1fr)}
}
.claims button{
  min-width:0;                 /* lets a grid cell shrink instead of overflowing */
  padding:9px 6px;border-radius:9px;border:1px solid var(--line);
  background:var(--panel);color:var(--dim);font:600 12.5px system-ui;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  transition:background .15s,border-color .15s,color .15s;
}

/* Deliberately NO styling for "you could claim this now".
   Spotting a completed line is the game. The board withholds whether a called
   number is on your ticket, and lighting up the prize would give away the same
   thing one step later - it would announce a finished line to somebody who had
   not found it. Every button stays tappable at all times; a claim that is not
   valid yet is simply refused, which costs nothing. */

/* Won by somebody else. Struck through, and the name is NOT appended: doing so
   changed the button's width mid-game and shifted every other button under the
   player's thumb. The winner is in the results and in the toast. */
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
    <button class="mute" id="mute" title="Sound" aria-label="Sound on or off">&#128266;</button>
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
  // ---- sound ----
  //
  // Synthesised, not loaded. The board ships as one file with no external
  // requests, and two short audio files would be the first thing to break that
  // - and the first thing to fail on a weak connection, arriving after the
  // moment they were meant to accompany.
  //
  // Everything here is wrapped so that a browser with no Web Audio, or one
  // that refuses to start it, simply plays nothing. A game must never fail
  // because a sound could not.
  var audio = null;
  var muted = false;
  try { muted = localStorage.getItem('mastipe.muted') === '1'; } catch (e) {}

  /**
   * The AudioContext, created on demand.
   *
   * Browsers refuse to start one outside a user gesture, and on iOS an
   * existing context is suspended whenever the page is backgrounded - which
   * WhatsApp's in-app browser does constantly. So this resumes on every call
   * rather than assuming the first success holds.
   */
  function ac(){
    if (muted) return null;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audio) audio = new Ctx();
      if (audio.state === 'suspended') audio.resume().catch(function(){});
      return audio;
    } catch (e) { return null; }
  }

  /**
   * One note.
   *
   * The envelope matters more than the pitch: a tone that starts and stops
   * abruptly clicks, which on a phone speaker sounds like a fault rather than
   * a sound. Ramping up over 12ms and decaying away removes it.
   */
  function tone(freq, startAt, durSec, peak, type){
    var a = ac(); if (!a) return;
    try {
      var t0 = a.currentTime + (startAt || 0);
      var osc = a.createOscillator();
      var gain = a.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
      osc.connect(gain); gain.connect(a.destination);
      osc.start(t0); osc.stop(t0 + durSec + 0.02);
    } catch (e) {}
  }

  /** Marking a number you have: two quick rising notes, like a stamp landing. */
  function soundMark(){
    tone(660, 0,     0.10, 0.16, 'triangle');
    tone(990, 0.055, 0.16, 0.13, 'triangle');
  }

  /** Answering "not on mine": deliberately quieter and lower. Not a failure. */
  function soundPass(){
    tone(300, 0, 0.09, 0.05, 'sine');
  }

  /** One second of the countdown. */
  function soundTick(){
    tone(520, 0, 0.07, 0.10, 'square');
  }

  /** Zero: a short rising fanfare as the first number arrives. */
  function soundGo(){
    tone(523.25, 0,    0.18, 0.16, 'triangle');   // C5
    tone(659.25, 0.10, 0.18, 0.16, 'triangle');   // E5
    tone(783.99, 0.20, 0.34, 0.18, 'triangle');   // G5
  }

  /**
   * The last seconds before the next number.
   *
   * Rises as the time runs out - 5 seconds and 1 second should not sound the
   * same, or the tick carries no information and becomes wallpaper. Kept
   * quieter than the marking sound: this is a nudge, and it fires up to five
   * times per number, so anything louder would wear out fast.
   */
  function soundUrgent(secondsLeft){
    var hz = 440 + (5 - Math.min(5, secondsLeft)) * 70;   // 440 → 720
    tone(hz, 0, 0.05, secondsLeft <= 2 ? 0.09 : 0.06, 'square');
  }

  /** A prize is won. */
  function soundWin(){
    tone(659.25, 0,    0.16, 0.15, 'triangle');
    tone(783.99, 0.12, 0.16, 0.15, 'triangle');
    tone(1046.5, 0.24, 0.42, 0.17, 'triangle');
  }

  function paintMute(){
    var b = document.getElementById('mute');
    if (!b) return;
    b.classList.toggle('off', muted);
    b.innerHTML = muted ? '&#128263;' : '&#128266;';
    b.title = muted ? 'Sound off' : 'Sound on';
  }

  (function wireMute(){
    var b = document.getElementById('mute');
    if (!b) return;
    paintMute();
    b.onclick = function(){
      muted = !muted;
      try { localStorage.setItem('mastipe.muted', muted ? '1' : '0'); } catch (e) {}
      paintMute();
      // Tapping the button IS a gesture, so this is the reliable moment to
      // start the audio context - and the confirmation doubles as a check
      // that sound actually works on this device.
      if (!muted) soundMark();
    };
  })();

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

    // Someone walked out. Named, so a player count dropping on its own does
    // not read as something breaking.
    es.addEventListener('left', function(e){
      var d = JSON.parse(e.data || '{}');
      toast((d.name || 'A player') + ' left the game' +
        (d.remaining ? ' · ' + d.remaining + ' still playing' : ''));
      refresh();
    });

    es.addEventListener('claim', function(e){
      var c = JSON.parse(e.data);
      toast(c.winner + ' claimed ' + c.label + '!');
      soundWin();
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
        soundTick();
        // Re-trigger the animation by removing and re-adding the class.
        node.className = 'n'; void node.offsetWidth; node.className = 'n tick';
      } else {
        soundGo();
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
  // Whether this page ever saw the game actually being played. It separates
  // "the game just ended in front of me" from "I opened a board that finished
  // an hour ago" - which want different endings. See allCalled().
  var sawItRunning = false;

  function render(force){
    if (!state) return;
    var key = state.game.status;
    if (key === 'running') sawItRunning = true;
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
    ticketHtml() + calledHtml() +
    '<div class="exitrow"><button class="exitbtn" id="exitBtn">Exit game</button></div>';

    setView(html, 'game');
    wireExit();
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
    // Who took the Full House - from the results, so a reload still shows it.
    var winner = (r.prizes.filter(function(p){ return p.key === 'full_house'; })[0] || {}).winner
      || (lastWinner && lastWinner.winner) || null;

    // The plain sentence. It names the player who ended it, because "Full
    // House! That is game." tells someone who looked away for ten seconds
    // nothing at all about what they missed.
    var reason;
    if (fullHouse) {
      reason = winner
        ? (state.you && winner === state.you.name
            ? '<b>You</b> completed a full ticket. That is Full House, and the game ends here.'
            : '<b>' + esc(winner) + '</b> completed a full ticket. That is Full House, and the game ends here.')
        : 'Someone completed a full ticket. That is Full House, and the game ends here.';
    } else if (abandoned) {
      reason = (lastWinner && lastWinner.leaver)
        ? '<b>' + esc(lastWinner.leaver) + '</b> left, which left too few players to carry on.'
        : 'Too few players were left to carry on.';
    } else {
      reason = 'All <b>90 numbers</b> have been called. Nobody completed a full ticket.';
    }

    var champ = winner;
    var youWon = champ && state.you && champ === state.you.name;

    // The banner leads, so the reason is read before anything else. Whether it
    // also counts down to WhatsApp is decided further down.
    var html = '<div class="ended overview-in">' +
      '<div class="label">Game over</div>' +
      '<div class="why">' + reason + '</div>' +
      '<div class="ret" id="retStrip" hidden></div>' +
    '</div>';
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

    html += '<div class="card"><h2>Prizes</h2>' +
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

    // Offer the trip back to WhatsApp only to a player who was actually here
    // when the numbers ran out. Someone opening this board later - from an old
    // message, or the "See my report" link - came deliberately to READ the
    // results, and bouncing them out would be the opposite of what they asked
    // for.
    if (!fullHouse && !abandoned && sawItRunning) offerReturn();
  }

  /**
   * Counts down to WhatsApp, inside the game-over banner.
   *
   * This used to be a full-screen overlay and it was the wrong shape for the
   * moment. The game ending is not an interruption to be acknowledged - it is
   * the thing the player has been waiting twenty minutes for. Covering the
   * board with a modal the instant the last number lands reads as an error
   * dialog: it arrives unannounced, hides what they were looking at, and has
   * to be dismissed before they can see their own results.
   *
   * So the countdown lives in the banner instead. Nothing is covered, nothing
   * has to be dismissed, and a player who wants to sit and read their report
   * taps "Stay here" once. Runs at most once per page - a reconnect or a
   * visibility resync must not restart it under someone mid-read.
   */
  var returnOffered = false;
  function offerReturn(){
    if (returnOffered) return;
    returnOffered = true;

    var strip = document.getElementById('retStrip');
    if (!strip) return;

    var secs = 8;
    strip.hidden = false;
    strip.innerHTML =
      '<span class="n" id="retN">' + secs + '</span>' +
      '<span>Taking you back to WhatsApp, where your report is waiting.</span>' +
      '<button class="stay" id="retStay">Stay here</button>';

    var timer = null;
    var stop = function(){
      if (timer) clearInterval(timer);
      timer = null;
      strip.hidden = true;
    };

    document.getElementById('retStay').onclick = stop;

    timer = setInterval(function(){
      secs--;
      var n = document.getElementById('retN');
      if (n) n.textContent = Math.max(0, secs);
      if (secs > 0) return;

      stop();
      var number = state.businessNumber || '';
      // With no business number configured there is nowhere to send them, so
      // the results simply stay on screen rather than a broken wa.me link.
      if (number) location.href = 'https://wa.me/' + number;
    }, 1000);
  }

  // ---- leaving ----

  /**
   * Wires the Exit button. Re-run on every game render, because setView
   * replaces the node and an old handler would point at a detached element.
   */
  function wireExit(){
    var b = document.getElementById('exitBtn');
    if (b) b.onclick = askToLeave;
  }

  /**
   * Asks before doing something with no undo.
   *
   * The warning names all three consequences, because each one surprises
   * somebody: the ticket is forfeited, the game cannot be rejoined, and - the
   * one nobody expects - leaving can end the game for everybody else if it
   * drops the table below two players. Someone who would not have left had
   * they known that deserves to know it here.
   */
  function askToLeave(){
    if (document.getElementById('leaveask')) return;

    var others = Math.max(0, (state.players ? state.players.length : 1) - 1);
    var wouldEnd = others < 2;

    var el = document.createElement('div');
    el.id = 'leaveask';
    el.innerHTML =
      '<div class="box" role="dialog" aria-modal="true">' +
        '<h3>Leave this game?</h3>' +
        '<p>Your ticket is forfeited and any prizes still to come are out of reach.</p>' +
        '<div class="warn">' +
          '<b>You cannot rejoin.</b> This game is closed to you once you leave, ' +
          'even if you still have the link.' +
          (wouldEnd
            ? '<br><br>You are one of the last players. Leaving now <b>ends the game ' +
              'for everyone still playing</b>.'
            : '') +
        '</div>' +
        '<div class="row">' +
          '<button class="stay" id="leaveNo">Keep playing</button>' +
          '<button class="go" id="leaveYes">Leave</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    var close = function(){ if (el.parentNode) el.parentNode.removeChild(el); };
    document.getElementById('leaveNo').onclick = close;

    // A tap outside the box is a "no". A tap inside must not be.
    el.onclick = function(ev){ if (ev.target === el) close(); };

    document.getElementById('leaveYes').onclick = function(){
      var go = document.getElementById('leaveYes');
      go.disabled = true; go.textContent = 'Leaving…';
      post('/leave', {}).then(function(r){
        close();
        if (r.status !== 200) { toast((r.body && r.body.error) || 'Could not leave'); return; }
        leftTheGame(r.body);
      });
    };
  }

  /**
   * What this player sees after walking out.
   *
   * The stream is closed first. Without that the board would keep receiving
   * draws for a game this player is no longer in and paint them over this
   * screen - and the server would go on holding a connection for a seat that
   * no longer exists.
   */
  function leftTheGame(result){
    if (es) { es.close(); es = null; }
    if (tick) clearInterval(tick);
    hideCountdown();
    claimbar.classList.add('hidden');
    setConn('off', 'you left this game');

    var number = state.businessNumber || '';
    setView(
      '<div class="card" style="text-align:center">' +
        '<div style="font-size:38px;line-height:1;margin-bottom:6px">👋</div>' +
        '<h2>You have left the game</h2>' +
        '<div class="muted">' +
          (result && result.aborted
            ? 'You were one of the last players, so the game has ended for everyone.'
            : 'The others are still playing. This game cannot be rejoined.') +
        '</div>' +
        (number
          ? '<a class="btn" style="display:block;margin-top:14px;text-decoration:none" ' +
            'href="https://wa.me/' + number + '">Back to WhatsApp</a>'
          : '') +
        '<div class="muted" style="font-size:13px;margin-top:12px">' +
          'It is on your record either way - your report and your play history ' +
          'both show the numbers called up to the moment you left.' +
        '</div>' +
      '</div>',
      'left',
    );
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

  /**
   * Paints only what the player has already decided.
   *
   * Deliberately says nothing about the number being called. Ringing the cell
   * that matches the current draw would hand the player the answer before they
   * press anything, which is the entire skill of tambola - finding your own
   * number before the caller moves on. Marks appear only after the answer is
   * given, and a wrong answer is never corrected mid-game.
   */
  function updateTicket(){
    var marked = state.marked || [];
    document.querySelectorAll('.ticket td[data-n]').forEach(function(td){
      var n = Number(td.dataset.n);
      td.classList.toggle('marked', marked.indexOf(n) >= 0);
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

    // Breathe only while an answer is actually wanted. Left running after the
    // tap it would be pulsing at somebody who has already decided.
    var row = yes.parentNode;
    if (row) row.classList.toggle('awaiting', Boolean(cur) && !given);

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

    // Before they answer, the strip holds the question rather than sitting
    // empty. Reserving the height stops the board moving, but a blank box in
    // the middle of the screen reads as something failing to load - and this
    // is the one place a prompt belongs, directly under the two buttons.
    //
    // It restates the number and nothing else. It cannot hint: whether that
    // number is on the ticket is exactly what the player is there to work out.
    if (!state.current) {
      // No number on the board yet: hold the space, say nothing.
      box.innerHTML = '<div class="waiting blank"><span>&nbsp;</span></div>';
      return;
    }
    if (!mine) {
      box.innerHTML = '<div class="waiting"><span>Look for <b>' +
        state.current.value + '</b> on your ticket</span></div>';
      return;
    }

    var others = Math.max(0, p.total - p.answered);
    // No countdown here. The ring on the called number is the timer, and a
    // second one at the bottom of the screen made the player's eyes travel
    // between two clocks counting the same seconds.
    box.innerHTML = '<div class="waiting">' +
      (others > 0 ? '<span class="spin"></span>' : '<span>✓</span>') +
      '<span>' + (others > 0
        ? 'Waiting for <b>' + others + '</b> more player' + (others === 1 ? '' : 's') + '…'
        : 'Everyone has answered - next number coming up') + '</span>' +
    '</div>';
  }

  function answer(a){
    var cur = state.current; if (!cur) return;
    answeredSeq = cur.seq;
    var yes = document.getElementById('yes'), no = document.getElementById('no');
    yes.disabled = no.disabled = true;
    if (yes.parentNode) yes.parentNode.classList.remove('awaiting');
    (a === 'yes' ? yes : no).classList.add('on');

    // Played on the tap, not on the server's reply. The sound is feedback that
    // the tap registered; waiting for the round trip would put it a variable
    // fraction of a second late, which reads as lag rather than confirmation.
    if (a === 'yes') soundMark(); else soundPass();

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
      updateTicket(); paintWaiting();

      // Only "I have it" unlocks the hint. Saying a number is not yours cannot
      // be what completes a line, so it earns nothing.
      refreshClaims();
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
    tick = setInterval(function(){
      left = Math.max(0, left - 1);
      paint();

      // The last five seconds are audible.
      //
      // Only for a player who has not answered yet: once they have marked the
      // number, the countdown is no longer about them, and ticking at somebody
      // who is simply waiting for the next call is nagging rather than urgency.
      var answered = state.yourAnswer || (state.current && answeredSeq === state.current.seq);
      if (!answered && left > 0 && left <= 5) soundUrgent(left);
    }, 1000);
    function paint(){
      var ring = document.getElementById('ring'), t = document.getElementById('ringT');
      if (!ring) return;
      ring.setAttribute('stroke-dashoffset', String(94.2 * (1 - Math.max(0, left) / total)));
      t.textContent = left > 0 ? left : '';

    }
  }

  // ---- claims ----
  function renderClaims(){
    if (!state.prizes) return;
    claimrow.innerHTML = state.prizes.map(function(p){
      // No 'able' state at all - see the note in the stylesheet. The button
      // looks the same whether or not the prize is available, so the board
      // never does the player's looking for them.
      var cls = p.awarded ? (p.awarded.isYou ? 'mine' : 'gone') : '';
      // The label never changes width. Appending the winner's name grew the
      // button and shifted the others sideways mid-game, which moved a target
      // out from under a thumb that was already reaching for it.
      var title = p.awarded ? p.label + ' - won by ' + p.awarded.winner : p.label;
      return '<button data-k="' + p.key + '" class="' + cls + '"' +
        ' title="' + esc(title) + '"' +
        (p.awarded ? ' disabled' : '') + '>' + esc(p.label) + '</button>';
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
