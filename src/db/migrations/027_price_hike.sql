-- 027_price_hike.sql
-- ---------------------------------------------------------------------------
-- Adds Rs 10 to every paid plan.
--
-- Applied as an UPDATE rather than by rewriting 026's seed, so the change is
-- dated and reversible: what a plan cost on a given day is answerable from the
-- migration history, and games already played keep the price recorded on their
-- own row regardless.
--
-- Prices are GST-INCLUSIVE: Rs 49 is what the player is charged, with the tax
-- taken out of it rather than added on top.
--
-- The free trial is untouched — Rs 0 plus ten is not a free trial.

UPDATE plans
   SET price_paise = price_paise + 1000,
       updated_at  = now()
 WHERE kind IN ('single', 'unlimited_24h')
   AND price_paise > 0;
