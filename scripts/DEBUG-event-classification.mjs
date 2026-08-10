#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * WHY do windy mornings happen, and can the reason be seen the night before?
 *
 * Three different weather patterns can put 15+ mph of west wind on this meter, and they behave
 * completely differently:
 *
 *   DRAINAGE   cold air pools on the high ground overnight and slides down the canyon under
 *              gravity. Needs: clear sky, steady cooling, calm air above, a shallow lid of cold
 *              air trapped at the surface. Dies when the sun breaks that lid.
 *
 *   CHINOOK    strong wind aloft crashing down the mountains. Warms the surface sharply. Does
 *              not care about sunrise.
 *
 *   MIXED-DOWN strong wind sitting just above the ground gets stirred down to the surface as the
 *              morning sun heats things up. Starts AFTER sunrise, needs wind aloft to exist.
 *
 * The lid of cold air is the key measurement. The weather model reports its depth directly
 * ("boundary layer height"), and that is available the night before.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH, parseArchiveDate } from './lib/label.mjs';
import { SUNRISE_COORDS, calcSunrise } from './lib/sunrise.mjs';

const SLUG = 'dp-soda-lakes';
const VARS = [
  'temperature_2m',
  'wind_speed_10m',
  'boundary_layer_height',
  'wind_speed_700hPa',
  'wind_speed_850hPa',
  'cloud_cover',
];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const minOf = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? Math.min(...v) : NaN;
};
const maxOf = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? Math.max(...v) : NaN;
};

function prevDay(iso) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/* ---------- labels ---------- */

const days = await readDays(SLUG, {});
const info = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label === null) continue;
  info.set(day.date, { rideable: r.label, sustained: r.sustainedMinutes });
}
await closePool();
const dates = [...info.keys()].sort();

/* ---------- weather ---------- */

