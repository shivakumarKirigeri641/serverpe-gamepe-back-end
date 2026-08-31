-- Free trial shortened to 14 September, to see how opt-in behaves over a
-- two-week window rather than a month.
--
-- These are the seeded defaults; the wording remains editable from the admin
-- panel. Versions are bumped on the documents whose substance changed, so
-- players are asked to accept the new dates.

UPDATE plans
   SET tagline = 'Free to play until 14 September. Up to 30 players.',
       description = E'*Free Trial*\n\nEverything unlocked, no payment, no card details.\n\n• Up to 30 players per game\n• All six prizes\n• Points and weekly leaderboard\n\nFree until 14 September 2026. We will tell you before anything changes.',
       updated_at = now()
 WHERE plan_key = 'free_trial';

UPDATE plans
   SET description = replace(description, '30 September', '14 September'),
       tagline = replace(tagline, '30 September', '14 September'),
       updated_at = now()
 WHERE plan_key IN ('casual', 'party');

UPDATE legal_documents
   SET body = replace(body, '30 September', '14 September'),
       summary = replace(summary, '30 September', '14 September'),
       version = version + 1,
       effective_from = now(),
       updated_at = now()
 WHERE body LIKE '%30 September%' OR summary LIKE '%30 September%';
