#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * Answers the single biggest outstanding caveat in the research (§10.5 caveat 1 / §12.7 item 1):
 *
 *   Every HRRR number in §10 and §11 was computed from the FRESHEST forecast Open-Meteo had for
 *   each hour, which for a 6am target may have been issued only an hour or two earlier. A real
 *   night-before call is made the evening before. If the model only knows about a morning once
 *   that morning is nearly here, the whole "pack the car tonight" product is an illusion.
 *
 * Open-Meteo exposes `<var>_previous_day1`: the value for the same hour as forecast by the run
 * issued a day earlier. For a 6am target that is a ~24-30h lead — LONGER than a real 8pm call,
 * so it is a conservative lower bound. If the signal survives at day-1 it will do better at 8pm.
 *
 * Three questions, in priority order:
 *   1. Does the forecast WIND signal (§10.3) survive being pinned to a day-old run?
 *   2. The lid (§11.1) is the strongest signal but CANNOT be pinned — Open-Meteo returns nulls
 *      for boundary_layer_height_previous_day1 everywhere. Can a pinnable surface proxy
 *      (radiative-cooling ingredients: cloud, humidity, temperature drop) stand in for it?
 *   3. Is 800mb a better "just above the inversion" level than 700mb (§12.5)?
 *
 * The §11.4 baseline is recomputed first and MUST reproduce the recorded 57/39/9 table. Per §9.1
 * the numbers already in the research doc are a regression test; a mismatch is a bug, not news.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';

// The true meter coordinate (§12.2), not SUNRISE_COORDS. Verified 2026-08-10 to snap to the
// same HRRR grid cell as the old constant, so this changes nothing — but it removes the
// unverified-offset caveat in §12.4 rather than leaving it to be re-litigated.
const SITE = { lat: 39.646115, lon: -105.174958 };
const SLUG = 'dp-soda-lakes';

const FRESH = [
  'wind_speed_10m',
  'boundary_layer_height',
  'temperature_2m',
  'wind_speed_800hPa',
  'wind_speed_700hPa',
];

const PINNED = [
  'wind_speed_10m_previous_day1',
  'temperature_2m_previous_day1',
  'cloud_cover_previous_day1',
  'relative_humidity_2m_previous_day1',
  'dew_point_2m_previous_day1',
  'surface_pressure_previous_day1',
];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

function shiftIso(iso, days) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ labels */

const days = await readDays(SLUG, {});
const label = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) label.set(day.date, r.label);
}
await closePool();
const dates = [...label.keys()].sort();
console.log(`Labelable mornings in archive: ${dates.length} (${dates[0]} .. ${dates[dates.length - 1]})`);

/* ------------------------------------------------------------------ fetch */

// Keyed by date -> { morning: {var: [values 05-08]}, evening: {var: [values 18-23 prev day]} }
const store = new Map();
const touch = (d) => {
  if (!store.has(d)) store.set(d, { morning: {}, evening: {} });
  return store.get(d);
};

async function pull(vars) {
  let cursor = shiftIso(dates[0], -1);
  const last = dates[dates.length - 1];
  while (cursor <= last) {
    let end = shiftIso(cursor, 120);
    if (end > last) end = last;
    const res = await axios.get('https://historical-forecast-api.open-meteo.com/v1/forecast', {
      params: {
        latitude: SITE.lat,
        longitude: SITE.lon,
        start_date: cursor,
        end_date: end,
        hourly: vars.join(','),
        models: 'gfs_hrrr',
        timezone: 'America/Denver',
        wind_speed_unit: 'mph',
        temperature_unit: 'fahrenheit',
      },
      timeout: 240000,
    });
    const h = res.data.hourly;
    for (let i = 0; i < h.time.length; i++) {
      const [d, t] = h.time[i].split('T');
      const hr = parseInt(t.slice(0, 2), 10);
      // Morning session window, attributed to the day itself.
      if (hr >= 5 && hr <= 8) {
        const b = touch(d).morning;
        for (const v of vars) (b[v] ??= []).push(h[v][i]);
      }
      // Evening-before window, attributed to the FOLLOWING morning — this is what is known at
      // the moment the "do I pack the car" decision is actually made.
      if (hr >= 18 && hr <= 23) {
        const b = touch(shiftIso(d, 1)).evening;
        for (const v of vars) (b[v] ??= []).push(h[v][i]);
      }
    }
    if (end === last) break;
    cursor = shiftIso(end, 1);
  }
}

