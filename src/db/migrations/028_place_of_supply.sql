-- 028_place_of_supply.sql
-- ---------------------------------------------------------------------------
-- Where the customer is, and how the tax splits because of it.
--
-- Under GST the supplier's state and the customer's state together decide the
-- split, not the amount: same state is CGST + SGST, different state is IGST.
-- The total the player pays is identical either way, so it is invisible on the
-- page and unforgiving on the return — a set of invoices that all say CGST
-- because nobody asked where the customer was is a set of invoices that has to
-- be reissued.
--
-- Asked once, at checkout, and stored on the payment. Not on the player: a
-- person can host from Bengaluru in March and Pune in May, and the invoice must
-- record where they were when they bought, not where they live now.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS place_of_supply      text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS place_of_supply_code text;

-- The split, stored rather than derived. GST rates and rules change; an invoice
-- reprinted in two years must show what actually applied on the day.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cgst_paise integer NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sgst_paise integer NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS igst_paise integer NOT NULL DEFAULT 0;

-- The supplier's own state, copied onto the row for the same reason: the
-- business could move, and old invoices must not silently change.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS supplier_state text;

CREATE INDEX IF NOT EXISTS payments_place_idx ON payments(place_of_supply_code);
