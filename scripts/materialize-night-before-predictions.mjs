#!/usr/bin/env node

/**
 * Materialize versioned calls and success chances from raw HRRR rows already in Neon.
 *
 * This is for historical/research backfill. The nightly collector writes new predictions in
 * `forward` mode at capture time.
 */

import { closePool, query } from './lib/db.mjs';
import {
  EXPERIMENTAL_PROBABILITY_MODEL_V1,
  EXPERIMENTAL_PROBABILITY_MODEL_V2,
  summarizeGateAlignedForecastRows,
} from './lib/night-before-call.mjs';
import {
  findNightBeforePrediction,
  persistNightBeforePrediction,
} from './lib/night-before-prediction-store.mjs';

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
  `WITH selected_forecasts AS (
     SELECT
       station_slug,
       local_date,
       run_init,
       valid_hour_local AS hr,
       wind_mph AS wind,
       lid_m AS lid
     FROM hrrr_forecasts
     WHERE ${filters.join(' AND ')}
       AND run_init = (local_date::timestamp AT TIME ZONE 'UTC')
   ),
   legacy_summaries AS (
     SELECT
       station_slug,
       local_date,
       run_init,
       avg(wind) FILTER (
         WHERE hr BETWEEN 5 AND 8 AND wind IS NOT NULL AND lid IS NOT NULL
       )::float8 AS legacy_avg_wind_mph,
       avg(lid) FILTER (
         WHERE hr BETWEEN 5 AND 8 AND wind IS NOT NULL AND lid IS NOT NULL
       )::float8 AS legacy_avg_lid_m,
       count(*) FILTER (
         WHERE hr BETWEEN 5 AND 8 AND wind IS NOT NULL AND lid IS NOT NULL
       )::int AS legacy_forecast_hours
     FROM selected_forecasts
     GROUP BY station_slug, local_date, run_init
   )
   SELECT
     f.station_slug,
     f.local_date::text AS local_date,
     f.run_init,
     f.hr,
     f.wind,
     f.lid,
     s.legacy_avg_wind_mph,
     s.legacy_avg_lid_m,
     s.legacy_forecast_hours
   FROM selected_forecasts f
   JOIN legacy_summaries s USING (station_slug, local_date, run_init)
   ORDER BY f.local_date, f.run_init, f.hr`,
  params,
);

const forecasts = new Map();
for (const row of rows) {
  const key = `${row.local_date}|${new Date(row.run_init).toISOString()}`;
  if (!forecasts.has(key)) {
    forecasts.set(key, {
      stationSlug: row.station_slug,
      localDate: row.local_date,
      runInit: new Date(row.run_init).toISOString(),
      legacyForecast: {
        avgWindMph: row.legacy_avg_wind_mph,
        avgLidM: row.legacy_avg_lid_m,
        forecastHours: row.legacy_forecast_hours,
      },
      rows: [],
    });
  }
  forecasts.get(key).rows.push(row);
}

let legacyWritten = 0;
let candidateWritten = 0;
let unscored = 0;
for (const forecast of forecasts.values()) {
  const legacyExisting = await findNightBeforePrediction({
    stationSlug: forecast.stationSlug,
    localDate: forecast.localDate,
    runInit: forecast.runInit,
    modelVersion: EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion,
  });
  if (legacyExisting) {
    legacyWritten++;
  } else {
    const legacy = await persistNightBeforePrediction({
      stationSlug: forecast.stationSlug,
      localDate: forecast.localDate,
      runInit: forecast.runInit,
      generationMode: 'retrospective',
      forecast: forecast.legacyForecast,
      model: EXPERIMENTAL_PROBABILITY_MODEL_V1,
    });
    if (legacy) legacyWritten++;
    else unscored++;
  }

  const month = Number(forecast.localDate.slice(5, 7));
  if (
    month >= 3
    && month <= 10
    && forecast.localDate > EXPERIMENTAL_PROBABILITY_MODEL_V2.trainedThrough
    && forecast.localDate <= '2026-10-31'
  ) {
    const candidateForecast = summarizeGateAlignedForecastRows(
      forecast.rows,
      forecast.localDate,
    );
    if (candidateForecast?.forecastHours >= 3) {
      const candidateExisting = await findNightBeforePrediction({
        stationSlug: forecast.stationSlug,
        localDate: forecast.localDate,
        runInit: forecast.runInit,
        modelVersion: EXPERIMENTAL_PROBABILITY_MODEL_V2.modelVersion,
      });
      if (candidateExisting) {
        candidateWritten++;
      } else {
        const candidate = await persistNightBeforePrediction({
          ...forecast,
          generationMode: 'retrospective',
          forecast: candidateForecast,
          model: EXPERIMENTAL_PROBABILITY_MODEL_V2,
        });
        if (candidate) candidateWritten++;
      }
    }
  }
}

console.log(
  `Materialized ${legacyWritten} v1 prediction(s) and ${candidateWritten} ` +
  `gate-aligned v2 holdout prediction(s); ${unscored} incomplete v1 forecast(s) left unscored.`,
);
await closePool();
