-- Business identity, support tickets and revenue settings.
--
-- Business details live here rather than in code so the marketing site, the
-- invoices and the admin panel all read one source, and a change of address or
-- GSTIN is an edit rather than a deploy.

CREATE TABLE IF NOT EXISTS business_profile (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Only one row is ever active; the rest are history.
  is_active         boolean NOT NULL DEFAULT true,
  legal_name        text NOT NULL,
  trade_name        text NOT NULL,
  owner_name        text NOT NULL,
  support_email     text NOT NULL,
  support_phone     text,
  gstin             text,
  pan               text,
  address_line1     text NOT NULL,
  address_line2     text,
  city              text NOT NULL,
  state             text,
  postal_code       text,
  country           text NOT NULL DEFAULT 'India',
  website           text,
  -- GST rate applied to paid plans, in basis points (1800 = 18%).
  gst_rate_bp       integer NOT NULL DEFAULT 1800,
  -- Whether displayed prices already include GST.
  prices_include_gst boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_profile_single_active
  ON business_profile((is_active)) WHERE is_active;

INSERT INTO business_profile (
  legal_name, trade_name, owner_name, support_email, gstin,
  address_line1, address_line2, city, state, postal_code, website
)
SELECT
  'ServerPe App Solutions',
  'MastiPe',
  'Shivakumar Kiriger',
  'support@mastipe.in',
  '29BSMPK7696H1ZT',
  'The Orchard, HMT Watch Factory Main Road',
  'Jalahalli',
  'Bangalore',
  'Karnataka',
  '560013',
  'https://mastipe.in'
WHERE NOT EXISTS (SELECT 1 FROM business_profile WHERE is_active);

/* ------------------------------------------------------------------ support */

CREATE TABLE IF NOT EXISTS support_tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference    text NOT NULL UNIQUE,
  player_id    uuid REFERENCES players(id) ON DELETE SET NULL,
  wa_id        text,
  game_id      uuid REFERENCES games(id) ON DELETE SET NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  -- open | in_progress | waiting_on_player | resolved | closed
  status       text NOT NULL DEFAULT 'open',
  priority     text NOT NULL DEFAULT 'normal',
  category     text,
  assigned_to  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CONSTRAINT support_tickets_status_check
    CHECK (status IN ('open','in_progress','waiting_on_player','resolved','closed')),
  CONSTRAINT support_tickets_priority_check
    CHECK (priority IN ('low','normal','high','urgent'))
);

CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_player_idx ON support_tickets(player_id);

-- Every reply on a ticket, from either side.
CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  -- player | admin
  author      text NOT NULL,
  author_name text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_ticket_messages_author_check CHECK (author IN ('player','admin'))
);

CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx
  ON support_ticket_messages(ticket_id, created_at);

/* ------------------------------------------------------------- admin access */

-- Short-lived sessions issued after a correct passcode. The admin API key never
-- reaches the browser: the panel logs in, gets a token, and uses that.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  label       text,
  request_ip  inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at  timestamptz
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at) WHERE revoked_at IS NULL;
