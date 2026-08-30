-- 023_payments.sql
-- ---------------------------------------------------------------------------
-- Razorpay payments.
--
-- Recorded here rather than inferred from the wallet ledger, because the two
-- answer different questions. The ledger says what a player's balance did; this
-- says what happened with their money — which is what a chargeback, a
-- reconciliation against a Razorpay settlement report, or a GST return needs.
--
-- One row per order, updated in place as the payment moves through its states.
-- Razorpay sends the same webhook more than once by design, so every write here
-- must be safe to repeat.

CREATE TABLE IF NOT EXISTS payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Razorpay's ids. The order is created by us; the payment id appears once the
  -- player actually pays, so it is nullable until then and unique after.
  order_id            text NOT NULL UNIQUE,
  payment_id          text UNIQUE,

  player_id           uuid REFERENCES players(id) ON DELETE SET NULL,
  -- Kept independently of the player row: a payment record must stay
  -- identifiable even if the account is later deleted.
  wa_id               text NOT NULL,

  plan_key            text,
  -- What the money buys, resolved when the order is created so a later price
  -- change cannot retroactively alter what was sold.
  credits_paise       integer NOT NULL DEFAULT 0,

  amount_paise        integer NOT NULL,
  currency            text NOT NULL DEFAULT 'INR',

  -- GST split stored at the time of sale: the rate can change, and an invoice
  -- reprinted next year must show the rate that actually applied.
  gst_percent         numeric(5,2) NOT NULL DEFAULT 18,
  base_paise          integer NOT NULL DEFAULT 0,
  gst_paise           integer NOT NULL DEFAULT 0,

  status              text NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','attempted','paid','failed','refunded','cancelled')),
  method              text,
  failure_reason      text,

  -- Set once the wallet has actually been credited, so a repeated webhook can
  -- tell "already handled" from "not yet handled" without guessing.
  credited_at         timestamptz,
  refunded_paise      integer NOT NULL DEFAULT 0,

  -- The raw Razorpay payloads, for disputes. What they sent is the record of
  -- what happened, and paraphrasing it into columns loses the parts nobody
  -- thought to keep until they were needed.
  order_payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);

CREATE INDEX IF NOT EXISTS payments_player_idx  ON payments(player_id);
CREATE INDEX IF NOT EXISTS payments_status_idx  ON payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments(created_at DESC);

-- Every webhook Razorpay sends, kept whether or not it was acted on.
--
-- A payment that goes wrong is investigated from what arrived, not from what we
-- decided to do about it. The event id is unique, which is also what makes
-- replay handling trivial: a duplicate insert is rejected rather than reasoned
-- about.
CREATE TABLE IF NOT EXISTS payment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      text UNIQUE,
  event_type    text NOT NULL,
  order_id      text,
  payment_id    text,
  signature_ok  boolean NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  handled       boolean NOT NULL DEFAULT false,
  note          text
);

CREATE INDEX IF NOT EXISTS payment_events_type_idx  ON payment_events(event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_events_order_idx ON payment_events(order_id);
