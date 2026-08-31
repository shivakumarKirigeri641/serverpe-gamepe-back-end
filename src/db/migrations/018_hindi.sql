-- 018_hindi.sql
-- ---------------------------------------------------------------------------
-- Hindi translations for the legal documents.
--
-- Added as columns beside the English rather than as a second row per language:
-- a document's version, consent records and display order describe the
-- document, not the language it is being read in. Splitting it into two rows
-- would mean a player who accepted the Hindi text had consented to a different
-- document from the one the English reader accepted, which is exactly wrong —
-- it is one agreement, offered in two languages.
--
-- Nullable throughout, and the English is the fallback: an untranslated
-- document still renders rather than showing a blank page, and a policy change
-- can go live in English immediately without waiting for the translation.
--
-- English remains the legally operative text. That is stated to the reader on
-- the policies page itself, not just here.

ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS title_hi   text;
ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS summary_hi text;
ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS body_hi    text;

-- The WhatsApp list limits apply to the Hindi too: the row title is truncated
-- by WhatsApp at 24 characters whatever script it is in.
ALTER TABLE legal_documents
  DROP CONSTRAINT IF EXISTS legal_documents_title_hi_len;
ALTER TABLE legal_documents
  ADD CONSTRAINT legal_documents_title_hi_len
  CHECK (title_hi IS NULL OR char_length(title_hi) <= 24);

ALTER TABLE legal_documents
  DROP CONSTRAINT IF EXISTS legal_documents_summary_hi_len;
ALTER TABLE legal_documents
  ADD CONSTRAINT legal_documents_summary_hi_len
  CHECK (summary_hi IS NULL OR char_length(summary_hi) <= 72);

-- Which language a person last chose, so the board and the policies page can
-- open in it without asking again. Not used for WhatsApp: chat stays English.
ALTER TABLE players ADD COLUMN IF NOT EXISTS preferred_locale text;
