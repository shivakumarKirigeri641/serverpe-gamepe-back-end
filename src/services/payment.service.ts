import { createHmac, timingSafeEqual } from 'node:crypto';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { postLedgerEntry } from './wallet.service.js';
import { notify } from './notification.service.js';


/**
 * Razorpay payments.
 *
 * Built now, switched off until there are prices to charge: PAYMENTS_ENABLED
 * gates order creation, and nothing about payment is shown to a player while it
 * is false. The webhook stays reachable regardless, because Razorpay retries a
 * callback for hours and one arriving just after the flag is flipped must be
 * verifiable rather than 404.
 *
 * No SDK. Razorpay's REST API is two endpoints and an HMAC, and a dependency
 * that sits in the path of taking money is a dependency whose next release has
 * to be reviewed line by line. `fetch` and `node:crypto` are enough.
 */

const RAZORPAY_API = 'https://api.razorpay.com/v1';

export class PaymentError extends Error {}

function authHeader(): string {
  const pair = `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

export function paymentsConfigured(): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

export function paymentsLive(): boolean {
  return env.PAYMENTS_ENABLED && paymentsConfigured();
}

/**
 * Splits a gross amount into base and GST.
 *
 * Which way round depends on GST_INCLUSIVE: a ₹49 plan is either ₹49 total with
 * ₹7.47 of tax inside it, or ₹49 plus ₹8.82 charged on top. Getting this
 * backwards misstates every invoice and the GST return built from them, so the
 * split is computed once here and stored on the row rather than recalculated
 * wherever an invoice happens to be printed.
 */
export function splitGst(grossPaise: number): { basePaise: number; gstPaise: number; totalPaise: number } {
  const rate = env.GST_PERCENT / 100;

  if (env.GST_INCLUSIVE) {
    const base = Math.round(grossPaise / (1 + rate));
    return { basePaise: base, gstPaise: grossPaise - base, totalPaise: grossPaise };
  }

  const gst = Math.round(grossPaise * rate);
  return { basePaise: grossPaise, gstPaise: gst, totalPaise: grossPaise + gst };
}

export interface CreateOrderInput {
  playerId: string;
  waId: string;
  /** What the player is buying. Null for an open-ended top-up. */
  planKey?: string | null;
  /** Price before any GST decision, in paise. */
  amountPaise: number;
  /** Credits to grant when it is paid. Defaults to the amount charged. */
  creditsPaise?: number;
  notes?: Record<string, string>;
}

export interface CreatedOrder {
  id: string;
  orderId: string;
  amountPaise: number;
  basePaise: number;
  gstPaise: number;
  currency: string;
  keyId: string;
}

/**
 * Creates a Razorpay order and records it.
 *
 * The order is written to our database before the player is sent anywhere, so a
 * payment can never arrive for an order we have no record of — the webhook
 * would then have nobody to credit and no way to tell a real payment from a
 * forged one.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  if (!paymentsLive()) {
    throw new PaymentError('Payments are not enabled.');
  }
  if (input.amountPaise < 100) {
    throw new PaymentError('Amount must be at least ₹1.');
  }

  const { basePaise, gstPaise, totalPaise } = splitGst(input.amountPaise);

  const res = await fetch(`${RAZORPAY_API}/orders`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: totalPaise,
      currency: 'INR',
      // Never the phone number: Razorpay's dashboard is another surface where a
      // player's number should not appear.
      receipt: `mp_${Date.now()}_${input.playerId.slice(0, 8)}`,
      notes: { planKey: input.planKey ?? 'topup', ...(input.notes ?? {}) },
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok || typeof payload['id'] !== 'string') {
    logger.error({ status: res.status, payload }, 'razorpay order creation failed');
    throw new PaymentError('Could not start the payment. Please try again.');
  }

  const orderId = payload['id'];

  const row = await queryOne<{ id: string }>(
    `INSERT INTO payments
       (order_id, player_id, wa_id, plan_key, credits_paise, amount_paise, currency,
        gst_percent, base_paise, gst_paise, status, order_payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'INR', $7, $8, $9, 'created', $10::jsonb)
     RETURNING id`,
    [
      orderId,
      input.playerId,
      input.waId,
      input.planKey ?? null,
      input.creditsPaise ?? totalPaise,
      totalPaise,
      env.GST_PERCENT,
      basePaise,
      gstPaise,
      JSON.stringify(payload),
    ],
  );

  logger.info({ orderId, amount: totalPaise, playerId: input.playerId }, 'razorpay order created');

  return {
    id: row!.id,
    orderId,
    amountPaise: totalPaise,
    basePaise,
    gstPaise,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
  };
}

/**
 * Verifies a webhook signature.
 *
 * HMAC-SHA256 of the exact bytes Razorpay sent, compared in constant time. The
 * raw body matters: re-serialising the parsed JSON changes key order and
 * whitespace, and the signature stops matching for reasons that look like an
 * attack. Same reason the WhatsApp webhook keeps its raw body.
 *
 * A failure here is not a bad request to retry — it is either a
 * misconfiguration or a forgery, and both must be refused rather than acted on.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !env.RAZORPAY_WEBHOOK_SECRET) return false;

  const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }

  // Length must match before timingSafeEqual, which throws on a mismatch.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface RazorpayEntity {
  id?: string;
  order_id?: string;
  method?: string;
  error_description?: string;
  amount?: number;
}

/**
 * Handles a verified webhook.
 *
 * Every event is stored first, acted on second. Razorpay deliberately delivers
 * the same event more than once, and the unique event id turns replay handling
 * into an insert conflict rather than a judgement call.
 *
 * Crediting the wallet is keyed on the Razorpay payment id, so a duplicate
 * `payment.captured` moves the balance exactly once — the same idempotency the
 * ledger already provides, used for the thing it was built for.
 */
export async function handleWebhook(
  eventType: string,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  signatureOk: boolean,
): Promise<{ handled: boolean; note: string }> {
  const entity = (
    (payload['payload'] as Record<string, Record<string, { entity?: RazorpayEntity }>>)?.['payment']
      ?.['entity'] ?? {}
  ) as RazorpayEntity;

  const orderId = entity.order_id ?? null;
  const paymentId = entity.id ?? null;

  const stored = await queryOne<{ id: string }>(
    `INSERT INTO payment_events (event_id, event_type, order_id, payment_id, signature_ok, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING id`,
    [eventId ?? null, eventType, orderId, paymentId, signatureOk, JSON.stringify(payload)],
  );

  if (!stored) {
    return { handled: false, note: 'duplicate event, already recorded' };
  }
  if (!signatureOk) {
    logger.error({ eventType, orderId }, 'razorpay webhook signature invalid — refusing to act');
    return { handled: false, note: 'signature invalid' };
  }
  if (!orderId) {
    return { handled: false, note: 'no order id on event' };
  }

  const note = await withTransaction(async (client) => {
    // Locked so two deliveries of the same event cannot both credit.
    const payment = await queryOne<{
      id: string;
      player_id: string | null;
      credits_paise: number;
      amount_paise: number;
      status: string;
      credited_at: Date | null;
      wa_id: string | null;
    }>(
      `SELECT id, player_id, credits_paise, amount_paise, status, credited_at, wa_id
         FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId],
      client,
    );

    if (!payment) return 'no matching order — ignored';

    if (eventType === 'payment.failed') {
      await query(
        `UPDATE payments
            SET status = 'failed', payment_id = COALESCE($2, payment_id),
                failure_reason = $3, method = COALESCE($4, method),
                payment_payload = $5::jsonb, updated_at = now()
          WHERE id = $1`,
        [payment.id, paymentId, entity.error_description ?? null, entity.method ?? null, JSON.stringify(entity)],
        client,
      );
      return 'marked failed';
    }

    if (eventType !== 'payment.captured' && eventType !== 'order.paid') {
      return `no action for ${eventType}`;
    }

    if (payment.credited_at) return 'already credited';

    await query(
      `UPDATE payments
          SET status = 'paid', payment_id = COALESCE($2, payment_id),
              method = COALESCE($3, method), payment_payload = $4::jsonb,
              paid_at = now(), credited_at = now(), updated_at = now()
        WHERE id = $1`,
      [payment.id, paymentId, entity.method ?? null, JSON.stringify(entity)],
      client,
    );

    if (payment.player_id) {
      await postLedgerEntry(
        {
          playerId: payment.player_id,
          amountPaise: payment.credits_paise,
          kind: 'topup',
          referenceType: 'razorpay',
          referenceId: paymentId ?? orderId,
          // The payment id, so a replayed webhook cannot credit twice even if
          // the row lock above were somehow bypassed.
          idempotencyKey: `razorpay:${paymentId ?? orderId}`,
          note: 'Razorpay top-up',
        },
        client,
      );
    }

    void notify({
      trigger: 'payment.received',
      summary: `₹${(payment.amount_paise / 100).toFixed(2)} received from +${payment.wa_id ?? '?'}`,
      playerId: payment.player_id,
      detail: { orderId, paymentId, amountPaise: payment.amount_paise, creditsPaise: payment.credits_paise },
    });

    return 'credited';
  });

  await query(`UPDATE payment_events SET handled = true, note = $2 WHERE id = $1`, [stored.id, note]);

  logger.info({ eventType, orderId, paymentId, note }, 'razorpay webhook handled');
  return { handled: true, note };
}