console.log('Fetching fresh (as-used-in-§11) fields...');
await pull(FRESH);
console.log('Fetching pinned day-ahead fields...');
await pull(PINNED);

/* ------------------------------------------------------------------ rows */

const rows = [];
for (const d of dates) {
  const s = store.get(d);
  if (!s) continue;
  const m = s.morning;
  const e = s.evening;
  const get = (bag, v) => (bag[v]?.length >= 3 ? mean(bag[v]) : NaN);

  const row = {
    date: d,
    rideable: label.get(d),
    // fresh, exactly as §11 used them
    windFresh: get(m, 'wind_speed_10m'),
    lidFresh: get(m, 'boundary_layer_height'),
    aloft700: get(m, 'wind_speed_700hPa'),
    aloft800: get(m, 'wind_speed_800hPa'),
    // pinned to a day-old run — a real night-before call
    windPinned: get(m, 'wind_speed_10m_previous_day1'),
    // radiative-cooling ingredients known the evening before, from the day-old run
    eveCloud: get(e, 'cloud_cover_previous_day1'),
    eveRh: get(e, 'relative_humidity_2m_previous_day1'),
    eveTemp: get(e, 'temperature_2m_previous_day1'),
    eveDew: get(e, 'dew_point_2m_previous_day1'),
    evePres: get(e, 'surface_pressure_previous_day1'),
    mornTempPinned: get(m, 'temperature_2m_previous_day1'),
  };
  row.coolPinned = row.eveTemp - row.mornTempPinned;
  row.eveSpread = row.eveTemp - row.eveDew;
  rows.push(row);
}

const usable = rows.filter((r) => Number.isFinite(r.windFresh) && Number.isFinite(r.lidFresh));
const pinnedRows = rows.filter((r) => Number.isFinite(r.windPinned) && Number.isFinite(r.coolPinned) && Number.isFinite(r.eveCloud));

const rate = (g) => (g.length ? (g.filter((r) => r.rideable).length / g.length) * 100 : NaN);

console.log(`\nRows with fresh fields:  ${usable.length}  (rideable ${usable.filter((r) => r.rideable).length}, ${rate(usable).toFixed(0)}%)`);
console.log(`Rows with pinned fields: ${pinnedRows.length}  (rideable ${pinnedRows.filter((r) => r.rideable).length}, ${rate(pinnedRows).toFixed(0)}%)`);

/* ------------------------------------ 1. REGRESSION: reproduce §11.4 baseline */

function packCall(wind, lid) {
  if (wind >= 9 && lid < 250) return 'PACK';
  if (wind < 5 && lid >= 250) return 'SLEEP IN';
  if (wind < 6 && lid >= 100) return 'SLEEP IN';
  return 'MAYBE';
}

console.log('\n================ 1. REGRESSION CHECK vs §11.4 (fresh forecast) ================');
console.log('Expected from the research doc: PACK 57% (n=42) / MAYBE 39% (n=153) / SLEEP IN 9% (n=125)\n');
console.log('call        nights   rideable   rate');
for (const c of ['PACK', 'MAYBE', 'SLEEP IN']) {
  const g = usable.filter((r) => packCall(r.windFresh, r.lidFresh) === c);
  console.log(`${c.padEnd(9)}   ${String(g.length).padStart(6)}   ${String(g.filter((r) => r.rideable).length).padStart(8)}   ${rate(g).toFixed(0).padStart(4)}%`);
}

/* ------------------------------------ 2. Does the WIND signal survive pinning? */

console.log('\n================ 2. FORECAST WIND: fresh vs pinned day-ahead ================');
console.log('§10.3 recorded, from the FRESH forecast: 0-6 band 17%, 18+ band 100%.\n');
const windBands = [[0, 6], [6, 9], [9, 12], [12, 15], [15, 18], [18, 999]];
console.log('HRRR morning wind    fresh forecast        pinned day-ahead');
console.log('-------------------  --------------------  --------------------');
for (const [lo, hi] of windBands) {
  const f = pinnedRows.filter((r) => r.windFresh >= lo && r.windFresh < hi);
  const p = pinnedRows.filter((r) => r.windPinned >= lo && r.windPinned < hi);
  const lbl = hi === 999 ? `${lo}+ mph` : `${lo}-${hi} mph`;
  const fmt = (g) => (g.length ? `${rate(g).toFixed(0).padStart(3)}%  (n=${String(g.length).padStart(3)})` : '      -      ');
  console.log(`${lbl.padEnd(19)}  ${fmt(f).padEnd(20)}  ${fmt(p)}`);
}

