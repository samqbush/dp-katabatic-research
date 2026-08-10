#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * The whole system, end to end, scored on one year of real mornings.
 *
 *   Night before:  HRRR says whether tomorrow morning is even a candidate. If not, no alarm is
 *                  set and you sleep.
 *   Morning:       on armed nights only, the meter is polled and wakes you when wind is real.
 *
 * The number that matters is not accuracy. It is: how many times a week does this thing wake
 * you, and how many of those wake-ups are an actual session?
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH, parseArchiveDate } from './lib/label.mjs';
import { SUNRISE_COORDS } from './lib/sunrise.mjs';
import { gateOpenTime } from './lib/season.mjs';

const SLUG = 'dp-soda-lakes';
const TRIGGER_AVG = 14;
const TRIGGER_WINDOW_MIN = 15;
const EARLIEST_FIRE_BEFORE_GATE_MIN = 60;
const DRIVE_MIN = 45;
const MIN_USEFUL_SESSION_MIN = 30;

const VARS = ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m'];
const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const cycleMinutes = (c) => {
  const m = /^(\d+)min$/.exec(c || '');
  return m ? parseInt(m[1], 10) : 5;
};

/* ---------- morning meter + label ---------- */

const days = await readDays(SLUG, {});
const morningInfo = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label === null || !day.points?.length) continue;
  morningInfo.set(day.date, {
    rideable: r.label,
    windowEndTs: r.windowEndTs,
    points: day.points,
    step: cycleMinutes(day.cycle_type),
    gateTs: Math.floor(gateOpenTime(parseArchiveDate(day.date)).getTime() / 1000),
  });
}
await closePool();

const dates = [...morningInfo.keys()].sort();

/* ---------- HRRR morning forecast ---------- */

const hrrr = new Map();
const CHUNK = 120;
let cursor = dates[0];
const last = dates[dates.length - 1];
while (cursor <= last) {
  const e = new Date(`${cursor}T00:00:00Z`);
  e.setUTCDate(e.getUTCDate() + CHUNK);
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
    },
    timeout: 180000,
  });
  const h = res.data.hourly;
  const acc = new Map();
  for (let i = 0; i < h.time.length; i++) {
    const [d, t] = h.time[i].split('T');
    const hr = parseInt(t.slice(0, 2), 10);
    if (hr < 5 || hr > 8) continue;
    if (!acc.has(d)) acc.set(d, []);
    acc.get(d).push(h.wind_speed_10m[i]);
  }
  for (const [d, arr] of acc) hrrr.set(d, mean(arr));
  if (endIso === last) break;
  const n = new Date(e);
  n.setUTCDate(n.getUTCDate() + 1);
  cursor = n.toISOString().slice(0, 10);
}

/* ---------- alarm ---------- */

function fireTs(points, step, earliestTs) {
  const need = Math.max(1, Math.round(TRIGGER_WINDOW_MIN / step));
  for (let i = 0; i < points.length; i++) {
    if (points[i].ts < earliestTs) continue;
    const w = points.slice(Math.max(0, i - need + 1), i + 1);
    if (w.length < need) continue;
    if (!w.every((x, j) => j === 0 || (x.ts - w[j - 1].ts) / 60 <= step * 1.5)) continue;
    if (w.reduce((s, x) => s + x.speed, 0) / w.length >= TRIGGER_AVG) return points[i].ts;
  }
  return null;
}

const evaluated = [];
for (const d of dates) {
  const m = morningInfo.get(d);
  const f = hrrr.get(d);
  if (!Number.isFinite(f)) continue;
  const fire = fireTs(m.points, m.step, m.gateTs - EARLIEST_FIRE_BEFORE_GATE_MIN * 60);
  let goodWake = false;
  if (fire !== null && m.rideable) {
    const arrive = Math.max(fire + DRIVE_MIN * 60, m.gateTs);
    goodWake = (m.windowEndTs - arrive) / 60 >= MIN_USEFUL_SESSION_MIN;
  }
  evaluated.push({ date: d, rideable: m.rideable, hrrr: f, wakes: fire !== null, goodWake });
}

const N = evaluated.length;
const totalSessions = evaluated.filter((e) => e.goodWake).length;

console.log(`\nMornings evaluated: ${N} (${(N / 7).toFixed(0)} weeks)`);
console.log(`Real catchable sessions in that period: ${totalSessions}  (${((totalSessions / N) * 7).toFixed(1)}/week)\n`);

console.log('SYSTEM PERFORMANCE — arm the alarm only when HRRR forecasts at least X mph\n');
console.log('HRRR arm   nights   wakes/  wasted   sessions    sessions   wasted');
console.log('threshold  armed    week    wakes/wk caught      missed     per session');
console.log('---------  ------   ------  -------- ----------  ---------  -----------');

for (const T of [0, 4, 5, 6, 7, 8, 9, 10, 12]) {
  const armed = evaluated.filter((e) => e.hrrr >= T);
  const wakes = armed.filter((e) => e.wakes);
  const good = wakes.filter((e) => e.goodWake).length;
  const wasted = wakes.length - good;
  const missed = totalSessions - good;
  const perWeek = (x) => ((x / N) * 7).toFixed(1);
  console.log(
    `${(T === 0 ? 'none' : `>=${T}`).padEnd(9)}  ${String(armed.length).padStart(6)}   ${perWeek(wakes.length).padStart(6)}  ${perWeek(wasted).padStart(8)} ${`${good}/${totalSessions}`.padStart(10)}  ${String(missed).padStart(9)}  ${(good ? (wasted / good).toFixed(1) : '-').padStart(11)}`
  );
}

console.log('\nReading this table:');
console.log('  "none" = no forecast screen, alarm armed every night (the baseline).');
console.log('  Lower "wasted per session" is better — it is how many pointless wake-ups');
console.log('  you tolerate for each real session you get.');
console.log('\nFor comparison, waking up manually every day = 7.0 wakes/week.');
