-- ===========================================================================
-- MastiPe schema - the whole thing, in one file.
--
-- There is no migration chain. `npm run db:reset -- --yes` drops everything
-- and rebuilds from here. Change the schema by editing this file and
-- re-running it.
--
-- Switch to additive migrations once there are real players to protect.
-- ===========================================================================

DROP TABLE IF EXISTS legal_documents    CASCADE;
DROP TABLE IF EXISTS notification_log   CASCADE;
DROP TABLE IF EXISTS notification_queue CASCADE;
DROP TABLE IF EXISTS notification_settings CASCADE;
DROP TABLE IF EXISTS support_ticket_messages CASCADE;
DROP TABLE IF EXISTS support_tickets    CASCADE;
DROP TABLE IF EXISTS app_settings       CASCADE;
DROP TABLE IF EXISTS admin_login_attempts CASCADE;
DROP TABLE IF EXISTS admin_sessions     CASCADE;
DROP TABLE IF EXISTS block_history      CASCADE;
DROP TABLE IF EXISTS blocked_numbers    CASCADE;
DROP TABLE IF EXISTS analytics_events   CASCADE;
DROP TABLE IF EXISTS board_sessions     CASCADE;
DROP TABLE IF EXISTS feedback           CASCADE;
DROP TABLE IF EXISTS claims             CASCADE;
DROP TABLE IF EXISTS fatafat_answers    CASCADE;
DROP TABLE IF EXISTS fatafat_rounds     CASCADE;
DROP TABLE IF EXISTS draw_answers       CASCADE;
DROP TABLE IF EXISTS draws              CASCADE;
DROP TABLE IF EXISTS entries            CASCADE;
DROP TABLE IF EXISTS game_players       CASCADE;
DROP TABLE IF EXISTS games              CASCADE;
DROP TABLE IF EXISTS consents           CASCADE;
DROP TABLE IF EXISTS messages           CASCADE;
DROP TABLE IF EXISTS processed_messages CASCADE;
DROP TABLE IF EXISTS player_states      CASCADE;
DROP TABLE IF EXISTS players            CASCADE;


-- --- People ----------------------------------------------------------------

CREATE TABLE players (
  id            bigserial PRIMARY KEY,
  wa_id         text        NOT NULL UNIQUE,   -- WhatsApp number, digits only
  display_name  text,
  locale        text,
  is_blocked    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  -- Where and what they last played on.
  --
  -- These are only ever populated when a player OPENS THEIR BOARD IN A
  -- BROWSER. WhatsApp traffic reaches us via Meta's servers and carries no
  -- client address or device at all, so a player who never opens their board
  -- has nulls here forever. That is a property of the transport, not a bug.
  last_ip          text,
  last_user_agent  text,
  last_device_type text,          -- phone | tablet | desktop | bot
  last_os          text,
  last_browser     text,
  last_device_at   timestamptz,
  -- Approximate: a mobile connection usually resolves to the operator's
  -- gateway rather than the person. Left null unless geo lookup is enabled.
  last_city        text,
  last_region      text,
  last_country     text
);
CREATE INDEX players_last_seen_idx ON players (last_seen_at DESC);

