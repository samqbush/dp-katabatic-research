#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * The real test. Two things:
 *
 *  1. Does wind high above the mountains help once we stop assuming "more wind up there = more
 *     wind down here"? The averages hid it, so we look at it in bands.
 *  2. If we build a simple screen from the night-before weather, how many dead mornings can it
 *     rule out WITHOUT throwing away windy ones? Scored only on data the screen never saw.
 *
 * The goal is NOT to call the session. It is to decide whether tonight is worth setting an alarm.
 * So we care about keeping almost every windy morning, and cutting as many dead ones as possible.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { SUNRISE_COORDS } from './lib/sunrise.mjs';

const SLUG = 'dp-soda-lakes';
const EVE_START_HOUR = 18;
const EVE_END_HOUR = 23;
const TARGET_RECALL = 0.9; // keep at least 90% of windy mornings

const SURFACE_VARS = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'cloud_cover', 'surface_pressure', 'wind_speed_10m', 'wind_direction_10m'];
const UPPER_VARS = ['wind_speed_700hPa', 'wind_direction_700hPa', 'temperature_700hPa', 'geopotential_height_700hPa', 'wind_speed_850hPa'];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

function prevDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/* ---------- data ---------- */

const days = await readDays(SLUG, {});
const labels = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) labels.set(day.date, r.label);
}
await closePool();

const dates = [...labels.keys()].sort();
const common = {
  latitude: SUNRISE_COORDS.lat,
  longitude: SUNRISE_COORDS.lng,
  start_date: prevDay(dates[0]),
  end_date: dates[dates.length - 1],
  timezone: 'America/Denver',
  wind_speed_unit: 'mph',
  temperature_unit: 'fahrenheit',
};

const [sfc, upper] = await Promise.all([
  axios.get('https://archive-api.open-meteo.com/v1/archive', { params: { ...common, hourly: SURFACE_VARS.join(',') }, timeout: 180000 }),
  axios.get('https://historical-forecast-api.open-meteo.com/v1/forecast', { params: { ...common, hourly: UPPER_VARS.join(',') }, timeout: 180000 }),
]);

const h = { ...sfc.data.hourly };
const ui = new Map(upper.data.hourly.time.map((t, i) => [t, i]));
for (const v of UPPER_VARS) h[v] = h.time.map((t) => (ui.has(t) ? upper.data.hourly[v][ui.get(t)] : null));

const byDay = new Map();
for (let i = 0; i < h.time.length; i++) {
  const [d, t] = h.time[i].split('T');
  const hr = parseInt(t.slice(0, 2), 10);
  if (!byDay.has(d)) byDay.set(d, new Map());
  const row = {};
  for (const v of [...SURFACE_VARS, ...UPPER_VARS]) row[v] = h[v]?.[i] ?? null;
  byDay.get(d).set(hr, row);
}

const samples = [];
for (const d of dates) {
  const eve = byDay.get(prevDay(d));
  if (!eve) continue;
  const hours = [];
  for (let hr = EVE_START_HOUR; hr <= EVE_END_HOUR; hr++) if (eve.has(hr)) hours.push(eve.get(hr));
  if (hours.length < 4) continue;
  const pick = (k) => hours.map((r) => r[k]);
  const press = pick('surface_pressure').filter(Number.isFinite);
  const temp = mean(pick('temperature_2m'));
  const f = {
    pressTrend: press.length >= 2 ? press[press.length - 1] - press[0] : NaN,
    cloud: mean(pick('cloud_cover')),
    lapse: temp - mean(pick('temperature_700hPa')),
    wind700: mean(pick('wind_speed_700hPa')),
    dir700: median(pick('wind_direction_700hPa')),
    dirSfc: median(pick('wind_direction_10m')),
    temp,
  };
  if (Object.values(f).some((v) => !Number.isFinite(v))) continue;
  samples.push({ date: d, y: labels.get(d) ? 1 : 0, f });
}

console.log(`Usable nights: ${samples.length}  (windy ${samples.filter((s) => s.y).length}, dead ${samples.filter((s) => !s.y).length})\n`);

/* ---------- 1. wind aloft, in bands ---------- */

