#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * Question being tested (user challenge, 2026-08-10):
 *   "A poll-based wake-up alarm is useless for anyone who doesn't live 5 minutes away, because
 *    it can only fire once the wind is already happening — by the time you drive out, it's over."
 *
 * Method: for every archived RIDEABLE morning, find (a) when a trailing-average alarm would
 * first have fired, (b) when the rideable window actually closed, and therefore (c) how many
 * rideable minutes are left after a drive of D minutes. No forecasting, no lookahead in the
 * trigger — the alarm only ever sees readings at or before its own fire time.
 */

import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, parseArchiveDate, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { gateOpenTime } from './lib/season.mjs';
import { calcSunrise, SUNRISE_COORDS } from './lib/sunrise.mjs';
import { zonedTimeFrom } from './lib/zone.mjs';

const SLUG = 'dp-soda-lakes';
const THRESHOLD = DEFAULT_THRESHOLD_MPH; // 15 mph
const TRIGGER_AVG = 14; // trailing-average level that fires the alarm
const TRIGGER_WINDOW_MIN = 15; // how much trailing data the alarm averages
const DRIVE_TIMES = [5, 20, 45];
const MIN_USEFUL_SESSION_MIN = 30; // a session shorter than this isn't worth the drive

function cycleMinutes(cycleType) {
  const m = /^(\d+)min$/.exec(cycleType || '');
  return m ? parseInt(m[1], 10) : 5;
}

function fmt(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    timeZone: 'America/Denver',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}

/**
 * First moment a trailing-average alarm would fire. Only uses points at or before each candidate
 * fire time, so there is no lookahead.
 */
function alarmFireTs(points, step, scanStartTs) {
  const need = Math.max(1, Math.round(TRIGGER_WINDOW_MIN / step));
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ts < scanStartTs) continue;
    const window = points.slice(Math.max(0, i - need + 1), i + 1);
    if (window.length < need) continue;
    // Reject a window with a data gap — an outage is not evidence of wind.
    const contiguous = window.every((w, j) => j === 0 || (w.ts - window[j - 1].ts) / 60 <= step * 1.5);
    if (!contiguous) continue;
    const avg = window.reduce((s, w) => s + w.speed, 0) / window.length;
    if (avg >= TRIGGER_AVG) return p.ts;
  }
  return null;
}

const days = await readDays(SLUG, {});
const rows = [];
const allDays = []; // every LABELABLE day, rideable or not — needed for the false-wake rate