-- Where each player sits in the WhatsApp conversation. One row per player;
-- the whole chat flow is a small state machine parked here.
CREATE TABLE player_states (
  player_id   bigint      PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  state       text        NOT NULL DEFAULT 'new',
  context     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Consent is versioned so a future policy change can re-prompt everyone.
CREATE TABLE consents (
  id              bigserial   PRIMARY KEY,
  player_id       bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  policy_version  text        NOT NULL,
  agreed_at       timestamptz NOT NULL DEFAULT now(),
  source          text        NOT NULL DEFAULT 'whatsapp'
);
CREATE INDEX consents_player_idx ON consents (player_id, agreed_at DESC);


-- --- Games -----------------------------------------------------------------

CREATE TABLE games (
  id                bigserial   PRIMARY KEY,
  code              text        NOT NULL UNIQUE,   -- shared in the invite link
  host_player_id    bigint      NOT NULL REFERENCES players(id),
  -- Which game was played. Only 'tambola' exists today; the column is here so
  -- a second game needs no migration.
  game_key          text        NOT NULL DEFAULT 'tambola',
  -- Monetisation placeholders. Everything is free during the trial, so these
  -- stay at their defaults until sponsorship billing is switched on.
  plan_key          text        NOT NULL DEFAULT 'free_trial',
  charged_paise     int         NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'lobby'
                      CHECK (status IN ('lobby','running','finished','abandoned')),
  expected_players  int         NOT NULL CHECK (expected_players BETWEEN 2 AND 2000),

  -- All 90 numbers, shuffled once at creation. Draws advance `cursor` through
  -- this array, so a delayed or duplicated tick can never reorder the game,
  -- and any disputed round can be replayed exactly from `seed`.
  seed              bigint      NOT NULL,
  sequence          jsonb       NOT NULL,
  cursor            int         NOT NULL DEFAULT 0 CHECK (cursor BETWEEN 0 AND 90),

  draw_interval_seconds int     NOT NULL DEFAULT 12,
  next_draw_at      timestamptz,                   -- NULL until the host starts
  started_at        timestamptz,
  ended_at          timestamptz,
  ended_reason      text        CHECK (ended_reason IN
                      ('full_house','numbers_exhausted','abandoned')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The scheduler's only query: claim games whose next tick is due. Running
-- FOR UPDATE SKIP LOCKED against this index is what lets more than one
-- process run without two of them drawing the same number.
CREATE INDEX games_due_idx   ON games (next_draw_at) WHERE status = 'running';
CREATE INDEX games_lobby_idx ON games (created_at)   WHERE status = 'lobby';

CREATE TABLE game_players (
  id         bigserial   PRIMARY KEY,
  game_id    bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  is_host    boolean     NOT NULL DEFAULT false,  -- the temporary host, pre-start
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  UNIQUE (game_id, player_id)                     -- nobody joins twice
);
CREATE INDEX game_players_game_idx ON game_players (game_id);

-- One ticket per player per game, for now.
CREATE TABLE entries (
  id         bigserial   PRIMARY KEY,
  game_id    bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ticket     jsonb       NOT NULL,                -- { grid: 3x9, numbers: [15] }
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, player_id)
);


-- --- Play ------------------------------------------------------------------

-- One row per number called. This table - not browser memory - is the record
-- of the game, so a player whose phone slept reconnects and replays from here.
CREATE TABLE draws (
  id        bigserial   PRIMARY KEY,
  game_id   bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq       int         NOT NULL CHECK (seq   BETWEEN 1 AND 90),
  value     int         NOT NULL CHECK (value BETWEEN 1 AND 90),
  drawn_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, seq),     -- a replayed tick cannot insert twice
  UNIQUE (game_id, value)    -- and no number can ever be called twice
);
CREATE INDEX draws_game_seq_idx ON draws (game_id, seq);

-- The player's own marking. Deliberately separate from `draws`: this records
-- what they said they saw, never what is true. Claims are validated against
-- `draws`, so a mis-tap or a missed number cannot void a legitimate win.
CREATE TABLE draw_answers (
  id           bigserial   PRIMARY KEY,
  game_id      bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq          int         NOT NULL,
  player_id    bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  answer       text        NOT NULL CHECK (answer IN ('yes','no','no_response')),
  was_correct  boolean,                           -- NULL for no_response
  answered_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, seq, player_id)                -- one answer per number
);
CREATE INDEX draw_answers_game_seq_idx ON draw_answers (game_id, seq);
-- The panel counts a player's correct answers for every row of the players
-- list. Without this each row scans the whole table.
CREATE INDEX draw_answers_player_idx  ON draw_answers (player_id);