console.log('WIND HIGH ABOVE THE MOUNTAINS (700mb), THE EVENING BEFORE');
console.log('Averaging it showed nothing. Split into bands, it looks like this:\n');
console.log('band (mph)      nights   windy mornings   rate');
console.log('-------------   ------   --------------   ----');
const bands = [[0, 8], [8, 14], [14, 20], [20, 28], [28, 999]];
for (const [lo, hi] of bands) {
  const g = samples.filter((s) => s.f.wind700 >= lo && s.f.wind700 < hi);
  if (!g.length) continue;
  const w = g.filter((s) => s.y).length;
  const label = hi === 999 ? `${lo}+` : `${lo}-${hi}`;
  const rate = (w / g.length) * 100;
  const bar = '#'.repeat(Math.round(rate / 3));
  console.log(`${label.padEnd(13)}   ${String(g.length).padStart(6)}   ${String(w).padStart(14)}   ${rate.toFixed(0).padStart(3)}% ${bar}`);
}

const base = (samples.filter((s) => s.y).length / samples.length) * 100;
console.log(`\nOverall rate: ${base.toFixed(0)}%  — bands far from this number carry information.\n`);

/* ---------- 2. does a screen actually work on unseen nights? ---------- */

const FEATURES = ['pressTrend', 'cloud', 'lapse', 'wind700', 'temp'];

function standardize(rows) {
  const stats = {};
  for (const k of FEATURES) {
    const v = rows.map((r) => r.f[k]);
    const m = mean(v);
    const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))) || 1;
    stats[k] = { m, sd };
  }
  return stats;
}

function vec(s, stats) {
  return [1, ...FEATURES.map((k) => (s.f[k] - stats[k].m) / stats[k].sd)];
}

function trainLogistic(rows, stats, { iters = 4000, lr = 0.08 } = {}) {
  const X = rows.map((r) => vec(r, stats));
  const y = rows.map((r) => r.y);
  let w = new Array(X[0].length).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], 0);
      const p = 1 / (1 + Math.exp(-z));
      const e = p - y[i];
      for (let j = 0; j < w.length; j++) g[j] += e * X[i][j];
    }
    for (let j = 0; j < w.length; j++) w[j] -= (lr * g[j]) / X.length;
  }
  return w;
}

function predict(s, w, stats) {
  const z = vec(s, stats).reduce((acc, x, j) => acc + x * w[j], 0);
  return 1 / (1 + Math.exp(-z));
}

// Time-ordered 5-fold: always train on some nights and test on nights never seen.
const K = 5;
const shuffled = [...samples];
const preds = [];
const foldSize = Math.ceil(shuffled.length / K);
for (let k = 0; k < K; k++) {
  const test = shuffled.slice(k * foldSize, (k + 1) * foldSize);
  const train = [...shuffled.slice(0, k * foldSize), ...shuffled.slice((k + 1) * foldSize)];
  if (!test.length || !train.length) continue;
  const stats = standardize(train);
  const w = trainLogistic(train, stats);
  for (const s of test) preds.push({ ...s, p: predict(s, w, stats) });
}

const windyP = preds.filter((s) => s.y).map((s) => s.p).sort((a, b) => a - b);
const cut = windyP[Math.floor((1 - TARGET_RECALL) * windyP.length)];

const keptWindy = preds.filter((s) => s.y && s.p >= cut).length;
const totalWindy = preds.filter((s) => s.y).length;
const cutDead = preds.filter((s) => !s.y && s.p < cut).length;
const totalDead = preds.filter((s) => !s.y).length;

console.log('CAN A NIGHT-BEFORE SCREEN RULE OUT DEAD MORNINGS?');
console.log('(scored only on nights the screen was never trained on)\n');
console.log(`Windy mornings kept:      ${keptWindy}/${totalWindy}  (${((keptWindy / totalWindy) * 100).toFixed(0)}%)`);
console.log(`Dead mornings ruled out:  ${cutDead}/${totalDead}  (${((cutDead / totalDead) * 100).toFixed(0)}%)`);

const nightsArmed = preds.filter((s) => s.p >= cut).length;
console.log(`\nAlarm would be armed on ${nightsArmed}/${preds.length} nights (${((nightsArmed / preds.length) * 100).toFixed(0)}%)`);
console.log(`Instead of every night. That is ${(7 - (nightsArmed / preds.length) * 7).toFixed(1)} fewer armed nights per week.`);

console.log('\n----------------------------------------------------------------------');
if (cutDead / totalDead >= 0.3 && keptWindy / totalWindy >= 0.85) {
  console.log('VERDICT: WORTH BUILDING.');
  console.log(`It keeps ${((keptWindy / totalWindy) * 100).toFixed(0)}% of real sessions while cutting ${((cutDead / totalDead) * 100).toFixed(0)}% of the dead nights.`);
} else {
  console.log('VERDICT: NOT WORTH BUILDING YET.');
  console.log('It cannot rule out dead nights without also throwing away real sessions.');
}
console.log('----------------------------------------------------------------------');
