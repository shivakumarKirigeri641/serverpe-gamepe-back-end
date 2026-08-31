-- 024_notifications.sql
-- ---------------------------------------------------------------------------
-- Email alerts to the operator.
--
-- Two tables and a reason for each:
--
-- notification_settings — one row per trigger, editable from the admin panel.
-- In the database rather than in .env because turning an alert off at 11pm
-- should not need a deploy, and because "which alerts are on" is an operational
-- decision that changes far more often than configuration does.
--
-- notification_queue — events waiting for the next digest. A queue rather than
-- sending on the spot: thirty players joining a room would be thirty emails,
-- and an inbox that floods is an inbox that gets muted, at which point the
-- alerts have negative value.
--
-- notification_log — what was actually sent, so a missing alert can be
-- distinguished from an alert that was sent and not noticed.

CREATE TABLE IF NOT EXISTS notification_settings (
  trigger_key   text PRIMARY KEY,
  label         text NOT NULL,
  description   text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  -- 'digest' batches into the periodic email; 'instant' sends immediately.
  -- Instant is for the rare thing worth interrupting someone for.
  mode          text NOT NULL DEFAULT 'digest' CHECK (mode IN ('digest', 'instant', 'off')),
  recipient     text,
  display_order integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_key  text NOT NULL,
  -- Denormalised on purpose: the digest must still describe what happened even
  -- after the player or game row it refers to has been deleted.
  summary      text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  player_id    uuid REFERENCES players(id) ON DELETE SET NULL,
  game_id      uuid REFERENCES games(id) ON DELETE SET NULL,
  wa_id        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);

CREATE INDEX IF NOT EXISTS notification_queue_pending_idx
  ON notification_queue(created_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,
  recipient    text NOT NULL,
  subject      text NOT NULL,
  event_count  integer NOT NULL DEFAULT 0,
  ok           boolean NOT NULL,
  error        text,
  sent_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_log_sent_idx ON notification_log(sent_at DESC);

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
