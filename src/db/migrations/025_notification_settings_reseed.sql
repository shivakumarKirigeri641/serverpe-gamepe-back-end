-- 025_notification_settings_reseed.sql
-- ---------------------------------------------------------------------------
-- Restores the alert triggers, and makes them restorable.
--
-- The database purge cleared notification_settings, because it was not on the
-- keep list — configuration an operator chose, deleted as if it were a player
-- record. The purge is fixed; this puts the rows back on any database that
-- already lost them.
--
-- Idempotent, so it is safe on a database that still has them.

INSERT INTO notification_settings (trigger_key, label, description, mode, display_order) VALUES
  ('player.first_contact', 'Someone new says hi',
   'A number messages MastiPe for the first time. Batched — a busy evening would otherwise be one email per person.',
   'digest', 1),
  ('game.started', 'A game starts',
   'Host, players and room details when a room begins calling numbers.',
   'digest', 2),
  ('game.ended', 'A game ends',
   'Who won, how many numbers were called, and how many players stayed.',
   'digest', 3),
  ('feedback.received', 'Feedback arrives',
   'A player rates a game or leaves a comment.',
   'digest', 4),
  ('support.ticket', 'Support ticket raised',
   'Somebody asks for help. Instant by default — this is the one a person is waiting on.',
   'instant', 5),
  ('player.blocked', 'A number is blocked',
   'A block is applied, by you or automatically.',
   'digest', 6),
  ('payment.received', 'A payment is received',
   'A Razorpay payment is captured and credited. Silent until payments are enabled.',
   'digest', 7)
ON CONFLICT (trigger_key) DO NOTHING;
