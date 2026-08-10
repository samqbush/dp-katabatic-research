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

import axios from 'axios';
import { query, closePool } from './lib/db.mjs';

const SITE = { lat: 39.646115, lon: -105.174958 }; // true meter coordinate (§12.2)
const SLUG = 'dp-soda-lakes';
const API = 'https://single-runs-api.open-meteo.com/v1/forecast';
const WINDOW_HOURS = [5, 6, 7, 8];
const MAX_ATTEMPTS = 4;

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

/**
 * Fetch one morning. Retries transient failures; a genuinely unavailable run returns null so the
 * caller writes NOTHING. Per §4.2 a missing run must stay missing rather than be recorded as calm.
 */
async function fetchMorning(date) {
  const run = `${date}T00:00`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get(API, {
        params: {
          latitude: SITE.lat, longitude: SITE.lon,
          hourly: 'boundary_layer_height,wind_speed_10m',
          models: 'gfs_hrrr', run,
          timezone: 'America/Denver', wind_speed_unit: 'mph',
        },
        timeout: 60000,
      });
      const h = res.data.hourly;
      const rows = [];
      for (let i = 0; i < h.time.length; i++) {
        const [d, t] = h.time[i].split('T');
        if (d !== date) continue;
        const hr = parseInt(t.slice(0, 2), 10);
        if (!WINDOW_HOURS.includes(hr)) continue;
        const lid = h.boundary_layer_height[i];
        const wind = h.wind_speed_10m[i];
        if (!Number.isFinite(lid) && !Number.isFinite(wind)) continue;
        rows.push({ hr, lid, wind });
      }
      return rows.length ? rows : null;
    } catch (e) {
      const reason = e.response?.data?.reason || e.message;
      // A run that does not exist will never exist. Retrying it is pointless.
      if (/not available/i.test(reason)) {
        console.log(`  ${date}: run unavailable — nothing written`);
        return null;
      }
      if (attempt === MAX_ATTEMPTS) {
        console.log(`  ${date}: failed after ${MAX_ATTEMPTS} attempts (${reason}) — nothing written`);
        return null;
      }
      // The 00Z run publishes ~00:50Z; firing early is the expected failure, so back off properly.
      const wait = 30000 * attempt;
      console.log(`  ${date}: attempt ${attempt} failed (${reason}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  return null;
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
         SET lid_m = EXCLUDED.lid_m,
             wind_mph = EXCLUDED.wind_mph,
             fetched_at = EXCLUDED.fetched_at`,
      [SLUG, date, runInit, r.hr,
       Number.isFinite(r.lid) ? r.lid : null,
       Number.isFinite(r.wind) ? r.wind : null,
       fetchedAt],
    );
  }
}

/* ---------------------------------------------------------------------- main */

const from = arg('from');
const to = arg('to');
const one = arg('date');

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

let written = 0, skipped = 0;
for (const date of targets) {
  const rows = await fetchMorning(date);
  if (!rows) { skipped++; continue; }
  await store(date, rows);
  written++;
  const lid = rows.map((r) => (Number.isFinite(r.lid) ? r.lid.toFixed(0) : '—')).join('/');
  console.log(`  ${date}: ${rows.length} hours, lid ${lid} m`);
  if (targets.length > 1) await sleep(220);
}

const { rows: total } = await query(
  'SELECT count(*)::int AS n, count(DISTINCT local_date)::int AS days FROM hrrr_forecasts WHERE station_slug = $1',
  [SLUG],
);
console.log(`\nwritten ${written}, skipped ${skipped}`);
console.log(`archive now holds ${total[0].n} rows across ${total[0].days} mornings`);

await closePool();

// A run that captures nothing must FAIL, not pass quietly. Per §4.2 a morning that is not
// captured is gone for good, so a silently green no-op is the worst possible outcome: it looks
// like the archive is accruing when it is not, and the gap is only discovered a season later.
if (written === 0) {
  console.error(
    '\n❌ Nothing was captured. This is a failure, not a quiet skip — the morning is unrecoverable.\n' +
    '   If this fired before the 00Z run published (~00:50 UTC), re-run it; otherwise investigate.',
  );
  process.exit(1);
}
