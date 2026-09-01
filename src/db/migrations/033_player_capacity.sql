-- One player cap, honestly stated everywhere.
--
-- Three numbers disagreed: the engine allowed 200, the free-trial plan row said
-- 1000, and the copy promised 30. None of them was measured. A called number is
-- delivered to every player in the room one WhatsApp message at a time, and a
-- send costs about 850ms — so fifty people take five seconds with the fan-out
-- running eight at a time, and two hundred take twenty-one. Past that the room
-- falls behind its own draw interval and never recovers.
--
-- Fifty is what the platform can serve well today. The larger bands are kept —
-- the prices are decided and the rows are referenced by existing games — but
-- they stop being selectable until the fan-out is proven at that size, so
-- nobody can buy a room we would then run badly.

UPDATE plans
   SET max_players = 50,
       tagline     = 'Free to play until {TRIAL_END}. Up to 50 players.',
       tagline_hi  = '{TRIAL_END} तक खेलना मुफ़्त। 50 खिलाड़ियों तक।',
       description = replace(description, 'Up to 30 players per game', 'Up to 50 players per game')
 WHERE plan_key = 'free_trial';

-- Bands the delivery path has not been proven at. Nothing is deleted: flipping
-- is_selectable back on is all that is needed once it has.
UPDATE plans
   SET is_selectable = false
 WHERE max_players > 50
   AND plan_key <> 'free_trial';

COMMENT ON COLUMN plans.max_players IS
  'Upper bound of the band. The platform-wide ceiling is MAX_PLAYERS_PER_GAME, '
  'which is set by how fast a draw can reach everyone, not by the game rules.';
