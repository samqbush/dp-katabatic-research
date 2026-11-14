#!/usr/bin/env node

/**
 * Fill newly added 09:00-11:00 HRRR hours for dates already in the forecast archive.
 * Existing non-null forecast values are immutable; this only inserts missing hours or fills
 * previously null values. It never creates or changes a night-before prediction.
 *
 * Usage:
 *   node scripts/backfill-hrrr-forecast-hours.mjs
 *   node scripts/backfill-hrrr-forecast-hours.mjs --from 2026-04-02 --to 2026-11-14
 */

import { closePool, query } from './lib/db.mjs';
import { fetchHrrrMorning, HRRR_CAPTURE_HOURS } from './lib/hrrr-forecast.mjs';

const STATION = 'dp-soda-lakes';
const ADDED_HOURS = HRRR_CAPTURE_HOURS.filter((hour) => hour > 8);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

function validateDate(value, name) {
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${name} must be YYYY-MM-DD`);
  }
}

const from = arg('from');
const to = arg('to');
validateDate(from, 'from');
validateDate(to, 'to');
if (from && to && from > to) throw new Error('--from must be on or before --to');

async function storeAddedHours(date, rows) {
  const added = rows.filter((row) => ADDED_HOURS.includes(row.hr));
  const fetchedAt = new Date().toISOString();
  const completed = [];
  for (const row of added) {
    const result = await query(
      `INSERT INTO hrrr_forecasts
        (station_slug, local_date, run_init, valid_hour_local, lid_m, wind_mph, fetched_at, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'open-meteo-single-runs')
      ON CONFLICT (station_slug, local_date, run_init, valid_hour_local) DO UPDATE
        SET lid_m = COALESCE(hrrr_forecasts.lid_m, EXCLUDED.lid_m),
            wind_mph = COALESCE(hrrr_forecasts.wind_mph, EXCLUDED.wind_mph),
            fetched_at = EXCLUDED.fetched_at
      WHERE hrrr_forecasts.lid_m IS NULL OR hrrr_forecasts.wind_mph IS NULL
      RETURNING valid_hour_local, lid_m, wind_mph`,
      [
        STATION,
        date,
        `${date}T00:00:00Z`,
        row.hr,
        row.lid,
        row.wind,
        fetchedAt,
      ],
    );
    if (result.rows[0]?.lid_m != null && result.rows[0]?.wind_mph != null) {
      completed.push(result.rows[0].valid_hour_local);
    }
  }
  return completed;
}

const params = [STATION];
const filters = ['station_slug = $1'];
if (from) {
  params.push(from);
  filters.push(`local_date >= $${params.length}`);
}
if (to) {
  params.push(to);
  filters.push(`local_date <= $${params.length}`);
}

try {
  const { rows: targets } = await query(
    `SELECT local_date::text AS date,
       array_agg(valid_hour_local) FILTER (
         WHERE valid_hour_local = ANY($${params.length + 1}::int[])
           AND lid_m IS NOT NULL AND wind_mph IS NOT NULL
       ) AS complete_hours
     FROM hrrr_forecasts
     WHERE ${filters.join(' AND ')}
       AND run_init = (local_date::timestamp AT TIME ZONE 'UTC')
     GROUP BY local_date
     HAVING count(DISTINCT valid_hour_local) FILTER (
       WHERE valid_hour_local = ANY($${params.length + 1}::int[])
         AND lid_m IS NOT NULL AND wind_mph IS NOT NULL
     ) < $${params.length + 2}
     ORDER BY local_date`,
    [...params, ADDED_HOURS, ADDED_HOURS.length],
  );

  console.log(`HRRR extended-hours backfill — ${targets.length} date(s)`);
  let completed = 0;
  let incomplete = 0;
  for (const { date, complete_hours: completeHours } of targets) {
    const result = await fetchHrrrMorning(date, {
      maxAttempts: 2,
      retryBaseMs: 5_000,
      log: console.log,
      minimumUsableHours: 1,
    });
    const added = result.rows?.filter((row) => ADDED_HOURS.includes(row.hr)) ?? [];
    const newlyComplete = await storeAddedHours(date, added);
    const covered = new Set([...(completeHours ?? []), ...newlyComplete]);
    if (!ADDED_HOURS.every((hour) => covered.has(hour))) {
      incomplete++;
      console.error(`  ${date}: ${covered.size}/${ADDED_HOURS.length} added hours available; retry needed`);
      continue;
    }

    completed++;
    console.log(`  ${date}: stored ${added.length} extended hours`);
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  const { rows: coverage } = await query(
    `SELECT count(DISTINCT local_date)::int AS days,
            count(*) FILTER (
              WHERE valid_hour_local = ANY($2::int[])
                AND lid_m IS NOT NULL AND wind_mph IS NOT NULL
            )::int AS complete_added_hours
     FROM hrrr_forecasts
     WHERE station_slug = $1
       AND run_init = (local_date::timestamp AT TIME ZONE 'UTC')`,
    [STATION, ADDED_HOURS],
  );
  console.log(
    `Backfill complete: ${completed} updated, ${incomplete} incomplete; ` +
    `${coverage[0].complete_added_hours} complete 09:00-11:00 rows across ` +
    `${coverage[0].days} forecast dates.`,
  );
  if (incomplete > 0) process.exitCode = 1;
} finally {
  await closePool();
}