for (const day of days) {
  const res = labelDay(day, { threshold: THRESHOLD });
  if (res.label === null) continue; // unobserved: never read absence of data as absence of wind

  const date = parseArchiveDate(day.date);
  const step = cycleMinutes(day.cycle_type);
  const gateTs = Math.floor(gateOpenTime(date).getTime() / 1000);
  const sunrise = calcSunrise(date, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
  const scanStartTs = Math.floor(zonedTimeFrom(date, 3, 30, 0).getTime() / 1000);

  const fireTs = alarmFireTs(day.points, step, scanStartTs);

  allDays.push({ date: day.date, step, fireTs, gateTs, rideable: res.label, points: day.points, sunriseTs: sunrise ? Math.floor(sunrise.getTime() / 1000) : null });

  if (res.label !== true) continue; // only rideable mornings answer "would I have missed it"

  rows.push({
    date: day.date,
    step,
    fireTs,
    gateTs,
    windowStartTs: res.windowStartTs,
    windowEndTs: res.windowEndTs,
    sustained: res.sustainedMinutes,
    sunriseTs: sunrise ? Math.floor(sunrise.getTime() / 1000) : null,
  });
}

console.log(`\nRideable mornings analysed: ${rows.length}`);
console.log(`Alarm spec: trailing ${TRIGGER_WINDOW_MIN}-min avg >= ${TRIGGER_AVG} mph, scanning from 03:30\n`);

const fired = rows.filter((r) => r.fireTs !== null);
console.log(`Alarm fired at all: ${fired.length}/${rows.length} (${((fired.length / rows.length) * 100).toFixed(0)}%)`);

// How long is the rideable window in the first place?
const windowLens = rows.map((r) => (r.windowEndTs - r.windowStartTs) / 60).filter(Number.isFinite);
console.log(
  `\nRideable window length (min): p25 ${quantile(windowLens, 0.25).toFixed(0)}  median ${quantile(windowLens, 0.5).toFixed(0)}  p75 ${quantile(windowLens, 0.75).toFixed(0)}  max ${Math.max(...windowLens).toFixed(0)}`
);

// Lead time: alarm fire vs window start
const leads = fired.map((r) => (r.windowStartTs - r.fireTs) / 60).filter(Number.isFinite);
console.log(
  `Alarm fires vs window start (min, +ve = fires BEFORE window opens): p25 ${quantile(leads, 0.25).toFixed(0)}  median ${quantile(leads, 0.5).toFixed(0)}  p75 ${quantile(leads, 0.75).toFixed(0)}`
);

console.log(`\n=== USABLE SESSION AFTER DRIVING D MINUTES (n=${rows.length} rideable mornings) ===`);
console.log('D(min) | alarm caught | arrive<end | >=30min left | median min left');
console.log('-------|--------------|------------|--------------|----------------');
for (const D of DRIVE_TIMES) {
  const remain = [];
  let caught = 0;
  let anyLeft = 0;
  let useful = 0;
  for (const r of rows) {
    if (r.fireTs === null) {
      remain.push(0);
      continue;
    }
    caught += 1;
    // Cannot be on the water before the gate opens.
    const arrive = Math.max(r.fireTs + D * 60, r.gateTs);
    const left = Math.max(0, (r.windowEndTs - arrive) / 60);
    remain.push(left);
    if (left > 0) anyLeft += 1;
    if (left >= MIN_USEFUL_SESSION_MIN) useful += 1;
  }
  const pct = (x) => `${((x / rows.length) * 100).toFixed(0)}%`;
  console.log(
    `${String(D).padStart(6)} | ${pct(caught).padStart(12)} | ${pct(anyLeft).padStart(10)} | ${pct(useful).padStart(12)} | ${quantile(remain, 0.5).toFixed(0).padStart(15)}`
  );
}

console.log('\n=== SAMPLE OF RECENT RIDEABLE MORNINGS ===');
console.log('date        fire   gate   winStart winEnd  sustained  left@45min');
for (const r of rows.slice(-15)) {
  const arrive45 = r.fireTs ? Math.max(r.fireTs + 45 * 60, r.gateTs) : null;
  const left45 = arrive45 ? Math.max(0, (r.windowEndTs - arrive45) / 60) : 0;
  console.log(
    `${r.date}  ${r.fireTs ? fmt(r.fireTs) : ' --- '}  ${fmt(r.gateTs)}  ${fmt(r.windowStartTs).padStart(7)}  ${fmt(r.windowEndTs)}  ${String(r.sustained).padStart(8)}  ${left45.toFixed(0).padStart(9)}`
  );
}

/* ===================================================================================
 * THE PART THAT ACTUALLY DECIDES THIS.
 *
 * Above, the alarm was allowed to fire from 03:30, and it mostly did — i.e. it was making a
 * 2.5-hour-ahead call, which §7.1 measured as a coin flip. Firing early looks great when you
 * only score rideable mornings, because you never count the mornings it woke you for nothing.
 *
 * So: sweep how early the alarm is ALLOWED to fire, and score both sides — sessions saved and
 * wake-ups wasted. `E` = earliest it may fire, in minutes before gate open.
 * =================================================================================== */

function fireTsFrom(points, step, earliestTs) {
  const need = Math.max(1, Math.round(TRIGGER_WINDOW_MIN / step));
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.ts < earliestTs) continue;
    const w = points.slice(Math.max(0, i - need + 1), i + 1);
    if (w.length < need) continue;
    const contiguous = w.every((x, j) => j === 0 || (x.ts - w[j - 1].ts) / 60 <= step * 1.5);
    if (!contiguous) continue;
    if (w.reduce((s, x) => s + x.speed, 0) / w.length >= TRIGGER_AVG) return p.ts;
  }
  return null;
}

const labeled = allDays.filter((d) => d.points?.length);
const rideableSet = new Map(rows.map((r) => [r.date, r]));
const nRide = rows.length;
const nDead = labeled.length - nRide;

for (const D of DRIVE_TIMES) {
  console.log(`\n=== TRADEOFF SWEEP — drive time ${D} min (n=${labeled.length} labelable days, ${nRide} rideable, ${nDead} not) ===`);
  console.log('earliest fire | sessions caught | false wakes | wakes/week | median fire time');
  console.log('--------------|-----------------|-------------|------------|------------------');

  for (const E of [180, 120, 90, 60, 45, 30, 15, 0]) {
    let caught = 0;
    let falseWakes = 0;
    const fireHours = [];

    for (const d of labeled) {
      const earliest = d.gateTs - E * 60;
      const f = fireTsFrom(d.points, d.step, earliest);
      if (f === null) continue;

      const r = rideableSet.get(d.date);
      if (r) {
        const arrive = Math.max(f + D * 60, d.gateTs);
        const left = Math.max(0, (r.windowEndTs - arrive) / 60);
        if (left >= MIN_USEFUL_SESSION_MIN) {
          caught += 1;
          fireHours.push((f - d.gateTs) / 60);
        } else {
          falseWakes += 1; // woken, drove, and the window was gone — still a wasted wake
        }
      } else {
        falseWakes += 1;
      }
    }

    const wakesPerWeek = ((caught + falseWakes) / labeled.length) * 7;
    console.log(
      `${String(`gate-${E}m`).padStart(13)} | ${`${caught}/${nRide} (${((caught / nRide) * 100).toFixed(0)}%)`.padStart(15)} | ${String(falseWakes).padStart(11)} | ${wakesPerWeek.toFixed(1).padStart(10)} | ${(fireHours.length ? `gate${quantile(fireHours, 0.5) >= 0 ? '+' : ''}${quantile(fireHours, 0.5).toFixed(0)}m` : '-').padStart(16)}`
    );
  }
}

await closePool();

