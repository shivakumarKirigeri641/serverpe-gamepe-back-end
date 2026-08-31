-- 017_documents.sql
-- ---------------------------------------------------------------------------
-- Generated PDFs, kept on disk and indexed here.
--
-- Reports go out to players after every game and invoices will go out once
-- charging begins. Both need to be findable again months later — "resend the
-- report from the 14th" is a support request, and an invoice is a financial
-- record that has to survive the conversation it was sent in.

CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('report', 'invoice')),
  -- RPT20260830MP1 / INV20260830MP1
  doc_number    text NOT NULL UNIQUE,
  filename      text NOT NULL,
  -- Relative to the uploads root, so moving the folder does not break the rows.
  rel_path      text NOT NULL,
  byte_size     integer NOT NULL DEFAULT 0,
  -- Both nullable: a report can be a player's own history with no game behind
  -- it, and an invoice belongs to a host rather than to a round.
  player_id     uuid REFERENCES players(id) ON DELETE SET NULL,
  game_id       uuid REFERENCES games(id) ON DELETE SET NULL,
  -- Kept because the player row may be deleted while the document must remain
  -- identifiable — an invoice with no addressee is not a record of anything.
  wa_id         text,
  title         text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_on     date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_kind_created_idx ON documents(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_player_idx       ON documents(player_id);
CREATE INDEX IF NOT EXISTS documents_game_idx         ON documents(game_id);
CREATE INDEX IF NOT EXISTS documents_issued_idx       ON documents(issued_on DESC);

-- Numbering restarts at 1 every day, per kind.
--
-- A counter table rather than "count the rows + 1": two games ending in the
-- same second would both read the same count and mint the same number. The
-- upsert below increments under a row lock, so every caller gets its own.
-- The day is an IST date, matching every other day boundary in the product.
CREATE TABLE IF NOT EXISTS document_counters (
  kind        text NOT NULL,
  issued_on   date NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, issued_on)
);