// How badly does the day-old run miss the actual forecast it later produces?
const bothWind = pinnedRows.filter((r) => Number.isFinite(r.windFresh));
const absErr = bothWind.map((r) => Math.abs(r.windFresh - r.windPinned)).sort((a, b) => a - b);
console.log(`\nDisagreement between the day-old run and the fresh run (same hours, same cell):`);
console.log(`  median ${absErr[Math.floor(absErr.length / 2)].toFixed(1)} mph, 75th ${absErr[Math.floor(absErr.length * 0.75)].toFixed(1)} mph, max ${absErr[absErr.length - 1].toFixed(1)} mph`);

/* ------------------------------------ 3. 800mb vs 700mb */

console.log('\n================ 3. WIND ALOFT: 800mb vs 700mb (§12.5) ================');
console.log('§11.2 found wind aloft at 700mb is NOT a positive signal. Does 800mb differ?\n');
const aloftBands = [[0, 10], [10, 20], [20, 30], [30, 999]];
console.log('wind aloft           800mb (~2035m)        700mb (~3100m)');
console.log('-------------------  --------------------  --------------------');
for (const [lo, hi] of aloftBands) {
  const a8 = usable.filter((r) => r.aloft800 >= lo && r.aloft800 < hi);
  const a7 = usable.filter((r) => r.aloft700 >= lo && r.aloft700 < hi);
  const lbl = hi === 999 ? `${lo}+ mph` : `${lo}-${hi} mph`;
  const fmt = (g) => (g.length ? `${rate(g).toFixed(0).padStart(3)}%  (n=${String(g.length).padStart(3)})` : '      -      ');
  console.log(`${lbl.padEnd(19)}  ${fmt(a8).padEnd(20)}  ${fmt(a7)}`);
}

/* ------------------------------------ 4. A pinnable stand-in for the lid */

console.log('\n================ 4. CAN A PINNABLE PROXY REPLACE THE LID? ================');
console.log('boundary_layer_height_previous_day1 is null across the whole archive, so the');
console.log('strongest signal in §11 is NOT available the night before. Testing surface');
console.log('ingredients that ARE available, one at a time.\n');

function bandReport(name, key, bands, unit) {
  console.log(`${name}`);
  for (const [lo, hi] of bands) {
    const g = pinnedRows.filter((r) => r[key] >= lo && r[key] < hi);
    const lbl = hi === 9999 ? `  ${lo}+ ${unit}` : `  ${lo}-${hi} ${unit}`;
    if (!g.length) continue;
    console.log(`${lbl.padEnd(22)} n=${String(g.length).padStart(3)}   ${rate(g).toFixed(0).padStart(3)}%`);
  }
  console.log('');
}

bandReport('Evening cloud cover (clear sky drives radiative cooling)', 'eveCloud', [[0, 15], [15, 40], [40, 70], [70, 101]], '%');
bandReport('Forecast overnight cooling, evening -> morning', 'coolPinned', [[-99, 5], [5, 10], [10, 15], [15, 9999]], 'F');
bandReport('Evening dewpoint spread (dry air radiates better)', 'eveSpread', [[0, 15], [15, 25], [25, 35], [35, 9999]], 'F');
bandReport('Evening relative humidity', 'eveRh', [[0, 25], [25, 40], [40, 60], [60, 101]], '%');

/* ------------------------------------ 4b. Attribution: which loss costs what? */

console.log('================ 4b. ATTRIBUTING THE DAMAGE ================');
console.log('A real night-before call loses TWO things at once: forecast freshness AND the lid.');
console.log('Scoring the middle case isolates them.\n');

const both = rows.filter((r) => [r.windFresh, r.lidFresh, r.windPinned].every(Number.isFinite));
const bothRide = both.filter((r) => r.rideable).length;
for (const [name, fn] of [
  ['FRESH wind + FRESH lid  (what §11.4 actually measured)', (r) => packCall(r.windFresh, r.lidFresh)],
  ['PINNED wind + FRESH lid (lid magically still available)', (r) => packCall(r.windPinned, r.lidFresh)],
]) {
  console.log(name);
  for (const c of ['PACK', 'MAYBE', 'SLEEP IN']) {
    const g = both.filter((r) => fn(r) === c);
    if (!g.length) continue;
    const w = g.filter((r) => r.rideable).length;
    console.log(`  ${c.padEnd(9)} n=${String(g.length).padStart(3)}  rideable=${String(w).padStart(3)}  ${rate(g).toFixed(0).padStart(3)}%  share of sessions=${((w / bothRide) * 100).toFixed(0)}%`);
  }
  console.log('');
}