const byDay = new Map();
let cursor = prevDay(dates[0]);
// Fetch through TODAY, not just the last archived day, so a morning that has not been archived
// yet (like the one prompting this analysis) can still be diagnosed.
const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
const lastArchived = dates[dates.length - 1];
const last = todayIso > lastArchived ? todayIso : lastArchived;
while (cursor <= last) {
  const e = new Date(`${cursor}T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() + 120);
  const endIso = e.toISOString().slice(0, 10) > last ? last : e.toISOString().slice(0, 10);
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
  if (endIso === last) break;
  const n = new Date(e);
  n.setUTCDate(n.getUTCDate() + 1);
  cursor = n.toISOString().slice(0, 10);
}

const hoursOf = (d, a, b) => {
  const m = byDay.get(d);
  if (!m) return [];
  const out = [];
  for (let hr = a; hr <= b; hr++) if (m.has(hr)) out.push(m.get(hr));
  return out;
};

/* ---------- classify each morning ---------- */

const rows = [];
for (const d of dates) {
  const eve = hoursOf(prevDay(d), 18, 23);
  const night = hoursOf(d, 0, 4);
  const morn = hoursOf(d, 5, 8);
  if (eve.length < 4 || night.length < 4 || morn.length < 3) continue;

  const p = (rs, k) => rs.map((r) => r[k]);
  const eveTemp = maxOf(p(eve, 'temperature_2m'));
  const mornTempMin = minOf(p(morn, 'temperature_2m'));
  const overnightCooling = eveTemp - mornTempMin;

  // How deep is the lid of cold air during the session window? Small = strong shallow inversion.
  const lidMorning = mean(p(morn, 'boundary_layer_height'));
  const lidNight = mean(p(night, 'boundary_layer_height'));
  // NOTE: 850mb sits at roughly 1500 m, which is BELOW this site (1780 m), so those values are
  // extrapolated underground and are meaningless here. 700mb (~3100 m) is the lowest level that
  // is genuinely above the terrain. Verified 2026-08-10.
  const aloft = mean([...p(night, 'wind_speed_700hPa'), ...p(morn, 'wind_speed_700hPa')]);
  const cloud = mean(p(eve, 'cloud_cover'));

  // Temperature change from 5am to 8am — a chinook warms the surface while it blows.
  const t5 = byDay.get(d)?.get(5)?.temperature_2m;
  const t8 = byDay.get(d)?.get(8)?.temperature_2m;
  const morningWarming = Number.isFinite(t5) && Number.isFinite(t8) ? t8 - t5 : NaN;

  let type;
  if (aloft >= 25 && morningWarming >= 12) type = 'CHINOOK';
  else if (aloft >= 25 && lidMorning >= 300) type = 'MIXED-DOWN';
  else if (lidMorning < 200 && overnightCooling >= 8 && aloft < 25) type = 'DRAINAGE';
  else if (aloft >= 25) type = 'WINDY-ALOFT';
  else type = 'CALM-ALOFT';

  rows.push({
    date: d,
    rideable: info.get(d).rideable,
    sustained: info.get(d).sustained,
    type,
    lidMorning,
    lidNight,
    aloft,
    cooling: overnightCooling,
    warming: morningWarming,
    cloud,
  });
}

console.log(`\nMornings classified: ${rows.length}\n`);

console.log('WHAT KIND OF MORNING WAS IT, AND HOW OFTEN IS IT RIDEABLE?\n');
console.log('pattern       nights   rideable   rate    avg lid depth (m)   avg wind aloft');
console.log('-----------   ------   --------   -----   -----------------   --------------');
for (const t of ['DRAINAGE', 'MIXED-DOWN', 'CHINOOK', 'WINDY-ALOFT', 'CALM-ALOFT']) {
  const g = rows.filter((r) => r.type === t);
  if (!g.length) continue;
  const w = g.filter((r) => r.rideable).length;
  console.log(
    `${t.padEnd(11)}   ${String(g.length).padStart(6)}   ${String(w).padStart(8)}   ${((w / g.length) * 100).toFixed(0).padStart(4)}%   ${mean(g.map((r) => r.lidMorning)).toFixed(0).padStart(17)}   ${mean(g.map((r) => r.aloft)).toFixed(1).padStart(14)}`
  );
}
const overall = (rows.filter((r) => r.rideable).length / rows.length) * 100;
console.log(`\nOverall rideable rate: ${overall.toFixed(0)}%\n`);

/* ---------- the lid, on its own ---------- */

console.log('DEPTH OF THE COLD-AIR LID DURING 5-8AM (smaller = inversion still intact)\n');
console.log('lid depth (m)   nights   rideable   rate');
console.log('-------------   ------   --------   ----');
for (const [lo, hi] of [[0, 60], [60, 100], [100, 200], [200, 400], [400, 9999]]) {
  const g = rows.filter((r) => r.lidMorning >= lo && r.lidMorning < hi);
  if (!g.length) continue;
  const w = g.filter((r) => r.rideable).length;
  const rate = (w / g.length) * 100;
  console.log(
    `${(hi === 9999 ? `${lo}+` : `${lo}-${hi}`).padEnd(13)}   ${String(g.length).padStart(6)}   ${String(w).padStart(8)}   ${rate.toFixed(0).padStart(3)}% ${'#'.repeat(Math.round(rate / 3))}`
  );
}

/* ---------- this morning ---------- */

let today = rows.find((r) => r.date === todayIso);
if (!today) {
  // Not archived yet — compute the same features straight from the weather data.
  const eve = hoursOf(prevDay(todayIso), 18, 23);
  const night = hoursOf(todayIso, 0, 4);
  const morn = hoursOf(todayIso, 5, 8);
  if (eve.length >= 4 && night.length >= 4 && morn.length >= 3) {
    const p = (rs, k) => rs.map((r) => r[k]);
    const t5 = byDay.get(todayIso)?.get(5)?.temperature_2m;
    const t8 = byDay.get(todayIso)?.get(8)?.temperature_2m;
    today = {
      date: todayIso,
      rideable: null,
      type: 'not-yet-archived',
      lidMorning: mean(p(morn, 'boundary_layer_height')),
      lidNight: mean(p(night, 'boundary_layer_height')),
      aloft: mean([...p(night, 'wind_speed_700hPa'), ...p(morn, 'wind_speed_700hPa')]),
      cooling: maxOf(p(eve, 'temperature_2m')) - minOf(p(morn, 'temperature_2m')),
      warming: Number.isFinite(t5) && Number.isFinite(t8) ? t8 - t5 : NaN,
      cloud: mean(p(eve, 'cloud_cover')),
    };
  }
}
if (today) {
  console.log(`\n=== ${today.date}, THE MORNING IN QUESTION ===`);
  console.log(`Pattern:                 ${today.type}`);
  console.log(`Lid depth 5-8am:         ${today.lidMorning.toFixed(0)} m   (all-morning average ${mean(rows.map((r) => r.lidMorning)).toFixed(0)} m)`);
  console.log(`Lid depth midnight-4am:  ${today.lidNight.toFixed(0)} m`);
  console.log(`Wind aloft (700mb):      ${today.aloft.toFixed(1)} mph  (rideable-morning avg ${mean(rows.filter((r) => r.rideable).map((r) => r.aloft)).toFixed(1)})`);
  console.log(`Overnight cooling:       ${today.cooling.toFixed(1)} F`);
  console.log(`Warming 5am-8am:         ${today.warming.toFixed(1)} F`);
  console.log(`Evening cloud:           ${today.cloud.toFixed(0)}%`);

  const shallower = rows.filter((r) => r.lidMorning < today.lidMorning).length;
  console.log(`\nLid was shallower than ${((shallower / rows.length) * 100).toFixed(0)}% of mornings in the archive.`);
}

/* ---------- how rare was a post-sunrise peak? ---------- */

console.log('\n=== HOW UNUSUAL WAS A POST-SUNRISE PEAK? ===');
const rideable = rows.filter((r) => r.rideable);
const veryShallow = rideable.filter((r) => r.lidMorning < 100);
console.log(`Rideable mornings with the lid still under 100 m at 5-8am: ${veryShallow.length}/${rideable.length} (${((veryShallow.length / rideable.length) * 100).toFixed(0)}%)`);
console.log('Those are the mornings where the inversion survives past sunrise and the wind runs late.');

const sunrise = calcSunrise(parseArchiveDate(todayIso), SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
console.log(`\nSunrise ${todayIso} was ${sunrise.toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit', hour12: false })}.`);
