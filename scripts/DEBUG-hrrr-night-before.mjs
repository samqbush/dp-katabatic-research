#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * Second attempt at a night-before call, using the high-resolution US weather model (HRRR)
 * instead of the worldwide one.
 *
 * The important difference: HRRR runs on a ~2 mile grid and produces its own forecast of the
 * wind AT THE LAKE for tomorrow morning. The worldwide model could not see the canyon at all.
 * So the headline question is simple: when HRRR says it will blow tomorrow morning, does it?
 *
 * ⚠️ HONEST CAVEAT, read before trusting a good result. Open-Meteo's historical-forecast archive
 * returns the FRESHEST forecast for each hour, which can be only an hour or two old. A real
 * night-before call is made ~8 hours ahead. So this is a BEST CASE — if it fails here, a genuine
 * night-before version cannot do better.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { SUNRISE_COORDS } from './lib/sunrise.mjs';

const SLUG = 'dp-soda-lakes';
const TARGET_RECALL = 0.9;

const VARS = [
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'temperature_2m',
  'dew_point_2m',
  'cloud_cover',
  'surface_pressure',
  'boundary_layer_height',
  'wind_speed_700hPa',
  'wind_direction_700hPa',
  'temperature_700hPa',
  'geopotential_height_700hPa',
];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const maxOf = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? Math.max(...v) : NaN;
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

/* ---------- labels ---------- */

const days = await readDays(SLUG, {});
const labels = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) labels.set(day.date, r.label);
}
await closePool();

const dates = [...labels.keys()].sort();
console.log(`Labeled mornings: ${dates.length} (windy ${[...labels.values()].filter(Boolean).length})`);

/* ---------- HRRR, in chunks so the request never gets too big ---------- */

const byDay = new Map();
const CHUNK_DAYS = 120;
let cursor = prevDay(dates[0]);
const finalDate = dates[dates.length - 1];

console.log(`Fetching HRRR ${cursor} → ${finalDate} ...`);
while (cursor <= finalDate) {
  const end = new Date(Date.UTC(...cursor.split('-').map((x, i) => (i === 1 ? +x - 1 : +x))));
  end.setUTCDate(end.getUTCDate() + CHUNK_DAYS);
  const endIso = end.toISOString().slice(0, 10) > finalDate ? finalDate : end.toISOString().slice(0, 10);

  const res = await axios.get('https://historical-forecast-api.open-meteo.com/v1/forecast', {
    params: {
      latitude: SUNRISE_COORDS.lat,
      longitude: SUNRISE_COORDS.lng,
      start_date: cursor,
      end_date: endIso,
      hourly: VARS.join(','),
      models: 'gfs_hrrr',
      timezone: 'America/Denver',
      wind_speed_unit: 'mph',
      temperature_unit: 'fahrenheit',
    },
    timeout: 180000,
  });

  const h = res.data.hourly;
  for (let i = 0; i < h.time.length; i++) {
    const [d, t] = h.time[i].split('T');
    const hr = parseInt(t.slice(0, 2), 10);
    if (!byDay.has(d)) byDay.set(d, new Map());
    const row = {};
    for (const v of VARS) row[v] = h[v]?.[i] ?? null;
    byDay.get(d).set(hr, row);
  }

  const next = new Date(end);
  next.setUTCDate(next.getUTCDate() + 1);
  cursor = next.toISOString().slice(0, 10);
  if (endIso === finalDate) break;
}
console.log(`Got ${byDay.size} days of HRRR.\n`);

/* ---------- features ---------- */

function hoursOf(dayIso, from, to) {
  const m = byDay.get(dayIso);
  if (!m) return [];
  const out = [];
  for (let hr = from; hr <= to; hr++) if (m.has(hr)) out.push(m.get(hr));
  return out;
}

const samples = [];
for (const d of dates) {
  const eve = hoursOf(prevDay(d), 18, 23);
  const morn = hoursOf(d, 5, 8); // the session window HRRR is forecasting
  const night = hoursOf(d, 0, 4);
  if (eve.length < 4 || morn.length < 3) continue;

  const p = (rows, k) => rows.map((r) => r[k]);
  const press = p(eve, 'surface_pressure').filter(Number.isFinite);
  const eveTemp = mean(p(eve, 'temperature_2m'));

  const f = {
    // THE headline feature: HRRR's own forecast of morning wind at the lake.
    hrrrMornWind: mean(p(morn, 'wind_speed_10m')),
    hrrrMornGust: mean(p(morn, 'wind_gusts_10m')),
    hrrrMornWindMax: maxOf(p(morn, 'wind_speed_10m')),
    hrrrMornDir: median(p(morn, 'wind_direction_10m')),
    hrrrNightWind: mean(p(night, 'wind_speed_10m')),
    blHeight: mean(p(night, 'boundary_layer_height')),
    cloud: mean(p(eve, 'cloud_cover')),
    pressTrend: press.length >= 2 ? press[press.length - 1] - press[0] : NaN,
    eveTemp,
    lapse: eveTemp - mean(p(eve, 'temperature_700hPa')),
    wind700: mean(p(eve, 'wind_speed_700hPa')),
  };
  if (Object.values(f).some((v) => !Number.isFinite(v))) continue;
  samples.push({ date: d, y: labels.get(d) ? 1 : 0, f });
}

