-- The free trial's end date was written into the plan's tagline as literal
-- text ("Free to play until 14 September"), so extending the trial in .env
-- left the website advertising a date that had already passed. The date now
-- lives only in FREE_TRIAL_ENDS_AT and is substituted when the tagline is
-- rendered, exactly as the description already was.

UPDATE plans
   SET tagline = 'Free to play until {TRIAL_END}. Up to 30 players.'
 WHERE plan_key = 'free_trial';
