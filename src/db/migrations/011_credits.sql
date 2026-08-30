-- Credits: the host pays from a wallet, and is only charged once a game has
-- actually delivered something.
--
-- Charging at "start" would take money from a host whose friends never turned
-- up. Charging at the first number drawn means an empty room costs nothing and
-- the balance stays theirs for the next attempt — which also removes the most
-- likely source of refund disputes.

-- When the game was charged, and for how much. Both null until the first
-- number is drawn; `charged_at` makes the deduction idempotent even if the
-- draw worker retries.
ALTER TABLE games ADD COLUMN IF NOT EXISTS charged_at timestamptz;
ALTER TABLE games ADD COLUMN IF NOT EXISTS charged_paise integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS games_charged_idx ON games(charged_at) WHERE charged_at IS NOT NULL;

-- Wallet top-ups and adjustments made from the admin panel need to say who did
-- it and why: goodwill for a technical fault and a promotional credit are the
-- same movement of money, and only the note tells them apart later.
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS created_by text;

CREATE INDEX IF NOT EXISTS wallet_transactions_kind_idx ON wallet_transactions(kind, created_at DESC);

-- Every player has a wallet from their first message; backfill anyone created
-- before this existed.
INSERT INTO wallets (player_id)
SELECT id FROM players
ON CONFLICT (player_id) DO NOTHING;