const nWindy = samples.filter((s) => s.y).length;
const baseRate = (nWindy / samples.length) * 100;
console.log(`Usable nights: ${samples.length} (windy ${nWindy}, dead ${samples.length - nWindy}, rate ${baseRate.toFixed(0)}%)\n`);

/* ---------- 1. the headline check ---------- */

console.log('WHEN HRRR FORECASTS WIND AT THE LAKE FOR 5-8AM, DOES IT BLOW?\n');
console.log('HRRR says (mph)   nights   turned out windy   rate');
console.log('---------------   ------   ----------------   ----');
for (const [lo, hi] of [[0, 6], [6, 9], [9, 12], [12, 15], [15, 18], [18, 99]]) {
  const g = samples.filter((s) => s.f.hrrrMornWind >= lo && s.f.hrrrMornWind < hi);
  if (!g.length) continue;
  const w = g.filter((s) => s.y).length;
  const rate = (w / g.length) * 100;
  console.log(
    `${(hi === 99 ? `${lo}+` : `${lo}-${hi}`).padEnd(15)}   ${String(g.length).padStart(6)}   ${String(w).padStart(16)}   ${rate.toFixed(0).padStart(3)}% ${'#'.repeat(Math.round(rate / 3))}`
  );
}
console.log(`\nOverall rate ${baseRate.toFixed(0)}%. Bands far from that number carry information.\n`);

/* ---------- 2. screen tested on unseen nights ---------- */

const FEATURES = ['hrrrMornWind', 'hrrrMornGust', 'hrrrMornWindMax', 'hrrrNightWind', 'blHeight', 'cloud', 'pressTrend', 'lapse', 'wind700'];

const standardize = (rows) => {
  const st = {};
  for (const k of FEATURES) {
    const v = rows.map((r) => r.f[k]);
    const m = mean(v);
    const sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2))) || 1;
    st[k] = { m, sd };
  }
  return st;
};
const vec = (s, st) => [1, ...FEATURES.map((k) => (s.f[k] - st[k].m) / st[k].sd)];

function train(rows, st, { iters = 5000, lr = 0.1, l2 = 0.01 } = {}) {
  const X = rows.map((r) => vec(r, st));
  const y = rows.map((r) => r.y);
  let w = new Array(X[0].length).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(w.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], 0);
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < w.length; j++) g[j] += e * X[i][j];
    }
    for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / X.length + (j ? l2 * w[j] : 0));
  }
  return w;
}
const prob = (s, w, st) => 1 / (1 + Math.exp(-vec(s, st).reduce((a, x, j) => a + x * w[j], 0)));

const K = 5;
const foldSize = Math.ceil(samples.length / K);
const preds = [];
for (let k = 0; k < K; k++) {
  const test = samples.slice(k * foldSize, (k + 1) * foldSize);
  const trainSet = [...samples.slice(0, k * foldSize), ...samples.slice((k + 1) * foldSize)];
  if (!test.length || !trainSet.length) continue;
  const st = standardize(trainSet);
  const w = train(trainSet, st);
  for (const s of test) preds.push({ ...s, p: prob(s, w, st) });
}

const windyP = preds.filter((s) => s.y).map((s) => s.p).sort((a, b) => a - b);
const cut = windyP[Math.floor((1 - TARGET_RECALL) * windyP.length)];
const keptWindy = preds.filter((s) => s.y && s.p >= cut).length;
const totalWindy = preds.filter((s) => s.y).length;
const cutDead = preds.filter((s) => !s.y && s.p < cut).length;
const totalDead = preds.filter((s) => !s.y).length;
const armed = preds.filter((s) => s.p >= cut).length;

console.log('CAN IT RULE OUT DEAD MORNINGS THE NIGHT BEFORE?');
console.log('(scored only on nights it was never trained on)\n');
console.log(`Windy mornings kept:      ${keptWindy}/${totalWindy}  (${((keptWindy / totalWindy) * 100).toFixed(0)}%)`);
console.log(`Dead mornings ruled out:  ${cutDead}/${totalDead}  (${((cutDead / totalDead) * 100).toFixed(0)}%)`);
console.log(`Alarm armed on ${armed}/${preds.length} nights (${((armed / preds.length) * 100).toFixed(0)}%) — ${((armed / preds.length) * 7).toFixed(1)} nights/week instead of 7`);

console.log('\n----------------------------------------------------------------------');
if (cutDead / totalDead >= 0.3) {
  console.log('VERDICT: WORTH BUILDING.');
  console.log(`Keeps ${((keptWindy / totalWindy) * 100).toFixed(0)}% of real sessions, cuts ${((cutDead / totalDead) * 100).toFixed(0)}% of dead nights.`);
  console.log('Remember the caveat at the top: this is a best case. Re-test with a true 8-hour-ahead forecast.');
} else {
  console.log('VERDICT: STILL NOT GOOD ENOUGH.');
  console.log(`Only ${((cutDead / totalDead) * 100).toFixed(0)}% of dead nights ruled out.`);
}
console.log('----------------------------------------------------------------------');