/* ------------------------------------ 5. The night-before call, fully pinned */

console.log('================ 5. A FULLY-PINNED NIGHT-BEFORE CALL ================');
console.log('Everything below is knowable the evening before from a day-old model run.\n');

// Deliberately simple and shaped like §11.4: a wind term and a "is the lid likely to form" term.
// Kept to two thresholds so it cannot quietly become a fitted model on 95 positives (§4.7).
function pinnedCall(r) {
  const coldPool = r.eveCloud < 40 && r.coolPinned >= 10;
  if (r.windPinned >= 9 && coldPool) return 'PACK';
  if (r.windPinned < 5 && !coldPool) return 'SLEEP IN';
  if (r.windPinned < 6 && r.eveCloud >= 40) return 'SLEEP IN';
  return 'MAYBE';
}

const totalRide = pinnedRows.filter((r) => r.rideable).length;
console.log('call        nights   rideable   rate    share of all sessions');
console.log('---------   ------   --------   -----   ---------------------');
for (const c of ['PACK', 'MAYBE', 'SLEEP IN']) {
  const g = pinnedRows.filter((r) => pinnedCall(r) === c);
  if (!g.length) continue;
  const w = g.filter((r) => r.rideable).length;
  console.log(`${c.padEnd(9)}   ${String(g.length).padStart(6)}   ${String(w).padStart(8)}   ${rate(g).toFixed(0).padStart(4)}%   ${((w / totalRide) * 100).toFixed(0).padStart(19)}%`);
}

const sleep = pinnedRows.filter((r) => pinnedCall(r) === 'SLEEP IN');
console.log(`\nSkipping only SLEEP IN nights: sleep through ${sleep.length}/${pinnedRows.length} mornings (${((sleep.length / pinnedRows.length) * 7).toFixed(1)} nights/week),`);
console.log(`  cost ${sleep.filter((r) => r.rideable).length} of ${totalRide} sessions (${((sleep.filter((r) => r.rideable).length / totalRide) * 100).toFixed(0)}%).`);

/* ------------------------------------ 6. Restricted to the real season */

console.log('\n================ 6. THE SAME CALL, MAIN SEASON ONLY ================');
console.log('The user does not dawn patrol Nov-Feb: too cold to be fun regardless of wind, and');
console.log('the gate opens at 8am. The real season is the months the gate opens at 6 or 7am,');
console.log('i.e. Mar-Oct. Every number above is diluted by months he will not ride.\n');

const inSeason = (r) => {
  const m = parseInt(r.date.slice(5, 7), 10);
  return m >= 3 && m <= 10;
};
const seasonRows = pinnedRows.filter(inSeason);
const seasonRide = seasonRows.filter((r) => r.rideable).length;
console.log(`Main-season mornings: ${seasonRows.length}, rideable ${seasonRide} (${rate(seasonRows).toFixed(0)}% base rate)\n`);
console.log('call        nights   rideable   rate    share of all sessions');
console.log('---------   ------   --------   -----   ---------------------');
for (const c of ['PACK', 'MAYBE', 'SLEEP IN']) {
  const g = seasonRows.filter((r) => pinnedCall(r) === c);
  if (!g.length) continue;
  const w = g.filter((r) => r.rideable).length;
  console.log(`${c.padEnd(9)}   ${String(g.length).padStart(6)}   ${String(w).padStart(8)}   ${rate(g).toFixed(0).padStart(4)}%   ${((w / seasonRide) * 100).toFixed(0).padStart(19)}%`);
}
const sSleep = seasonRows.filter((r) => pinnedCall(r) === 'SLEEP IN');
console.log(`\nSkipping only SLEEP IN nights in season: ${sSleep.length}/${seasonRows.length} mornings (${((sSleep.length / seasonRows.length) * 7).toFixed(1)} nights/week),`);
console.log(`  cost ${sSleep.filter((r) => r.rideable).length} of ${seasonRide} sessions (${((sSleep.filter((r) => r.rideable).length / seasonRide) * 100).toFixed(0)}%).`);
