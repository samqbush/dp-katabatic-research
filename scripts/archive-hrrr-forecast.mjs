#!/usr/bin/env node

/**
 * Forward HRRR forecast collector (§13.7, §14.4).
 *
 * Captures the night-before HRRR forecast for a morning, pinned to the run that produced it, and
 * writes it to Neon. This is the item §13.7 called the highest-value open work — it accrues only
 * in calendar time, so it is worth running every night regardless of what the current analysis
 * says.
 *
 * §14 changed how this is done but not whether it is worth doing:
 *   - §13.2 thought the lid was unavailable as a day-ahead forecast. It is available from
 *     single-runs-api by exact run (§14.1), so this needs no GRIB pipeline.
 *   - §14.3 showed forecast lead time is NOT what limits this problem (ROC-AUC flat 0.651->0.685
 *     across 11-35 h), so there is no reason to chase ever-fresher runs.
 *
 * Run mapping: run `<D>T00:00` is 00Z on D, which begins at local 18:00 on D-1. The morning of D
 * at local 05-08 is therefore f11-f14 — the forecast actually in hand at an 8 p.m. decision.
 *
 * Usage:
 *   node scripts/archive-hrrr-forecast.mjs                 # tomorrow's morning (nightly default)
 *   node scripts/archive-hrrr-forecast.mjs --date 2026-08-10
 *   node scripts/archive-hrrr-forecast.mjs --from 2026-04-02 --to 2026-08-10   # backfill
 */

import { query, closePool } from './lib/db.mjs';
import { collectHrrrMorning, fetchHrrrMorning } from './lib/hrrr-forecast.mjs';
import {
  findNightBeforePrediction,
  persistNightBeforePrediction,
  summarizeForecastRows,
} from './lib/night-before-prediction-store.mjs';

const SLUG = 'dp-soda-lakes';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
}

/** Station-local (America/Denver) calendar date, offset by `days`. Never the laptop's zone. */
function localDate(days = 0) {
  const now = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function shift(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function store(date, rows) {
  const runInit = `${date}T00:00:00Z`;
  const fetchedAt = new Date().toISOString();
  for (const r of rows) {
    await query(
      `INSERT INTO hrrr_forecasts
         (station_slug, local_date, run_init, valid_hour_local, lid_m, wind_mph, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (station_slug, local_date, run_init, valid_hour_local) DO UPDATE
           SET lid_m = COALESCE(hrrr_forecasts.lid_m, EXCLUDED.lid_m),
               wind_mph = COALESCE(hrrr_forecasts.wind_mph, EXCLUDED.wind_mph),
               fetched_at = EXCLUDED.fetched_at
         WHERE hrrr_forecasts.lid_m IS NULL OR hrrr_forecasts.wind_mph IS NULL`,
      [SLUG, date, runInit, r.hr,
       Number.isFinite(r.lid) ? r.lid : null,
       Number.isFinite(r.wind) ? r.wind : null,
       fetchedAt],
    );
  }
}

async function loadStored(date) {
  const runInit = `${date}T00:00:00Z`;
  const { rows } = await query(
    `SELECT valid_hour_local AS hr, lid_m AS lid, wind_mph AS wind
     FROM hrrr_forecasts
     WHERE station_slug = $1
       AND local_date = $2
       AND run_init = $3
       AND lid_m IS NOT NULL
       AND wind_mph IS NOT NULL
     ORDER BY valid_hour_local`,
    [SLUG, date, runInit],
  );
  return rows;
}

/* ---------------------------------------------------------------------- main */

const from = arg('from');
const to = arg('to');
const one = arg('date');
const requestedMode = arg('mode');
const generationMode = requestedMode || (from && to ? 'retrospective' : 'forward');
if (!['forward', 'retrospective'].includes(generationMode)) {
  throw new Error('--mode must be "forward" or "retrospective"');
}

let targets;
if (from && to) {
  targets = [];
  for (let d = from; d <= to; d = shift(d, 1)) targets.push(d);
} else if (one) {
  targets = [one];
} else {
  // Nightly default: the morning that the run just published is forecasting.
  targets = [localDate(1)];
}

console.log(`HRRR forecast collector — ${targets.length} morning(s), station ${SLUG}`);

let written = 0, alreadyIssued = 0, skipped = 0;
for (const date of targets) {
  const runInit = `${date}T00:00:00Z`;
  const result = await collectHrrrMorning({
    date,
    generationMode,
    findIssuedPrediction: () => findNightBeforePrediction({
      stationSlug: SLUG,
      localDate: date,
      runInit,
    }),
    loadStoredRows: () => loadStored(date),
    storeRows: (rows) => store(date, rows),
    persistRows: (rows) => persistNightBeforePrediction({
      stationSlug: SLUG,
      localDate: date,
      runInit,
      generationMode,
      forecast: summarizeForecastRows(rows),
    }),
    fetchMorning: fetchHrrrMorning,
  });

  if (result.status === 'already-issued') {
    alreadyIssued++;
    console.log(
      `  ${date}: prediction already issued (${result.prediction.model_version}) — no-op`,
    );
    continue;
  }
  if (result.status === 'unresolved') {
    skipped++;
    continue;
  }

  const { rows, prediction } = result;
  written++;
  const lid = rows.map((r) => (Number.isFinite(r.lid) ? r.lid.toFixed(0) : '—')).join('/');
  console.log(`  ${date}: ${rows.length} hours, lid ${lid} m`);
  console.log(
    `             ${prediction.call}, ${prediction.success_chance_percent}% success ` +
    `(${prediction.model_version}, ${prediction.generation_mode}, ${result.source})`,
  );
  if (targets.length > 1) await sleep(220);
}

const { rows: total } = await query(
  'SELECT count(*)::int AS n, count(DISTINCT local_date)::int AS days FROM hrrr_forecasts WHERE station_slug = $1',
  [SLUG],
);
console.log(`\nwritten ${written}, already issued ${alreadyIssued}, skipped ${skipped}`);
console.log(`archive now holds ${total[0].n} rows across ${total[0].days} mornings`);

await closePool();

// A run that captures nothing must FAIL, not pass quietly. Per §4.2 a morning that is not
// captured is gone for good, so a silently green no-op is the worst possible outcome: it looks
// like the archive is accruing when it is not, and the gap is only discovered a season later.
if (written === 0 && alreadyIssued === 0) {
  console.error(
    '\n❌ No usable 00Z snapshot was captured or already issued.\n' +
    '   Keep this run red; the later recovery schedule may still capture it before the outcome.',
  );
  process.exit(1);
}
