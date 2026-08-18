-- Katabatic research archive — Neon Postgres schema
--
-- Applied with:  node scripts/db/apply-schema.mjs
--
-- ============================================================================
-- CANONICAL RECORD CONTRACT
-- ============================================================================
-- The store must round-trip the day-record shape used by the JSON archive
-- EXACTLY, because scripts/lib/label.mjs reads these fields directly and any
-- drift silently changes the scoring numbers.
--
-- Day record (all 877 files profiled 2026-08-08):
--   station      877/877  display name        -> stations.name
--   date         877/877  Denver calendar day -> station_days.local_date
--   fetched_at   877/877  ISO instant         -> station_days.fetched_at
--   status       877/877  ok | unobserved | no-data
--   cycle_type   877/877  free text, nullable -> see note below
--   point_count  877/877  integer             -> recomputed from observations
--   points       877/877  array               -> observations rows
--   mac          868/877  Ecowitt only        -> stations.ecowitt_mac
--   reason        59/877  seasonal-shutdown | unexplained  (null when status=ok)
--   holfuy_id      9/877  Holfuy only         -> stations.holfuy_id
--   slug           9/877  Holfuy only         -> stations.slug
--   lat/lon        9/877  Holfuy only         -> stations.lat / stations.lon
--
-- Source-conditional fields are the subtle part: an Ecowitt record has `mac`
-- and NO `holfuy_id`/`slug`/`lat`/`lon`; a Holfuy record is the reverse. The
-- store reconstructs them from the stations join and MUST omit (not null out)
-- the fields the source never had, or the parity checksum will fail.
--
-- Point record:
--   ts     87826  unix epoch SECONDS (integer on the way out, not Date/ISO)
--   speed  87826  mph, <=1 decimal, 0 .. 35.4
--   gust   87826  mph, <=1 decimal, 0 .. 89.2
--   dir    87826  degrees, integer, 0 .. 360
--   temp   87825  degF, <=1 decimal, -5.8 .. 100.9   (1 null observed)
--   rh     87825  percent, <=1 decimal, 3 .. 99      (1 null observed)
--   solar   6214  W/m2, integer, 0 .. 1087
--            ^ HOLFUY ONLY. Absent from all 81612 Ecowitt points. Absent and
--              null are DIFFERENT here and must not be conflated on read.
--
-- numeric(4,1) is used rather than real/double so values round-trip byte-exact.
-- Floats would reintroduce the precision drift the parity gate exists to catch.
--
-- cycle_type is free text, NOT an enum. Observed: 5min, 1min, 15min, 30min,
-- 240min, null. The 240min rows are days Ecowitt has ALREADY downsampled
-- (112 of them) and 30min covers 490 more — evidence the archive is actively
-- perishing. New values will appear; a CHECK constraint here would reject real
-- data, which is worse than accepting an unexpected label.
--
-- TIMEZONE (this is where the previously-shipped bug lived):
--   observations.ts          timestamptz — absolute instant, unambiguous
--   station_days.local_date  date        — America/Denver CALENDAR date
-- Group by (ts AT TIME ZONE 'America/Denver')::date, never ts::date.
-- Day bounds are half-open and DST-aware:
--   [ local_date::timestamp AT TIME ZONE 'America/Denver',
--     (local_date + 1)::timestamp AT TIME ZONE 'America/Denver' )
-- Never start + interval '24 hours' — DST days are 23 or 25 hours long.
-- ============================================================================

