-- 022_plan_trial_token.sql
-- ---------------------------------------------------------------------------
-- Stops plan descriptions carrying a hardcoded trial end date.
--
-- All three said "free trial is running until 14 September" long after the
-- trial had been shortened to 6 September. A date written into stored text goes
-- stale the moment the date changes, and nothing warns you — the wrong date is
-- simply shown to players until somebody happens to read it.
--
-- Replaced with a {TRIAL_END} token, substituted at render time from
-- FREE_TRIAL_ENDS_AT. Extending the trial is now a one-line env change and
-- every surface follows: the WhatsApp plan picker, the public plans API and the
-- marketing site's pricing cards.

UPDATE plans
   SET description = regexp_replace(
         description,
         'free trial is running until [0-9]{1,2} [A-Za-z]+( [0-9]{4})?',
         'free trial is running until {TRIAL_END}',
         'g'
       )
 WHERE description ~ 'free trial is running until';

UPDATE plans
   SET description = regexp_replace(
         description,
         'Free until [0-9]{1,2} [A-Za-z]+( [0-9]{4})?',
         'Free until {TRIAL_END}',
         'g'
       )
 WHERE description ~ 'Free until [0-9]';
