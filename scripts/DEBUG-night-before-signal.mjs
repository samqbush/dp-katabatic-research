#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * One question: the night before, does the weather look DIFFERENT on mornings that turned out
 * windy versus mornings that turned out dead?
 *
 * If the two groups look basically the same, there is nothing to predict and we stop.
 * If they separate, a night-before forecast is worth building.
 *
 * Weather comes from Open-Meteo's free archive (no key needed). We only ever look at readings
 * from the EVENING BEFORE (6pm-11pm), so nothing here can peek at the morning it is predicting.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { SUNRISE_COORDS } from './lib/sunrise.mjs';

const SLUG = 'dp-soda-lakes';

// Evening-before hours we summarise, in Colorado time.
const EVE_START_HOUR = 18;
const EVE_END_HOUR = 23;

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'cloud_cover',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_speed_700hPa',
  'wind_direction_700hPa',
  'temperature_700hPa',
  'geopotential_height_700hPa',
  'temperature_850hPa',
  'wind_speed_850hPa',
];

function mean(a) {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function stdev(a) {
  const v = a.filter(Number.isFinite);
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/** Previous calendar day as YYYY-MM-DD. */
function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/* ---------- 1. label every archived morning ---------- */

const days = await readDays(SLUG, {});
const labels = new Map();
for (const day of days) {
  const res = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (res.label === null) continue;
  labels.set(day.date, res.label);
}
await closePool();

const dates = [...labels.keys()].sort();
console.log(`Labeled mornings: ${dates.length}  (windy ${[...labels.values()].filter(Boolean).length}, dead ${[...labels.values()].filter((v) => !v).length})`);
console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]}\n`);

/* ---------- 2. pull the weather for the evening before each ---------- */

const startDate = prevDay(dates[0]);
const endDate = dates[dates.length - 1];

console.log(`Fetching Open-Meteo ${startDate} → ${endDate} ...`);

// Two endpoints are needed. The plain archive (ERA5) serves surface variables but returns nulls
// for pressure levels; the historical-forecast endpoint serves the upper-air winds we actually
// care about. Verified 2026-08-10.
const SURFACE_VARS = HOURLY_VARS.filter((v) => !/hPa$/.test(v));
const UPPER_VARS = HOURLY_VARS.filter((v) => /hPa$/.test(v));

const common = {
  latitude: SUNRISE_COORDS.lat,
  longitude: SUNRISE_COORDS.lng,
  start_date: startDate,
  end_date: endDate,
  timezone: 'America/Denver',
  wind_speed_unit: 'mph',
  temperature_unit: 'fahrenheit',
};

const [sfcRes, upperRes] = await Promise.all([
  axios.get('https://archive-api.open-meteo.com/v1/archive', {
    params: { ...common, hourly: SURFACE_VARS.join(',') },
    timeout: 180000,
  }),
  axios.get('https://historical-forecast-api.open-meteo.com/v1/forecast', {
    params: { ...common, hourly: UPPER_VARS.join(',') },
    timeout: 180000,
  }),
]);

const h = { ...sfcRes.data.hourly };
const uh = upperRes.data.hourly;
if (!h?.time?.length) throw new Error('Open-Meteo returned no surface data');
if (!uh?.time?.length) throw new Error('Open-Meteo returned no upper-air data');

// Align upper-air rows onto the surface timeline by timestamp, since the two endpoints can
// cover slightly different ranges.
const upperIndex = new Map(uh.time.map((t, i) => [t, i]));
for (const v of UPPER_VARS) {
  h[v] = h.time.map((t) => {
    const i = upperIndex.get(t);
    return i === undefined ? null : uh[v]?.[i] ?? null;
  });
}

const upperCoverage = h[UPPER_VARS[0]].filter((x) => Number.isFinite(x)).length;
console.log(`Got ${h.time.length} hourly rows (upper-air present on ${upperCoverage}).\n`);

// Index every hourly row by "YYYY-MM-DD" -> hour -> values
const byDay = new Map();
for (let i = 0; i < h.time.length; i++) {
  const [d, t] = h.time[i].split('T');
  const hour = parseInt(t.slice(0, 2), 10);
  if (!byDay.has(d)) byDay.set(d, new Map());
  const row = {};
  for (const v of HOURLY_VARS) row[v] = h[v]?.[i] ?? null;
  byDay.get(d).set(hour, row);
}

/* ---------- 3. build one evening-before summary per morning ---------- */

function eveningFeatures(morningDate) {
  const eve = byDay.get(prevDay(morningDate));
  const morn = byDay.get(morningDate);
  if (!eve) return null;

  const hours = [];
  for (let hr = EVE_START_HOUR; hr <= EVE_END_HOUR; hr++) {
    if (eve.has(hr)) hours.push(eve.get(hr));
  }
  if (!hours.length) return null;

  const pick = (k) => hours.map((r) => r[k]);

  // Overnight cooling proxy: evening temp minus the 5am temp is NOT allowed (that is morning
  // data). Instead use the evening dewpoint depression, which is available the night before.
  const temp = mean(pick('temperature_2m'));
  const dew = mean(pick('dew_point_2m'));

  // Pressure change across the evening — a falling/rising trend the night before.
  const press = pick('surface_pressure').filter(Number.isFinite);
  const pressTrend = press.length >= 2 ? press[press.length - 1] - press[0] : NaN;

  return {
    cloud: mean(pick('cloud_cover')),
    rh: mean(pick('relative_humidity_2m')),
    dewDepression: temp - dew,
    temp,
    surfacePressure: mean(pick('surface_pressure')),
    pressTrend,
    windSfc: mean(pick('wind_speed_10m')),
    dirSfc: median(pick('wind_direction_10m')),
    wind700: mean(pick('wind_speed_700hPa')),
    dir700: median(pick('wind_direction_700hPa')),
    temp700: mean(pick('temperature_700hPa')),
    gph700: mean(pick('geopotential_height_700hPa')),
    wind850: mean(pick('wind_speed_850hPa')),
    // Stability proxy: how much colder 700mb is than the surface.
    lapse: temp - mean(pick('temperature_700hPa')),
    _hasMorning: !!morn,
  };
}

const windy = [];
const dead = [];
for (const d of dates) {
  const f = eveningFeatures(d);
  if (!f) continue;
  (labels.get(d) ? windy : dead).push(f);
}

console.log(`Matched evenings — windy ${windy.length}, dead ${dead.length}\n`);

/* ---------- 4. do the two groups look different? ---------- */

const FIELDS = [
  ['cloud', 'Cloud cover %', 0],
  ['rh', 'Humidity %', 0],
  ['dewDepression', 'Dryness (temp-dewpoint) F', 1],
  ['temp', 'Evening temp F', 1],
  ['surfacePressure', 'Surface pressure hPa', 1],
  ['pressTrend', 'Pressure change 6-11pm hPa', 2],
  ['windSfc', 'Surface wind mph', 1],
  ['dirSfc', 'Surface wind dir deg', 0],
  ['wind700', 'Wind at 700mb mph', 1],
  ['dir700', 'Wind dir at 700mb deg', 0],
  ['temp700', 'Temp at 700mb F', 1],
  ['gph700', '700mb height m', 0],
  ['wind850', 'Wind at 850mb mph', 1],
  ['lapse', 'Surface-to-700mb temp diff F', 1],
];

console.log('WHAT THE NIGHT BEFORE LOOKED LIKE');
console.log('(separation = how far apart the two groups are; above 0.5 is a usable signal)\n');
console.log('measurement                       windy mornings   dead mornings   separation');
console.log('--------------------------------- --------------   -------------   ----------');

const scored = [];
for (const [key, label, dp] of FIELDS) {
  const a = windy.map((x) => x[key]);
  const b = dead.map((x) => x[key]);
  const ma = mean(a);
  const mb = mean(b);
  const sa = stdev(a);
  const sb = stdev(b);
  const pooled = Math.sqrt((sa ** 2 + sb ** 2) / 2);
  const sep = pooled ? Math.abs(ma - mb) / pooled : 0;
  scored.push({ label, ma, mb, sep, dp });
}

for (const s of scored.sort((x, y) => y.sep - x.sep)) {
  const flag = s.sep >= 0.8 ? '  <== STRONG' : s.sep >= 0.5 ? '  <== usable' : '';
  console.log(
    `${s.label.padEnd(33)} ${s.ma.toFixed(s.dp).padStart(14)}   ${s.mb.toFixed(s.dp).padStart(13)}   ${s.sep.toFixed(2).padStart(10)}${flag}`
  );
}

const best = scored[0];
console.log('\n----------------------------------------------------------------------');
if (best.sep >= 0.5) {
  console.log(`VERDICT: there IS something here. Best single signal "${best.label}" (separation ${best.sep.toFixed(2)}).`);
  console.log('A night-before forecast is worth building.');
} else {
  console.log(`VERDICT: nothing separates. Best was "${best.label}" at only ${best.sep.toFixed(2)}.`);
  console.log('The night before looks the same whether or not the morning blows. Stop here.');
}
console.log('----------------------------------------------------------------------');
