/**
 * The page the consent message links to.
 *
 * Deliberately plain and self-contained - it is opened inside WhatsApp's
 * in-app browser, often on a slow connection, and must render instantly with
 * no external assets.
 */
import { config } from '../config/env.js';
import { POLICY_VERSION } from '../services/player.service.js';

export function policiesPage() {
  const brand = escapeHtml(config.brandName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} - Terms &amp; Privacy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 24px 20px 64px;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 640px; margin-inline: auto;
    background: #fdfcfa; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16151a; color: #e8e6e3; }
    h1, h2 { color: #f0c060; }
    code { background: #2a2830; }
  }
  h1 { font-size: 1.5rem; margin: 0 0 4px; color: #8b1e3f; }
  h2 { font-size: 1.05rem; margin: 28px 0 6px; color: #8b1e3f; }
  .meta { font-size: .85rem; opacity: .65; margin-bottom: 24px; }
  ul { padding-left: 20px; }
  li { margin: 6px 0; }
  code { background: #eee9e1; padding: 1px 5px; border-radius: 4px; font-size: .9em; }
  footer { margin-top: 40px; font-size: .85rem; opacity: .6; }
</style>
</head>
<body>
<h1>${brand} - Terms, Privacy &amp; Fair Play</h1>
<div class="meta">Policy version <code>${escapeHtml(POLICY_VERSION)}</code></div>

<h2>Who can play</h2>
<ul>
  <li>${brand} is entertainment only. There is no real-money gambling, no betting and no cash prizes.</li>
</ul>

<h2>What we store, and why</h2>
<ul>
  <li>Your WhatsApp number - it is how we know which ticket is yours.</li>
  <li>Your tickets, the numbers called, your taps and your prize claims - so a game can be replayed if a result is ever disputed.</li>
  <li>Your WhatsApp profile name, if you have one set, so other players see a name instead of a number.</li>
  <li>When you open your game board in a browser: your IP address, your device type, and your
      operating system and browser. We use this to keep games fair and to work out why a board
      dropped out mid-game. WhatsApp messages themselves carry no address or device.</li>
</ul>

<h2>What we do not do</h2>
<ul>
  <li>We do not sell or share your data.</li>
  <li>We do not message you outside a game you joined.</li>
  <li>We never show your full number to other players - only a short display name.</li>
</ul>

<h2>Fair play</h2>
<ul>
  <li>Prizes are validated against the numbers actually called, and each prize can be won only once.</li>
  <li>Cheating, abuse or harassment means removal from the platform.</li>
  <li>The host starts the game; after that ${brand} runs it, and the host plays as an ordinary player.</li>
</ul>

<h2>Deleting your data</h2>
<p>Message <em>delete my data</em> on WhatsApp and we will remove your account and history.</p>

<footer>${brand} &middot; questions? Reply on WhatsApp and we will get back to you.</footer>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
