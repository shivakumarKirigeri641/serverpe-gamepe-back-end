import { apiPath, env } from '../config/env.js';

/**
 * The payment page.
 *
 * WhatsApp cannot render a payment form, so paying happens on a web page the
 * host opens from chat — the same pattern as the game board, reachable only
 * through a signed link.
 *
 * Razorpay's own Checkout widget handles the card. Card details never touch
 * this server, which is the entire reason for using their widget rather than
 * collecting anything ourselves: what we never receive, we cannot leak.
 *
 * Both plan options are shown together rather than one per page. At most room
 * sizes the day pass is a small step up for unlimited games, and that
 * comparison is the sell — putting it behind another tap loses it.
 */

const COLOR = {
  maroon: '#7d0f22',
  maroonDark: '#5c0a19',
  gold: '#f0a202',
  green: '#1f9d55',
  ink: '#1e2733',
  muted: '#6b7684',
  bg: '#f6f3ef',
};

export interface CheckoutOption {
  planKey: string;
  label: string;
  sublabel: string;
  /** Razorpay order for this option. Each option has its own. */
  orderId: string;
  amountPaise: number;
  basePaise: number;
  gstPaise: number;
  selected: boolean;
  /** e.g. "Save 32%" — omitted when there is nothing worth claiming. */
  badge?: string;
}