/* ------------------------------------------------------------------- admin */

export async function listPayments(limit: number, offset: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT p.id, p.order_id, p.payment_id, p.wa_id, p.plan_key, p.amount_paise,
            p.base_paise, p.gst_paise, p.gst_percent, p.status, p.method,
            p.failure_reason, p.refunded_paise, p.created_at, p.paid_at,
            pl.display_name
       FROM payments p LEFT JOIN players pl ON pl.id = p.player_id
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
}

export async function paymentSummary(): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT count(*)::int                                              AS orders,
            count(*) FILTER (WHERE status = 'paid')::int               AS paid,
            count(*) FILTER (WHERE status = 'failed')::int             AS failed,
            COALESCE(sum(amount_paise) FILTER (WHERE status = 'paid'), 0)::bigint AS gross_paise,
            COALESCE(sum(base_paise)   FILTER (WHERE status = 'paid'), 0)::bigint AS base_paise,
            COALESCE(sum(gst_paise)    FILTER (WHERE status = 'paid'), 0)::bigint AS gst_paise,
            COALESCE(sum(refunded_paise), 0)::bigint                    AS refunded_paise
       FROM payments`,
  );
}

/** Recent webhooks, including ones refused for a bad signature. */
export async function listPaymentEvents(limit: number): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT event_id, event_type, order_id, payment_id, signature_ok, handled, note, received_at
       FROM payment_events ORDER BY received_at DESC LIMIT $1`,
    [limit],
  );
}

