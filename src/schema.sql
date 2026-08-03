CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A set is { "w": 70, "r": 8, "a": 0, "rpe": 8, "bw": true }
--   w   loaded weight in kg. NULL/0 with bw=true means unweighted bodyweight work.
--   r   reps;  a  reps a spotter helped finish
--   rpe optional 1-10 rating of perceived exertion
--   bw  true when bodyweight is the load and w is *added* weight (pull-ups, dips)
CREATE TABLE IF NOT EXISTS strength_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date NOT NULL,
  exercise_key  text NOT NULL,
  exercise_name text NOT NULL,
  sets          jsonb NOT NULL DEFAULT '[]',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strength_date ON strength_sessions (date);
CREATE INDEX IF NOT EXISTS idx_strength_key  ON strength_sessions (exercise_key);
ALTER TABLE strength_sessions ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS rides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date NOT NULL,
  location      text NOT NULL CHECK (location IN ('in','out')),
  duration_min  numeric,
  distance_km   numeric,
  speed_kmh     numeric,
  avg_hr        numeric,
  avg_watts     numeric,
  avg_cadence   numeric,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rides_date ON rides (date);

CREATE TABLE IF NOT EXISTS bodyweight (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  weight_kg   numeric NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bw_date ON bodyweight (date);

-- Every mutation, so a misunderstood "delete my last squat" can be undone.
-- `before` is the full row as it was (NULL for inserts); `after` is the new row
-- (NULL for deletes). Undo replays this in reverse.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL CHECK (action IN ('insert','update','delete')),
  entry_type  text NOT NULL,
  entry_id    uuid,
  before      jsonb,
  after       jsonb,
  undone      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);

-- Rolling conversation history per Telegram chat, so a follow-up ("and the one
-- before that?", "make it 80kg") has something to refer back to. Only the plain
-- user/assistant turns are kept — tool-call traffic is replayed fresh each time.
CREATE TABLE IF NOT EXISTS chat_messages (
  id       bigserial PRIMARY KEY,
  chat_id  text NOT NULL,
  role     text NOT NULL CHECK (role IN ('user','assistant')),
  content  text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_msgs ON chat_messages (chat_id, id DESC);