CREATE TABLE IF NOT EXISTS stations (
  slug         text PRIMARY KEY,
  name         text NOT NULL,
  source       text NOT NULL CHECK (source IN ('ecowitt', 'holfuy')),
  ecowitt_mac  text,
  holfuy_id    integer,
  lat          numeric(9,4),
  lon          numeric(9,4),
  -- A station carries exactly one source identity. This is what lets readDay()
  -- decide which optional fields to emit and which to omit.
  CONSTRAINT stations_source_identity CHECK (
    (source = 'ecowitt' AND ecowitt_mac IS NOT NULL AND holfuy_id IS NULL)
    OR
    (source = 'holfuy'  AND holfuy_id   IS NOT NULL AND ecowitt_mac IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS station_days (
  station_slug  text NOT NULL REFERENCES stations(slug) ON DELETE RESTRICT,
  local_date    date NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok', 'unobserved', 'no-data')),
  reason        text,
  cycle_type    text,
  point_count   integer NOT NULL DEFAULT 0 CHECK (point_count >= 0),
  fetched_at    timestamptz NOT NULL,
  PRIMARY KEY (station_slug, local_date),
  -- A non-ok day is an honest record of absence and must never carry points.
  -- This is the constraint that stops a winter shutdown being written as calm.
  CONSTRAINT station_days_absent_has_no_points CHECK (
    status = 'ok' OR point_count = 0
  )
);

CREATE TABLE IF NOT EXISTS observations (
  station_slug  text NOT NULL REFERENCES stations(slug) ON DELETE RESTRICT,
  ts            timestamptz NOT NULL,
  speed         numeric(4,1) NOT NULL,
  gust          numeric(4,1) NOT NULL,
  dir           integer      NOT NULL,
  temp          numeric(4,1),
  rh            numeric(4,1),
  solar         integer,
  PRIMARY KEY (station_slug, ts)
);

-- The archive is almost always queried as "this station, this local day" or as
-- a date range, so index the Denver-local date expression the consumers use.
CREATE INDEX IF NOT EXISTS observations_station_local_date_idx
  ON observations (station_slug, ((ts AT TIME ZONE 'America/Denver')::date));

CREATE INDEX IF NOT EXISTS station_days_local_date_idx
  ON station_days (local_date);

-- Station seed. Values taken from the archive itself, not retyped by hand.
-- Station rows are seeded by scripts/db/apply-schema.mjs from scripts/lib/stations.mjs.
-- The registry lives in code because resolving a station must not require a network call:
-- a database lookup before the local file write meant a Neon outage could cost a day that can
-- never be re-fetched. Keeping the seed here too would create a second copy that can drift.

-- ============================================================================
-- HRRR FORECAST ARCHIVE (§14)
-- ============================================================================
-- Night-before forecasts, keyed by the RUN THAT PRODUCED THEM. Storing run_init
-- is the whole point: §13 could not separate "the model was wrong" from "the
-- model was asked too early", and §14.3 could only settle it because the run is
-- explicit. A row without its init time is not worth writing.
--
-- This table stores model inputs, NOT a PACK/MAYBE/SLEEP IN verdict. Versioned, immutable issued
-- predictions live in night_before_predictions below.
--
-- Normal source: single-runs-api.open-meteo.com (models=gfs_hrrr), which serves the lid pinned to
-- an exact run. `source` remains explicit because an upstream outage may require recovery from the
-- authoritative NOAA GRIB without pretending the interpolation pipelines are identical.
--
-- A failed fetch must NEVER be written as a row. Per §4.2 absence of data is not
-- absence of wind, and a missing run must stay missing so a re-run retries it.
CREATE TABLE IF NOT EXISTS hrrr_forecasts (
  station_slug     text        NOT NULL REFERENCES stations(slug) ON DELETE RESTRICT,
  local_date       date        NOT NULL,  -- the MORNING being forecast (station-local)
  run_init         timestamptz NOT NULL,  -- model run init, UTC
  valid_hour_local integer     NOT NULL CHECK (valid_hour_local BETWEEN 0 AND 23),
  lid_m            numeric(7,1),          -- boundary_layer_height, metres
  wind_mph         numeric(5,1),          -- wind_speed_10m
  fetched_at       timestamptz NOT NULL,
  source           text        NOT NULL DEFAULT 'open-meteo-single-runs',
  PRIMARY KEY (station_slug, local_date, run_init, valid_hour_local)
);

ALTER TABLE hrrr_forecasts
  ADD COLUMN IF NOT EXISTS source text;
UPDATE hrrr_forecasts
  SET source = 'open-meteo-single-runs'
  WHERE source IS NULL;
ALTER TABLE hrrr_forecasts
  ALTER COLUMN source SET DEFAULT 'open-meteo-single-runs',
  ALTER COLUMN source SET NOT NULL;

CREATE INDEX IF NOT EXISTS hrrr_forecasts_date_idx
  ON hrrr_forecasts (station_slug, local_date);

-- ============================================================================
-- VERSIONED NIGHT-BEFORE PREDICTIONS
-- ============================================================================
-- The dashboard is a visualization, never the source of an issued call. Every call and percentage
-- is materialized here with the exact model version and HRRR run that produced it. Rows are
-- immutable: changed logic requires a new model_version rather than rewriting history.
CREATE TABLE IF NOT EXISTS night_before_models (
  model_version             text PRIMARY KEY,
  created_at                timestamptz NOT NULL,
  trained_through           date NOT NULL,
  training_size             integer NOT NULL CHECK (training_size > 0),
  training_positives        integer NOT NULL CHECK (
                              training_positives >= 0
                              AND training_positives <= training_size
                            ),
  target_threshold_mph      numeric(4,1) NOT NULL,
  target_sustained_minutes  integer NOT NULL CHECK (target_sustained_minutes > 0),
  target_description        text NOT NULL,
  status                    text NOT NULL,
  parameters                jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS night_before_predictions (
  station_slug           text NOT NULL REFERENCES stations(slug) ON DELETE RESTRICT,
  local_date             date NOT NULL,
  run_init               timestamptz NOT NULL,
  model_version          text NOT NULL REFERENCES night_before_models(model_version) ON DELETE RESTRICT,
  generation_mode        text NOT NULL CHECK (generation_mode IN ('forward', 'retrospective')),
  avg_wind_mph           numeric(7,3) NOT NULL,
  avg_lid_m              numeric(8,3) NOT NULL,
  forecast_hours         integer NOT NULL CHECK (forecast_hours >= 3),
  call                   text NOT NULL CHECK (call IN ('PACK', 'MAYBE', 'SLEEP IN')),
  call_reason            text NOT NULL,
  success_probability    double precision NOT NULL CHECK (
                           success_probability >= 0 AND success_probability <= 1
                         ),
  success_chance_percent integer NOT NULL CHECK (
                           success_chance_percent BETWEEN 5 AND 95
                           AND success_chance_percent % 5 = 0
                         ),
  generated_at           timestamptz NOT NULL,
  PRIMARY KEY (station_slug, local_date, run_init, model_version)
);

CREATE INDEX IF NOT EXISTS night_before_predictions_date_idx
  ON night_before_predictions (station_slug, local_date);
