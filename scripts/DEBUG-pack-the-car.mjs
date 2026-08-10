#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * The night-before question, stated the way it actually gets asked:
 *   "Do I pack the car tonight?"
 *
 * Two things are known the evening before, both from the high-resolution US weather model:
 *   1. What it forecasts the wind to be at the lake at 5-8am.
 *   2. How deep the lid of cold air will be over the lake at 5-8am. Shallow lid = the inversion
 *      that drives drainage wind is intact and will survive into the session window.
 *
 * Output is three buckets, not a probability, because "pack / maybe / sleep in" is the actual
 * decision. Scored across a year of real mornings.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { SUNRISE_COORDS } from './lib/sunrise.mjs';

const SLUG = 'dp-soda-lakes';
const VARS = ['wind_speed_10m', 'boundary_layer_height', 'temperature_2m'];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};

function prevDay(iso) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

const days = await readDays(SLUG, {});
const info = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) info.set(day.date, r.label);
}
await closePool();
const dates = [...info.keys()].sort();

const byDay = new Map();
let cursor = prevDay(dates[0]);
const last = dates[dates.length - 1];
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
    if (hr < 5 || hr > 8) continue;
    if (!byDay.has(d)) byDay.set(d, { wind: [], lid: [] });
    byDay.get(d).wind.push(h.wind_speed_10m[i]);
    byDay.get(d).lid.push(h.boundary_layer_height[i]);
  }
  if (endIso === last) break;
  const n = new Date(e);
  n.setUTCDate(n.getUTCDate() + 1);
  cursor = n.toISOString().slice(0, 10);
}

const rows = [];
for (const d of dates) {
  const b = byDay.get(d);
  if (!b || b.wind.length < 3) continue;
  const wind = mean(b.wind);
  const lid = mean(b.lid);
  if (!Number.isFinite(wind) || !Number.isFinite(lid)) continue;
  rows.push({ date: d, rideable: info.get(d), wind, lid });
}

const base = (rows.filter((r) => r.rideable).length / rows.length) * 100;
console.log(`\nMornings scored: ${rows.length}, of which rideable ${rows.filter((r) => r.rideable).length} (${base.toFixed(0)}%)\n`);

/* ---------- the two signals together ---------- */

console.log('FORECAST WIND vs DEPTH OF THE COLD-AIR LID (rate rideable, nights in brackets)\n');
const windBands = [[0, 6], [6, 9], [9, 99]];
const lidBands = [[0, 100], [100, 250], [250, 9999]];
console.log('                    lid <100m        lid 100-250m      lid >250m');
console.log('                    (inversion       (partly           (inversion');
console.log('                     intact)          broken)           gone)');
console.log('                    -----------      ------------      -----------');
for (const [wlo, whi] of windBands) {
  const cells = lidBands.map(([llo, lhi]) => {
    const g = rows.filter((r) => r.wind >= wlo && r.wind < whi && r.lid >= llo && r.lid < lhi);
    if (!g.length) return '        -       ';
    const w = g.filter((r) => r.rideable).length;
    return `${((w / g.length) * 100).toFixed(0).padStart(4)}%  (n=${String(g.length).padStart(3)})`;
  });
  const label = whi === 99 ? `wind 9+ mph` : `wind ${wlo}-${whi} mph`;
  console.log(`${label.padEnd(18)}  ${cells.join('    ')}`);
}

/* ---------- three-bucket call ---------- */

function call(r) {
  if (r.wind >= 9 && r.lid < 250) return 'PACK';
  if (r.wind < 5 && r.lid >= 250) return 'SLEEP IN';
  if (r.wind < 6 && r.lid >= 100) return 'SLEEP IN';
  return 'MAYBE';
}

console.log('\n\nTHE NIGHT-BEFORE CALL\n');
console.log('call        nights   rideable   rate    share of all sessions');
console.log('---------   ------   --------   -----   ---------------------');
const totalRideable = rows.filter((r) => r.rideable).length;
for (const c of ['PACK', 'MAYBE', 'SLEEP IN']) {
  const g = rows.filter((r) => call(r) === c);
  if (!g.length) continue;
  const w = g.filter((r) => r.rideable).length;
  console.log(
    `${c.padEnd(9)}   ${String(g.length).padStart(6)}   ${String(w).padStart(8)}   ${((w / g.length) * 100).toFixed(0).padStart(4)}%   ${((w / totalRideable) * 100).toFixed(0).padStart(19)}%`
  );
}

const sleepIn = rows.filter((r) => call(r) === 'SLEEP IN');
const missed = sleepIn.filter((r) => r.rideable).length;
console.log(`\nIf you only ever skipped the SLEEP IN nights:`);
console.log(`  You would sleep through ${sleepIn.length} of ${rows.length} mornings (${((sleepIn.length / rows.length) * 100).toFixed(0)}%, about ${((sleepIn.length / rows.length) * 7).toFixed(1)} nights/week).`);
console.log(`  Cost: ${missed} missed sessions out of ${totalRideable} (${((missed / totalRideable) * 100).toFixed(0)}%).`);