/** One order, for the checkout page. */
export async function getOrderForCheckout(orderId: string): Promise<Record<string, unknown> | null> {
  return queryOne(
    `SELECT p.order_id, p.amount_paise, p.base_paise, p.gst_paise, p.gst_percent,
            p.status, p.plan_key, p.credited_at,
            COALESCE(pl.display_name, 'you') AS player_name,
            (SELECT name FROM plans WHERE plan_key = p.plan_key) AS plan_name
       FROM payments p LEFT JOIN players pl ON pl.id = p.player_id
      WHERE p.order_id = $1`,
    [orderId],
  );
}

/* -------------------------------------------------- browser confirmation */

/**
 * Verifies the signature Razorpay hands back to the browser.
 *
 * HMAC-SHA256 of "orderId|paymentId" with the key secret. This is not a weaker
 * check than the webhook: only Razorpay and this server know the secret, so a
 * player cannot forge it from the developer console. It is simply the same
 * assurance arriving by a different route — and a faster one, which is what
 * lets the page confirm and return to WhatsApp immediately.
 *
 * What it does NOT cover is the payment that succeeds while the browser is gone
 * — a closed tab, a locked phone, a UPI app that never returns. Only the
 * webhook catches those, which is why both paths exist and both credit through
 * the same idempotency key.
 */