CREATE TABLE claims (
  id          bigserial   PRIMARY KEY,
  game_id     bigint      NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id   bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  claim_type  text        NOT NULL CHECK (claim_type IN
                ('jaldi5','top_line','middle_line','bottom_line','corners','full_house')),
  status      text        NOT NULL CHECK (status IN ('awarded','rejected')),
  seq         int,                                -- which draw it happened on
  reason      text,                               -- why a rejection was rejected
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- THE guard on prizes. When two players tap Full House in the same instant,
-- both transactions try to insert and Postgres lets exactly one through; the
-- loser catches 23505 and is told the prize has just gone. Application code
-- cannot win this race on its own, so it does not try.
CREATE UNIQUE INDEX claims_one_winner_per_prize
  ON claims (game_id, claim_type) WHERE status = 'awarded';
CREATE INDEX claims_game_idx ON claims (game_id, created_at);


-- --- WhatsApp plumbing -----------------------------------------------------

-- Meta retries webhooks aggressively. Every inbound message id is inserted
-- here first with ON CONFLICT DO NOTHING; no row back means it is a retry and
-- the payload is dropped before any game logic runs.
CREATE TABLE processed_messages (
  message_id   text        PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processed_messages_age_idx ON processed_messages (received_at);

-- Conversation log, for debugging what a player actually saw.
CREATE TABLE messages (
  id             bigserial   PRIMARY KEY,
  player_id      bigint      REFERENCES players(id) ON DELETE SET NULL,
  direction      text        NOT NULL CHECK (direction IN ('in','out')),
  wa_message_id  text,
  kind           text,
  body           text,
  -- Outbound delivery outcome, so a silent failure is visible in the panel
  -- rather than being discovered when a player says they got nothing.
  status         text,                  -- sent | failed | blocked | dry_run
  error          text,
  game_id        bigint      REFERENCES games(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_player_idx ON messages (player_id, created_at DESC);


-- --- Tracking -------------------------------------------------------------

/*
 * One row per (player, game, device) that ever opened a board.
 *
 * Separate from `players` because one person legitimately plays from more than
 * one device, and because the interesting questions - how many reconnects, was
 * it the WhatsApp in-app browser, how long were they actually on the page -
 * are per-session, not per-person.
 */
CREATE TABLE board_sessions (
  id              bigserial   PRIMARY KEY,
  game_id         bigint      REFERENCES games(id)   ON DELETE CASCADE,
  player_id       bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,

  ip              text,
  user_agent      text,
  device_type     text,
  os              text,
  os_version      text,
  browser         text,
  browser_version text,
  -- Links tapped inside WhatsApp open in an embedded WebView that suspends
  -- when backgrounded and can silently drop a live connection. Recording this
  -- is what separates "our code broke" from "they switched apps".
  in_app_browser  boolean     NOT NULL DEFAULT false,
  in_app_host     text,
  language        text,
  referer         text,

  city            text,
  region          text,
  country         text,

  hits            int         NOT NULL DEFAULT 1,
  stream_opens    int         NOT NULL DEFAULT 0,   -- each one is a reconnect
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);
-- One row per device per game, so a reload updates rather than duplicates.
CREATE UNIQUE INDEX board_sessions_unique
  ON board_sessions (game_id, player_id, md5(coalesce(ip,'') || coalesce(user_agent,'')));
CREATE INDEX board_sessions_player_idx ON board_sessions (player_id, last_seen_at DESC);

/*
 * The audit trail: every meaningful thing anyone did, with the context it
 * happened in. This is what the admin panel's Events view and a player's
 * timeline read from.
 *
 * `properties` is jsonb so a new event type never needs a schema change.
 */
CREATE TABLE analytics_events (
  id           bigserial   PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  event_type   text        NOT NULL,   -- board_open, answer, claim, join, start …
  source       text        NOT NULL,   -- whatsapp | board | system | admin
  player_id    bigint      REFERENCES players(id) ON DELETE SET NULL,
  game_id      bigint      REFERENCES games(id)   ON DELETE SET NULL,
  session_id   bigint      REFERENCES board_sessions(id) ON DELETE SET NULL,
  request_ip   text,
  user_agent   text,
  properties   jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX analytics_events_player_idx ON analytics_events (player_id, occurred_at DESC);
CREATE INDEX analytics_events_game_idx   ON analytics_events (game_id, occurred_at DESC);
CREATE INDEX analytics_events_type_idx   ON analytics_events (event_type, occurred_at DESC);
CREATE INDEX analytics_events_time_idx   ON analytics_events (occurred_at DESC);


-- --- After the game --------------------------------------------------------

CREATE TABLE feedback (
  id          bigserial   PRIMARY KEY,
  -- CASCADE, not SET NULL. With SET NULL, deleting two of one player's games
  -- collapses both their feedback rows onto (player_id, NULL) and trips the
  -- uniqueness below. Feedback about a game that no longer exists is orphaned
  -- anyway, so it goes with it.
  game_id     bigint      REFERENCES games(id) ON DELETE CASCADE,
  player_id   bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  rating      int         CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  -- Approved comments are the ones cleared to appear as public testimonials.
  approved_at timestamptz,
  approved_by text,
  display_as  text,                    -- the name to show publicly, if changed
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_created_idx ON feedback (created_at DESC);
-- One row per player per game: a second rating corrects the first instead of
-- stacking duplicates. COALESCE, because game_id is nullable for feedback that
-- is not about a specific game.
CREATE UNIQUE INDEX feedback_one_per_player_game
  ON feedback (player_id, COALESCE(game_id, 0));


-- --- Moderation ------------------------------------------------------------

CREATE TABLE blocked_numbers (
  wa_id       text        PRIMARY KEY,
  reason      text,
  category    text,
  blocked_by  text,
  blocked_at  timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

-- Kept separate and never deleted: an unblock must not erase the record that a
-- block ever happened.
CREATE TABLE block_history (
  id            bigserial   PRIMARY KEY,
  wa_id         text        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('blocked','unblocked','reported')),
  reason        text,
  category      text,
  performed_by  text,
  reported_by   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX block_history_wa_idx ON block_history (wa_id, created_at DESC);


-- --- Admin panel -----------------------------------------------------------

/*
 * Admin sessions.
 *
 * Only a HASH of the token is stored. A leaked database backup then does not
 * hand someone a working session, and there is no reason for the server to
 * ever be able to reproduce a token it already issued.
 */
CREATE TABLE admin_sessions (
  id           bigserial   PRIMARY KEY,
  token_hash   text        NOT NULL UNIQUE,
  label        text,
  request_ip   text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

-- Drives lockout after repeated wrong passcodes, counted per source address.
CREATE TABLE admin_login_attempts (
  id           bigserial   PRIMARY KEY,
  request_ip   text,
  succeeded    boolean     NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_attempts_idx ON admin_login_attempts (request_ip, attempted_at DESC);


-- --- Editable settings ------------------------------------------------------

/*
 * Values an operator can change from the panel without a redeploy.
 *
 * Deliberately key/value rather than a column per setting: these are rare,
 * unrelated, and each one would otherwise be a schema change. Anything absent
 * here falls back to the matching variable in .env, so a fresh database
 * behaves exactly like the environment says it should.
 *
 * NOT wiped by the 'clean up database' action - configuration is not game data.
 */
CREATE TABLE app_settings (
  key        text        PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);


-- --- Support ---------------------------------------------------------------

/*
 * One ticket per question a player asks through the support form.
 *
 * "reference" is the short code the player is given on WhatsApp and quotes
 * back at us. It is generated, not derived from the id, so it carries no
 * information about how many tickets exist.
 */
CREATE TABLE support_tickets (
  id           bigserial   PRIMARY KEY,
  reference    text        NOT NULL UNIQUE,
  player_id    bigint      REFERENCES players(id) ON DELETE SET NULL,
  game_id      bigint      REFERENCES games(id)   ON DELETE SET NULL,

  name         text        NOT NULL,
  wa_id        text,
  email        text,
  query_type   text        NOT NULL,
  subject      text        NOT NULL,
  message      text        NOT NULL,

  status       text        NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','in_progress','waiting_on_player','resolved','closed')),
  priority     text        NOT NULL DEFAULT 'normal'
                 CHECK (priority IN ('low','normal','high','urgent')),

  -- Whether the emailed copy actually left the building. A support request
  -- that silently failed to send is the worst possible failure here.
  emailed_at   timestamptz,
  email_error  text,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_player_idx ON support_tickets (player_id, created_at DESC);

/*
 * The conversation on a ticket. An operator's reply is also pushed to the
 * player over WhatsApp, so this doubles as the record of what was sent.
 */
CREATE TABLE support_ticket_messages (
  id           bigserial   PRIMARY KEY,
  ticket_id    bigint      NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author       text        NOT NULL CHECK (author IN ('player','admin','system')),
  author_name  text,
  body         text        NOT NULL,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_ticket_messages_idx ON support_ticket_messages (ticket_id, created_at);


-- --- Operator notifications ------------------------------------------------

/*
 * One row per alert type, so an operator can turn each one down without a
 * deploy. Seeded below; new triggers appear with their default mode the first
 * time the server starts after they are added.
 *
 * mode:
 *   instant - emailed the moment it happens
 *   digest  - collected into the periodic email
 *   off     - still recorded in analytics_events, just never emailed
 */
CREATE TABLE notification_settings (
  trigger_key text        PRIMARY KEY,
  mode        text        NOT NULL DEFAULT 'digest'
                CHECK (mode IN ('instant','digest','off')),
  recipient   text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

/*
 * Things that happened and have not been emailed yet.
 *
 * A queue rather than a straight send, because the high-frequency triggers -
 * every "hi", every game start - would otherwise be hundreds of separate
 * emails a day. Instant ones are sent and marked immediately; the rest wait
 * for the digest.
 */
CREATE TABLE notification_queue (
  id          bigserial   PRIMARY KEY,
  trigger_key text        NOT NULL,
  subject     text        NOT NULL,
  body        text        NOT NULL,
  player_id   bigint      REFERENCES players(id) ON DELETE SET NULL,
  game_id     bigint      REFERENCES games(id)   ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX notification_queue_pending_idx ON notification_queue (created_at)
  WHERE sent_at IS NULL;

/* What was actually emailed, so a silent failure is visible. */
CREATE TABLE notification_log (
  id          bigserial   PRIMARY KEY,
  kind        text        NOT NULL,        -- instant | digest | test
  subject     text        NOT NULL,
  recipient   text,
  event_count int         NOT NULL DEFAULT 1,
  ok          boolean     NOT NULL,
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_log_idx ON notification_log (sent_at DESC);

/*
 * The policies, as data.
 *
 * They used to be hardcoded in a page template, which made them impossible
 * to correct without a deploy - and Meta, Razorpay and the app stores all
 * review these pages and ask for changes. One row per document per language.
 *
 *  is plain text with blank-line paragraphs and "- " bullets. Not HTML:
 * these are rendered into three different surfaces (the marketing site, the
 * in-WhatsApp page, and the admin editor), and a stored HTML blob would be an
 * injection risk in all three.
 */
CREATE TABLE legal_documents (
  doc_key          text        NOT NULL,
  lang             text        NOT NULL DEFAULT 'en',
  title            text        NOT NULL,
  summary          text,
  body             text        NOT NULL,
  -- Bumped by hand when the words change materially. Consent is recorded
  -- against this, so changing it asks every player to agree again.
  version          text        NOT NULL,
  -- Whether accepting this is required before playing. Only the terms are.
  requires_consent boolean     NOT NULL DEFAULT false,
  is_active        boolean     NOT NULL DEFAULT true,
  sort_order       int         NOT NULL DEFAULT 100,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  PRIMARY KEY (doc_key, lang)
);
CREATE INDEX legal_documents_active_idx ON legal_documents (lang, is_active, sort_order);

-- ===========================================================================
-- Fatafat - the reaction game
-- ===========================================================================
--
-- A round stores its SEED, not its questions. The bank is fixed content
-- shipped in the repo, so ten question ids can always be rebuilt from one
-- integer - which keeps a copy of the bank out of the database and lets any
-- disputed round be replayed exactly as it was played.

CREATE TABLE fatafat_rounds (
  id             bigserial   PRIMARY KEY,
  player_id      bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seed           bigint      NOT NULL,
  -- The ten questions, written down rather than derived. Choosing them depends
  -- on what this player has already seen, so a seed alone would rebuild a
  -- different round tomorrow and quietly rewrite every past report.
  question_ids   text[]      NOT NULL DEFAULT '{}',
  question_count int         NOT NULL DEFAULT 10,
  time_limit_ms  int         NOT NULL DEFAULT 5000,
  status         text        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','finished','abandoned')),
  -- Stored per round, not per player. Somebody who switches to Hindi today
  -- should still see last week's report in the English they played it in.
  lang           text        NOT NULL DEFAULT 'en' CHECK (lang IN ('en','hi')),
  score          numeric(8,2) NOT NULL DEFAULT 0,
  -- Which question the server has handed out, and when. Correctness and
  -- elapsed time are decided here, never by the page: a client that scores
  -- itself is a client that can score itself perfectly.
  current_seq    int         NOT NULL DEFAULT 0,
  served_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
CREATE INDEX fatafat_rounds_player_idx ON fatafat_rounds (player_id, created_at DESC);

CREATE TABLE fatafat_answers (
  id           bigserial   PRIMARY KEY,
  round_id     bigint      NOT NULL REFERENCES fatafat_rounds(id) ON DELETE CASCADE,
  seq          int         NOT NULL,
  question_id  text        NOT NULL,
  mode         text        NOT NULL,
  difficulty   int         NOT NULL,
  -- Empty string means they touched nothing, which is the CORRECT answer to a
  -- no-go. Null would read as "no data recorded" and lose that distinction.
  tapped       text        NOT NULL DEFAULT '',
  was_correct  boolean     NOT NULL,
  -- The player's own stopwatch, and the server's. They disagree by the round
  -- trip; keeping both is what makes an impossible claim visible later.
  taken_ms     int,
  server_ms    int,
  twisted      boolean     NOT NULL DEFAULT false,
  points       numeric(8,2) NOT NULL DEFAULT 0,
  answered_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, seq)
);
CREATE INDEX fatafat_answers_round_idx ON fatafat_answers (round_id, seq);