export interface CheckoutView {
  token: string;
  keyId: string;
  gstPercent: number;
  playerName: string;
  players: number;
  bandLabel: string;
  options: CheckoutOption[];
  policiesUrl: string | null;
  confirmPath: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const rupees = (paise: number): string => (paise / 100).toFixed(2);

function returnUrl(): string {
  return env.WHATSAPP_BUSINESS_NUMBER
    ? `https://wa.me/${env.WHATSAPP_BUSINESS_NUMBER.replace(/[^0-9]/g, '')}`
    : '#';
}

/** Shown when an order is already paid, expired, or cannot be opened. */
export function renderCheckoutClosed(message: string, detail = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(env.BRAND_NAME)} — Payment</title>
<link rel="icon" type="image/png" sizes="32x32" href="${apiPath('/public/brand/images/favicon-32.png')}">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         background: ${COLOR.bg}; color: ${COLOR.ink}; margin: 0; padding: 40px 18px;
         display: grid; place-items: center; min-height: 100vh; }
  .card { background: #fff; border-radius: 18px; padding: 32px 26px; max-width: 380px; width: 100%;
          text-align: center; box-shadow: 0 2px 14px rgba(20,25,35,.09); }
  h1 { font-size: 20px; margin: 14px 0 6px; color: ${COLOR.maroon}; }
  p { color: ${COLOR.muted}; font-size: 14.5px; line-height: 1.6; margin: 0; }
  .big { font-size: 42px; }
  a { display: block; margin-top: 22px; padding: 13px; border-radius: 12px;
      background: ${COLOR.green}; color: #fff; text-decoration: none; font-weight: 700; }
</style></head>
<body><div class="card">
  <div class="big">✅</div>
  <h1>${escapeHtml(message)}</h1>
  ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
  <a href="${returnUrl()}">Back to WhatsApp</a>
</div></body></html>`;
}

export function renderCheckoutPage(view: CheckoutView): string {
  const wa = returnUrl();
  const selected = view.options.find((o) => o.selected) ?? view.options[0];

  const optionHtml = view.options
    .map(
      (o) => `
      <label class="opt${o.selected ? ' on' : ''}" data-plan="${escapeHtml(o.planKey)}">
        <input type="radio" name="plan" value="${escapeHtml(o.planKey)}"${o.selected ? ' checked' : ''}>
        <span class="body">
          <span class="row1">
            <span class="label">${escapeHtml(o.label)}</span>
            <span class="price">₹${rupees(o.amountPaise)}</span>
          </span>
          <span class="row2">
            <span class="sub">${escapeHtml(o.sublabel)}</span>
            ${o.badge ? `<span class="badge">${escapeHtml(o.badge)}</span>` : ''}
          </span>
          <span class="split">Includes ₹${rupees(o.gstPaise)} GST (${view.gstPercent}%) &middot; base ₹${rupees(o.basePaise)}</span>
        </span>
      </label>`,
    )
    .join('');

  const orders = Object.fromEntries(
    view.options.map((o) => [o.planKey, { orderId: o.orderId, amount: o.amountPaise }]),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(env.BRAND_NAME)} — Review &amp; Pay</title>
<link rel="icon" type="image/png" sizes="32x32" href="${apiPath('/public/brand/images/favicon-32.png')}">
<meta name="theme-color" content="${COLOR.maroon}">
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
         background: ${COLOR.bg}; color: ${COLOR.ink}; padding: 16px 14px 40px;
         max-width: 440px; margin: 0 auto; font-size: 16px; line-height: 1.5; }
  .card { background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 2px 12px rgba(20,25,35,.08); }
  .bar { background: linear-gradient(135deg, ${COLOR.maroon}, ${COLOR.maroonDark}); color: #fff; padding: 17px 20px; }
  .bar strong { font-size: 19px; }
  .bar div { font-size: 13px; opacity: .88; margin-top: 3px; }

  .who { padding: 15px 20px 6px; font-size: 14px; color: ${COLOR.muted}; margin: 0; }
  .who b { color: ${COLOR.ink}; }

  .opts { padding: 6px 14px 4px; }
  .opt { display: flex; gap: 11px; align-items: flex-start; padding: 13px 12px; margin-bottom: 9px;
         border: 2px solid #e6eaf0; border-radius: 14px; cursor: pointer;
         transition: border-color .15s, background .15s; }
  .opt.on { border-color: ${COLOR.maroon}; background: #fdf7f8; }
  .opt input { margin: 3px 0 0; accent-color: ${COLOR.maroon}; width: 18px; height: 18px; flex: 0 0 auto; }
  .opt .body { flex: 1; min-width: 0; }
  .row1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .label { font-weight: 700; font-size: 15.5px; }
  .price { font-weight: 800; font-size: 19px; color: ${COLOR.maroon}; font-variant-numeric: tabular-nums; }
  .row2 { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px; }
  .sub { color: ${COLOR.muted}; font-size: 13px; }
  .badge { background: ${COLOR.green}; color: #fff; font-size: 11px; font-weight: 800;
           padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .split { display: block; color: ${COLOR.muted}; font-size: 11.5px; margin-top: 5px; }

  .agree { display: flex; gap: 10px; align-items: flex-start; padding: 8px 20px 4px;
           font-size: 13.5px; color: ${COLOR.muted}; cursor: pointer; }
  .agree input { margin: 2px 0 0; accent-color: ${COLOR.maroon}; width: 17px; height: 17px; flex: 0 0 auto; }
  .agree a { color: ${COLOR.maroon}; font-weight: 600; }

  .pay { display: block; width: calc(100% - 40px); margin: 14px 20px 8px; padding: 15px; border: 0;
         border-radius: 13px; background: ${COLOR.green}; color: #fff; font: inherit;
         font-weight: 700; font-size: 16.5px; cursor: pointer; }
  .pay:active { transform: translateY(1px); }
  .pay:disabled { opacity: .45; cursor: default; }

  .note { color: ${COLOR.muted}; font-size: 12px; text-align: center; padding: 0 22px 20px; line-height: 1.6; }
  .status { display: none; text-align: center; padding: 4px 20px 18px; font-size: 14.5px; }
  .status.show { display: block; }
  .status.ok { color: ${COLOR.green}; font-weight: 700; }
  .status.bad { color: #b3122b; font-weight: 700; }
  .back { display: block; text-align: center; margin-top: 13px; padding: 13px; border-radius: 12px;
          background: #fff; border: 1px solid #e2e7ee; color: ${COLOR.maroon};
          text-decoration: none; font-weight: 700; }
  .safe { text-align: center; color: ${COLOR.muted}; font-size: 11.5px; margin-top: 14px; }
</style>
</head>
<body>

<div class="card">
  <div class="bar">
    <strong>${escapeHtml(env.BRAND_NAME)}</strong>
    <div>Review &amp; pay</div>
  </div>

  <p class="who">Room for <b>${view.players} player${view.players === 1 ? '' : 's'}</b> &middot;
     ${escapeHtml(view.bandLabel)} &middot; <b>${escapeHtml(view.playerName)}</b></p>

  <div class="opts">${optionHtml}</div>

  <label class="agree">
    <input type="checkbox" id="agree">
    <span>I agree to the ${
      view.policiesUrl
        ? `<a href="${escapeHtml(view.policiesUrl)}" target="_blank" rel="noopener">terms, payment and refund policies</a>`
        : 'terms, payment and refund policies'
    }. This is a game played for entertainment only — no betting, and no money to be won.</span>
  </label>

  <button class="pay" id="pay" disabled>Pay ₹${rupees(selected?.amountPaise ?? 0)}</button>
  <div class="status" id="status"></div>

  <p class="note">Payment is handled by Razorpay. Your card details are never sent to ${escapeHtml(env.BRAND_NAME)}.</p>
</div>

<a class="back" href="${wa}">Back to WhatsApp</a>
<p class="safe">${escapeHtml(env.BRAND_NAME)} by ServerPe App Solutions &middot; For entertainment only</p>

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
(function () {
  var payBtn = document.getElementById('pay');
  var agree = document.getElementById('agree');
  var statusEl = document.getElementById('status');
  var opts = [].slice.call(document.querySelectorAll('.opt'));

  var ORDERS = ${JSON.stringify(orders)};
  var CONFIRM = ${JSON.stringify(view.confirmPath)};
  var RETURN = ${JSON.stringify(wa)};
  var BRAND = ${JSON.stringify(env.BRAND_NAME)};
  var KEY = ${JSON.stringify(view.keyId)};
  var selected = ${JSON.stringify(selected?.planKey ?? '')};
  var busy = false;

  function money(p) { return (p / 100).toFixed(2); }

  function refresh() {
    payBtn.textContent = 'Pay \\u20B9' + money(ORDERS[selected].amount);
    // Locked until the box is ticked: agreeing must be an action, not something
    // implied by pressing Pay.
    payBtn.disabled = !agree.checked || busy;
  }

  function say(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status show ' + (cls || '');
  }

  opts.forEach(function (el) {
    el.addEventListener('click', function () {
      if (busy) return;
      selected = el.getAttribute('data-plan');
      opts.forEach(function (o) { o.classList.toggle('on', o === el); });
      el.querySelector('input').checked = true;
      refresh();
    });
  });

  agree.addEventListener('change', refresh);

  payBtn.addEventListener('click', function () {
    busy = true; refresh();
    say('Opening payment\\u2026');

    var rzp = new Razorpay({
      key: KEY,
      order_id: ORDERS[selected].orderId,
      amount: ORDERS[selected].amount,
      currency: 'INR',
      name: BRAND,
      description: 'MastiPe room',
      theme: { color: ${JSON.stringify(COLOR.maroon)} },

      // Razorpay signs these three values with the key secret. The server
      // verifies that signature before crediting, so a response fabricated in
      // the console is rejected rather than trusted.
      handler: function (resp) {
        say('Confirming\\u2026');
        fetch(CONFIRM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resp)
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j.ok) { busy = false; refresh(); say(j.error || 'Could not confirm the payment.', 'bad'); return; }
            say('Paid. Taking you back to WhatsApp\\u2026', 'ok');
            payBtn.style.display = 'none';
            setTimeout(function () { window.location.href = j.returnUrl || RETURN; }, 1400);
          })
          .catch(function () {
            // The money is taken and only our confirmation failed. Say that
            // honestly rather than implying the payment did not happen.
            busy = false; refresh();
            say('Payment went through, but we could not confirm it here. Go back to WhatsApp \\u2014 your room link will arrive shortly.', 'bad');
          });
      },

      modal: {
        ondismiss: function () { busy = false; refresh(); say('Cancelled. Nothing was charged.', ''); }
      }
    });

    rzp.on('payment.failed', function (resp) {
      busy = false; refresh();
      say((resp && resp.error && resp.error.description) || 'Payment failed. Nothing was charged.', 'bad');
    });

    rzp.open();
  });

  refresh();
})();
</script>
</body>
</html>`;
}
