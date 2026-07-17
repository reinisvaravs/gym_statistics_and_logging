CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS strength_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date          date NOT NULL,
  exercise_key  text NOT NULL,
  exercise_name text NOT NULL,
  sets          jsonb NOT NULL DEFAULT '[]',   -- [{ "w": 70, "r": 8, "a": 0 }]
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strength_date ON strength_sessions (date);
CREATE INDEX IF NOT EXISTS idx_strength_key  ON strength_sessions (exercise_key);

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
