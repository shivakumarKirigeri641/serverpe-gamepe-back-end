-- Settings an operator changes, as opposed to settings a deployment fixes.
--
-- The free trial's end date was only in FREE_TRIAL_ENDS_AT, so extending the
-- trial meant editing a file on the server and restarting — during which the
-- marketing site advertised the old date. It belongs in the database, where the
-- admin panel owns it and every surface picks it up at once.
--
-- The environment variable stays as the default: a fresh database with no row
-- here behaves exactly as before.

CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Deliberately not seeded with a date. An empty table means "use the
-- environment", which is the correct behaviour until somebody has actually
-- chosen a date in the panel — otherwise this migration would freeze whatever
-- .env happened to say on the day it ran.

COMMENT ON TABLE app_settings IS
  'Operator-editable settings. Absent key = fall back to the environment.';
