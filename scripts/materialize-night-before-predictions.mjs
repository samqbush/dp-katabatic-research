#!/usr/bin/env node

/**
 * Materialize versioned calls and success chances from raw HRRR rows already in Neon.
 *
 * This is for historical/research backfill. The nightly collector writes new predictions in
 * `forward` mode at capture time.
 */

import { closePool, query } from './lib/db.mjs';
import { persistNightBeforePrediction } from './lib/night-before-prediction-store.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const from = arg('from');
const to = arg('to');
const params = ['dp-soda-lakes'];
const filters = ['station_slug = $1'];
if (from) {
  params.push(from);
  filters.push(`local_date >= $${params.length}`);
}
if (to) {
  params.push(to);
  filters.push(`local_date <= $${params.length}`);
}

const { rows } = await query(
  `SELECT
     station_slug,
     local_date::text AS local_date,
     run_init,
     avg(wind_mph) FILTER (
       WHERE wind_mph IS NOT NULL AND lid_m IS NOT NULL
     )::float8 AS avg_wind_mph,
     avg(lid_m) FILTER (
       WHERE wind_mph IS NOT NULL AND lid_m IS NOT NULL
     )::float8 AS avg_lid_m,
     count(*) FILTER (
       WHERE wind_mph IS NOT NULL AND lid_m IS NOT NULL
     )::int AS forecast_hours
   FROM hrrr_forecasts
   WHERE ${filters.join(' AND ')}
   GROUP BY station_slug, local_date, run_init
   ORDER BY local_date, run_init`,
  params,
);

let written = 0;
let unscored = 0;
for (const row of rows) {
  const prediction = await persistNightBeforePrediction({
    stationSlug: row.station_slug,
    localDate: row.local_date,
    runInit: new Date(row.run_init).toISOString(),
    generationMode: 'retrospective',
    forecast: {
      avgWindMph: row.avg_wind_mph,
      avgLidM: row.avg_lid_m,
      forecastHours: row.forecast_hours,
    },
  });
  if (prediction) written++;
  else unscored++;
}

console.log(
  `Materialized ${written} retrospective prediction(s); ${unscored} incomplete forecast(s) left unscored.`,
);
await closePool();