export function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  if (!env.RAZORPAY_KEY_SECRET || !signature) return false;

  const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest();

  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }

  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface ConfirmResult {
  ok: boolean;
  alreadyCredited: boolean;
  creditsPaise: number;
  reason?: string;
}

/**
 * Credits a payment confirmed by the browser.
 *
 * Shares the row lock and the idempotency key with the webhook path, so a
 * payment confirmed by both — which is the normal case — credits exactly once,
 * whichever arrives first.
 */
export async function confirmPayment(
  orderId: string,
  paymentId: string,
  signature: string,
): Promise<ConfirmResult> {
  if (!verifyPaymentSignature(orderId, paymentId, signature)) {
    logger.error({ orderId, paymentId }, 'browser payment signature invalid — refusing to credit');
    return { ok: false, alreadyCredited: false, creditsPaise: 0, reason: 'signature invalid' };
  }

  return withTransaction(async (client) => {
    const payment = await queryOne<{
      id: string;
      player_id: string | null;
      wa_id: string | null;
      credits_paise: number;
      amount_paise: number;
      credited_at: Date | null;
    }>(
      `SELECT id, player_id, wa_id, credits_paise, amount_paise, credited_at
         FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId],
      client,
    );

    if (!payment) {
      return { ok: false, alreadyCredited: false, creditsPaise: 0, reason: 'unknown order' };
    }

    if (payment.credited_at) {
      // The webhook got here first. Not an error — the player still paid once.
      return { ok: true, alreadyCredited: true, creditsPaise: payment.credits_paise };
    }

    await query(
      `UPDATE payments
          SET status = 'paid', payment_id = COALESCE(payment_id, $2),
              paid_at = now(), credited_at = now(), updated_at = now()
        WHERE id = $1`,
      [payment.id, paymentId],
      client,
    );

    if (payment.player_id) {
      await postLedgerEntry(
        {
          playerId: payment.player_id,
          amountPaise: payment.credits_paise,
          kind: 'topup',
          referenceType: 'razorpay',
          referenceId: paymentId,
          idempotencyKey: `razorpay:${paymentId}`,
          note: 'Razorpay top-up',
        },
        client,
      );
    }

    void notify({
      trigger: 'payment.received',
      summary: `Rs ${(payment.amount_paise / 100).toFixed(2)} received from +${payment.wa_id ?? '?'}`,
      playerId: payment.player_id,
      detail: { orderId, paymentId, amountPaise: payment.amount_paise },
    });

    logger.info({ orderId, paymentId }, 'payment confirmed in browser and credited');
    return { ok: true, alreadyCredited: false, creditsPaise: payment.credits_paise };
  });
}

/**
 * The open order for a player and plan, creating one only if needed.
 *
 * The checkout page shows two options and the host picks on the page, so both
 * orders must exist before either is chosen. Re-using an unpaid order rather
 * than minting a new one on every page load keeps the Razorpay dashboard
 * readable — a host who opens the link three times should not leave three
 * abandoned orders behind.
 */
export async function findOrCreateOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const existing = await queryOne<{
    order_id: string;
    amount_paise: number;
    base_paise: number;
    gst_paise: number;
  }>(
    `SELECT order_id, amount_paise, base_paise, gst_paise
       FROM payments
      WHERE player_id = $1 AND plan_key = $2 AND status = 'created'
        AND credited_at IS NULL
        AND created_at > now() - interval '2 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [input.playerId, input.planKey ?? null],
  );

  if (existing) {
    return {
      id: existing.order_id,
      orderId: existing.order_id,
      amountPaise: existing.amount_paise,
      basePaise: existing.base_paise,
      gstPaise: existing.gst_paise,
      currency: 'INR',
      keyId: env.RAZORPAY_KEY_ID,
    };
  }

  return createOrder(input);
}

/** The order behind a payment id, for confirming that it belongs to this host. */
export async function orderBelongsTo(orderId: string, playerId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM payments WHERE order_id = $1 AND player_id = $2`,
    [orderId, playerId],
  );
  return Number(row?.n ?? 0) > 0;
}
