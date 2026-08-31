-- Plan names and taglines had no Hindi, so the Hindi website printed
-- "Free Trial — Free to play until 6 September" in English inside an otherwise
-- Hindi page. Same approach as legal_documents: a parallel column per string,
-- owned by the admin panel, falling back to English when it is empty.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS name_hi    text;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS tagline_hi text;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_tagline_hi_len;
ALTER TABLE plans
  ADD CONSTRAINT plans_tagline_hi_len
  CHECK (tagline_hi IS NULL OR char_length(tagline_hi) <= 96);

-- {TRIAL_END} is substituted at render time, exactly as in the English text,
-- so extending the trial in .env moves both languages at once.
UPDATE plans
   SET name_hi    = 'फ्री ट्रायल',
       tagline_hi = '{TRIAL_END} तक खेलना मुफ़्त। 30 खिलाड़ियों तक।'
 WHERE plan_key = 'free_trial';

-- The paid tiers are named by their room size ("Up to 25", "Day pass 25"), so
-- their Hindi is mechanical and worth seeding rather than leaving English.
UPDATE plans
   SET name_hi    = replace(name, 'Up to', 'अधिकतम') || ' खिलाड़ी',
       tagline_hi = 'एक गेम, अधिकतम ' || max_players || ' खिलाड़ी।'
 WHERE plan_key LIKE 'single\_%';

UPDATE plans
   SET name_hi    = replace(name, 'Day pass', 'डे पास'),
       tagline_hi = '24 घंटे अनलिमिटेड गेम, अधिकतम ' || max_players || ' खिलाड़ी।'
 WHERE plan_key LIKE 'unlimited\_%';
