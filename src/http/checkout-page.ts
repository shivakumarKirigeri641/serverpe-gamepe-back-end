import { apiPath, env } from '../config/env.js';
import { INDIAN_STATES } from '../services/gst.service.js';

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
  /** Masked: the page is a link that can be forwarded. */
  maskedNumber: string;
  players: number;
  bandLabel: string;
  options: CheckoutOption[];
  policiesUrl: string | null;
  confirmPath: string;
  /** Supplier details, for the invoice the payment will produce. */
  business: {
    legalName: string;
    gstin: string | null;
    state: string | null;
    stateCode: string | null;
  };
  /** Pre-selected when we can guess it; the payer confirms either way. */
  defaultStateCode: string | null;
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
    view.options.map((o) => [
      o.planKey,
      {
        orderId: o.orderId,
        amount: o.amountPaise,
        base: o.basePaise,
        gst: o.gstPaise,
        label: o.label,
      },
    ]),
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

  .opts { padding: 0; }
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

  .block { padding: 14px 20px 4px; border-top: 1px solid #f0f2f6; }
  .block:first-of-type { border-top: 0; }
  .blocktitle { font-size: 11px; font-weight: 800; text-transform: uppercase;
                letter-spacing: .07em; color: ${COLOR.muted}; margin-bottom: 9px; }
  .req { background: #fdeaea; color: #b3122b; font-size: 9px; padding: 1px 6px;
         border-radius: 999px; margin-left: 6px; letter-spacing: .04em; }
  .kv { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; padding: 3px 0; }
  .kv span { color: ${COLOR.muted}; }
  .sel { width: 100%; padding: 12px 11px; border: 2px solid #e6eaf0; border-radius: 12px;
         font: inherit; font-size: 15px; background: #fff; color: ${COLOR.ink}; }
  .sel:focus { outline: none; border-color: ${COLOR.maroon}; }
  .hint { color: ${COLOR.muted}; font-size: 12px; margin: 7px 0 0; line-height: 1.5; }

  table.brk { width: 100%; border-collapse: collapse; }
  table.brk td { padding: 5px 0; font-size: 14px; }
  table.brk td.v { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  table.brk td.k { color: ${COLOR.muted}; }
  table.brk tr.total td { border-top: 1px solid #e6eaf0; padding-top: 10px;
                          font-weight: 800; font-size: 16.5px; }
  table.brk tr.hidden { display: none; }

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
  .donebox { padding: 30px 24px 26px; text-align: center; }
  .doneemoji { font-size: 46px; }
  .donebox h2 { font-size: 19px; margin: 10px 0 6px; color: ${COLOR.green}; }
  .donebox p { color: ${COLOR.muted}; font-size: 14px; line-height: 1.6; margin: 0; }
  .doneback { display: block; margin-top: 20px; padding: 15px; border-radius: 13px;
              background: ${COLOR.green}; color: #fff; text-decoration: none;
              font-weight: 700; font-size: 16px; }
  .donehint { font-size: 12px !important; margin-top: 12px !important; }

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

  <!-- Who is buying, and what for. Shown because a payment page that does not
       say whose room this is invites the question at the worst moment. -->
  <div class="block">
    <div class="blocktitle">Your details</div>
    <div class="kv"><span>Name</span><b>${escapeHtml(view.playerName)}</b></div>
    <div class="kv"><span>WhatsApp</span><b>${escapeHtml(view.maskedNumber)}</b></div>
    <div class="kv"><span>Room size</span><b>${view.players} player${view.players === 1 ? '' : 's'}</b></div>
    <div class="kv"><span>Price band</span><b>${escapeHtml(view.bandLabel)}</b></div>
  </div>

  <div class="block">
    <div class="blocktitle">Choose your plan</div>
    <div class="opts">${optionHtml}</div>
  </div>

  <!-- Place of supply. Same state is CGST + SGST, other state is IGST; the
       total is identical, so this is invisible to the payer and unforgiving on
       the GST return. Asked once, here, rather than guessed. -->
  <div class="block">
    <div class="blocktitle">Billing state <span class="req">required</span></div>
    <select id="state" class="sel">
      <option value="">Select your state or union territory…</option>
      ${INDIAN_STATES.map(
        (st) =>
          `<option value="${st.code}"${st.code === view.defaultStateCode ? ' selected' : ''}>${escapeHtml(st.name)}</option>`,
      ).join('')}
    </select>
    <p class="hint">Needed for a valid GST invoice. It does not change what you pay.</p>
  </div>

  <div class="block">
    <div class="blocktitle">Amount breakup</div>
    <table class="brk">
      <tr><td class="k" id="brkPlan">Plan</td><td class="v" id="brkBase">—</td></tr>
      <tr id="rowCgst"><td class="k">CGST @ ${(view.gstPercent / 2).toFixed(1)}%</td><td class="v" id="brkCgst">—</td></tr>
      <tr id="rowSgst"><td class="k">SGST @ ${(view.gstPercent / 2).toFixed(1)}%</td><td class="v" id="brkSgst">—</td></tr>
      <tr id="rowIgst"><td class="k">IGST @ ${view.gstPercent}%</td><td class="v" id="brkIgst">—</td></tr>
      <tr class="total"><td>Total payable</td><td class="v" id="brkTotal">—</td></tr>
    </table>
    <p class="hint" id="supplier">
      Supplied by ${escapeHtml(view.business.legalName)}${
        view.business.state ? `, ${escapeHtml(view.business.state)}` : ''
      }${view.business.gstin ? ` &middot; GSTIN ${escapeHtml(view.business.gstin)}` : ''}
    </p>
  </div>

  <label class="agree">
    <input type="checkbox" id="agree">
    <span>I agree to the ${
      view.policiesUrl
        ? `<a href="${escapeHtml(view.policiesUrl)}" target="_blank" rel="noopener">terms, payment and refund policies</a>`
        : 'terms, payment and refund policies'
    }. This is a game played for entertainment only — no betting, and no money to be won.</span>
  </label>

  <button class="pay" id="pay" disabled>Pay now</button>
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
  var SUPPLIER_STATE = ${JSON.stringify(view.business.stateCode)};
  var GST_PCT = ${view.gstPercent};
  var selected = ${JSON.stringify(selected?.planKey ?? '')};
  var busy = false;

  var stateEl = document.getElementById('state');
  var rowCgst = document.getElementById('rowCgst');
  var rowSgst = document.getElementById('rowSgst');
  var rowIgst = document.getElementById('rowIgst');

  function money(p) { return '₹' + (p / 100).toFixed(2); }

  /**
   * Redraws the breakup for the chosen plan and state.
   *
   * The total never changes with the state — only which tax lines it is split
   * across. Showing both makes that visible, so a payer picking their state
   * does not wonder whether it moved the price.
   */
  function breakup() {
    var o = ORDERS[selected];
    if (!o) return;

    var intra = SUPPLIER_STATE && stateEl.value && stateEl.value === SUPPLIER_STATE;
    var tax = o.gst;

    document.getElementById('brkPlan').textContent = o.label;
    document.getElementById('brkBase').textContent = money(o.base);
    document.getElementById('brkTotal').textContent = money(o.amount);

    if (intra) {
      var sgst = Math.floor(tax / 2);
      document.getElementById('brkCgst').textContent = money(tax - sgst);
      document.getElementById('brkSgst').textContent = money(sgst);
      rowCgst.classList.remove('hidden');
      rowSgst.classList.remove('hidden');
      rowIgst.classList.add('hidden');
    } else {
      document.getElementById('brkIgst').textContent = money(tax);
      rowIgst.classList.remove('hidden');
      rowCgst.classList.add('hidden');
      rowSgst.classList.add('hidden');
    }
  }

  function refresh() {
    var o = ORDERS[selected];
    payBtn.textContent = 'Pay ' + money(o ? o.amount : 0);
    // Three things must be true: a plan, a state for the invoice, and an
    // explicit agreement. Pay stays locked until all three are.
    payBtn.disabled = !agree.checked || !stateEl.value || busy;
    breakup();
  }

  function say(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status show ' + (cls || '');
  }

  /**
   * The screen after a successful payment.
   *
   * Replaces the form entirely and carries its own way back. A redirect out of
   * an in-app browser is not something a web page can rely on — WhatsApp's own
   * viewer often refuses it — and the payer was being told they were being
   * taken somewhere, and then was not. The button always works; the automatic
   * attempt is a convenience on top of it.
   */
  function done(url) {
    document.querySelector('.card').innerHTML =
      '<div class="donebox">' +
        '<div class="doneemoji">\u2705</div>' +
        '<h2>Payment received</h2>' +
        '<p>Your credits have been added, and your tax invoice has been sent to you on WhatsApp.</p>' +
        '<a class="doneback" href="' + url + '">Back to WhatsApp</a>' +
        '<p class="donehint">If nothing opens, switch back to WhatsApp yourself \u2014 your confirmation is already there.</p>' +
      '</div>';
    setTimeout(function () { try { window.location.href = url; } catch (e) {} }, 1200);
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
  stateEl.addEventListener('change', refresh);

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
          body: JSON.stringify(Object.assign({}, resp, { stateCode: stateEl.value }))
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
