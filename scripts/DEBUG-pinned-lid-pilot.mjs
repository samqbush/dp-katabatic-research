#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * PINNED-LID PILOT. Scores the §11.4 rule using the HRRR boundary-layer-height forecast
 * PINNED TO THE 00Z RUN that is genuinely in hand at an 8 p.m. decision.
 *
 * Why this exists: §13.2 concluded the lid "cannot be pinned" because
 * `boundary_layer_height_previous_day1` is null across the archive. That is true of Open-Meteo's
 * PREVIOUS-RUNS api and false of its SINGLE-RUNS api, which serves 49 non-null hourly values per
 * HRRR run. So the strongest signal in the project can be scored as a real forecast after all.
 *
 * Run mapping (verified 2026-08-10): `run=<D>T00:00` is 00Z on D, which is 18:00 local on D-1.
 * The morning of D at 05-08 local is therefore f11-f14 — a ~11-14 h lead. This is the forecast a
 * human could actually consult the evening before.
 *
 * EVERYTHING scored here is fixed in research/preregistration-2026-08-10.md, written before the
 * first number was computed. The rule below is the PUBLISHED §11.4 rule copied verbatim from
 * DEBUG-pack-the-car.mjs — deliberately not re-tuned, so this test adds no new researcher
 * degrees of freedom.
 */

import axios from 'axios';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { gateOpenHour } from './lib/season.mjs';

const SITE = { lat: 39.646115, lon: -105.174958 }; // true meter coordinate (§12.2)
const SLUG = 'dp-soda-lakes';
const ARCHIVE_START = '2026-04-02'; // earliest HRRR run single-runs serves
const API = 'https://single-runs-api.open-meteo.com/v1/forecast';
const VARS = ['boundary_layer_height', 'wind_speed_10m'];

const mean = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The published §11.4 rule. Copied verbatim. Do not tune. */
function packCall(wind, lid) {
  if (wind >= 9 && lid < 250) return 'PACK';
  if (wind < 5 && lid >= 250) return 'SLEEP IN';
  if (wind < 6 && lid >= 100) return 'SLEEP IN';
  return 'MAYBE';
}

/* ----------------------------------------------------------------- labels */

const days = await readDays(SLUG, {});
const label = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) label.set(day.date, r.label);
}
await closePool();

const dates = [...label.keys()].filter((d) => d >= ARCHIVE_START).sort();
console.log(`Labelled Soda mornings from ${ARCHIVE_START}: ${dates.length}`);

/* --------------------------------------------------------------- forecasts */

const CACHE = new URL('./.pinned-lid-cache.json', import.meta.url);
const forecast = new Map();
let failed = 0;
let cached = {};
try { cached = JSON.parse(await (await import('node:fs/promises')).readFile(CACHE, 'utf8')); } catch { /* first run */ }

for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  if (cached[d]) {
    forecast.set(d, new Map(cached[d].map(([h, v]) => [Number(h), v])));
    continue;
  }
  try {
    const res = await axios.get(API, {
      params: {
        latitude: SITE.lat,
        longitude: SITE.lon,
        hourly: VARS.join(','),
        models: 'gfs_hrrr',
        run: `${d}T00:00`,
        timezone: 'America/Denver',
        wind_speed_unit: 'mph',
      },
      timeout: 60000,
    });
    const h = res.data.hourly;
    const byHour = new Map();
    for (let j = 0; j < h.time.length; j++) {
      const [dd, tt] = h.time[j].split('T');
      if (dd !== d) continue;
      byHour.set(parseInt(tt.slice(0, 2), 10), {
        lid: h.boundary_layer_height[j],
        wind: h.wind_speed_10m[j],
      });
    }
    forecast.set(d, byHour);
  } catch (e) {
    // Never record a failed fetch as data (§4.2): absence must not be read as calm.
    failed++;
    if (failed <= 3) console.log(`  fetch failed ${d}: ${e.response?.data?.reason || e.message}`);
  }
  if (i % 25 === 0) process.stdout.write(`\r  fetched ${i + 1}/${dates.length}`);
  await sleep(220);
}
console.log(`\r  fetched ${dates.length}/${dates.length}, failures: ${failed}\n`);
{
  const fs = await import('node:fs/promises');
  const out = {};
  for (const [d, m] of forecast) out[d] = [...m.entries()];
  await fs.writeFile(CACHE, JSON.stringify(out));
}

/* ---------------------------------------------------------------- features */

function buildRows(windowFor) {
  const rows = [];
  for (const d of dates) {
    const byHour = forecast.get(d);
    if (!byHour) continue;
    const hours = windowFor(d);
    const lids = [], winds = [];
    for (const hr of hours) {
      const v = byHour.get(hr);
      if (!v) continue;
      if (Number.isFinite(v.lid)) lids.push(v.lid);
      if (Number.isFinite(v.wind)) winds.push(v.wind);
    }
    if (lids.length < 3 || winds.length < 3) continue;
    const lid = mean(lids), wind = mean(winds);
    if (!Number.isFinite(lid) || !Number.isFinite(wind)) continue;
    rows.push({ date: d, rideable: label.get(d), lid, wind, call: packCall(wind, lid) });
  }
  return rows;
}

const PRIMARY_WINDOW = () => [5, 6, 7, 8];
const gateRelWindow = (d) => {
  const g = gateOpenHour(new Date(`${d}T12:00:00Z`));
  return [g - 1, g, g + 1, g + 2];
};

/* ----------------------------------------------------------------- scoring */

function endpoints(rows) {
  const ride = rows.filter((r) => r.rideable);
  const dead = rows.filter((r) => !r.rideable);
  const pack = rows.filter((r) => r.call === 'PACK');
  return {
    n: rows.length,
    nRide: ride.length,
    base: ride.length / rows.length,
    sessionsLost: ride.length ? ride.filter((r) => r.call === 'SLEEP IN').length / ride.length : NaN,
    deadSuppressed: dead.length ? dead.filter((r) => r.call === 'SLEEP IN').length / dead.length : NaN,
    packPrecision: pack.length ? pack.filter((r) => r.rideable).length / pack.length : NaN,
    nPack: pack.length,
    nSleep: rows.filter((r) => r.call === 'SLEEP IN').length,
    nMaybe: rows.filter((r) => r.call === 'MAYBE').length,
    sessionsLostCount: ride.filter((r) => r.call === 'SLEEP IN').length,
  };
}

function bootstrapCI(rows, fn, iters = 2000) {
  const out = [];
  for (let i = 0; i < iters; i++) {
    const s = new Array(rows.length);
    for (let j = 0; j < rows.length; j++) s[j] = rows[(Math.random() * rows.length) | 0];
    const v = fn(s);
    if (Number.isFinite(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? [out[Math.floor(out.length * 0.025)], out[Math.floor(out.length * 0.975)]] : [NaN, NaN];
}

/** Ranking metrics on the continuous lid. Lower lid should mean more rideable, so score = -lid. */
function rankMetrics(rows) {
  const scored = rows.map((r) => ({ s: -r.lid, y: r.rideable ? 1 : 0 })).sort((a, b) => b.s - a.s);
  const P = scored.filter((x) => x.y).length, N = scored.length - P;
  if (!P || !N) return { auc: NaN, prauc: NaN };
  let tp = 0, fp = 0, auc = 0, prevFp = 0, prevTp = 0, prauc = 0, prevRec = 0;
  for (const x of scored) {
    if (x.y) tp++; else fp++;
    auc += (fp - prevFp) * (tp + prevTp) / 2;
    const rec = tp / P, prec = tp / (tp + fp);
    if (rec > prevRec) { prauc += (rec - prevRec) * prec; prevRec = rec; }
    prevFp = fp; prevTp = tp;
  }
  return { auc: auc / (P * N), prauc };
}

/** Leave-one-out logistic on the lid -> out-of-sample probabilities -> Brier. */
function looBrier(rows) {
  const xs = rows.map((r) => r.lid), ys = rows.map((r) => (r.rideable ? 1 : 0));
  const mu = mean(xs), sd = Math.sqrt(mean(xs.map((x) => (x - mu) ** 2))) || 1;
  const z = xs.map((x) => (x - mu) / sd);
  let se = 0;
  for (let k = 0; k < rows.length; k++) {
    let b0 = 0, b1 = 0;
    for (let it = 0; it < 400; it++) {
      let g0 = 0, g1 = 0;
      for (let j = 0; j < z.length; j++) {
        if (j === k) continue;
        const p = 1 / (1 + Math.exp(-(b0 + b1 * z[j])));
        g0 += p - ys[j]; g1 += (p - ys[j]) * z[j];
      }
      b0 -= 0.05 * g0 / (z.length - 1); b1 -= 0.05 * g1 / (z.length - 1);
    }
    const p = 1 / (1 + Math.exp(-(b0 + b1 * z[k])));
    se += (p - ys[k]) ** 2;
  }
  return se / rows.length;
}

function report(title, rows, { full = false } = {}) {
  const e = endpoints(rows);
  console.log(`\n=== ${title}`);
  console.log(`n=${e.n}  rideable=${e.nRide} (${pct(e.base)} base rate)`);
  console.log(`calls: PACK ${e.nPack}, MAYBE ${e.nMaybe}, SLEEP IN ${e.nSleep}`);
  if (!full) {
    console.log(`  sessions_lost   ${pct(e.sessionsLost)} (${e.sessionsLostCount}/${e.nRide})`);
    console.log(`  dead_suppressed ${pct(e.deadSuppressed)}`);
    console.log(`  pack_precision  ${pct(e.packPrecision)} (n=${e.nPack})`);
    return e;
  }
  const ciSL = bootstrapCI(rows, (s) => endpoints(s).sessionsLost);
  const ciDS = bootstrapCI(rows, (s) => endpoints(s).deadSuppressed);
  const ciPP = bootstrapCI(rows, (s) => endpoints(s).packPrecision);
  console.log(`\n  PRIMARY   sessions_lost   ${pct(e.sessionsLost)} (${e.sessionsLostCount}/${e.nRide})  95% CI [${pct(ciSL[0])}, ${pct(ciSL[1])}]`);
  console.log(`            PASS iff <=10% and CI upper <=20%  ->  ${e.sessionsLost <= 0.10 && ciSL[1] <= 0.20 ? 'PASS' : 'FAIL'}`);
  console.log(`  CO-PRIM   dead_suppressed ${pct(e.deadSuppressed)}  95% CI [${pct(ciDS[0])}, ${pct(ciDS[1])}]`);
  console.log(`            PASS iff >=30%                     ->  ${e.deadSuppressed >= 0.30 ? 'PASS' : 'FAIL'}`);
  console.log(`  SECOND    pack_precision  ${pct(e.packPrecision)} (n=${e.nPack})  95% CI [${pct(ciPP[0])}, ${pct(ciPP[1])}]`);
  console.log(`            PASS iff >=45%                     ->  ${e.packPrecision >= 0.45 ? 'PASS' : 'FAIL'}`);
  const { auc, prauc } = rankMetrics(rows);
  console.log(`\n  continuous lid: ROC-AUC ${auc.toFixed(3)}, PR-AUC ${prauc.toFixed(3)} (base ${e.base.toFixed(3)}), LOO Brier ${looBrier(rows).toFixed(4)}`);
  const safe = e.sessionsLost <= 0.10 && ciSL[1] <= 0.20;
  const useful = e.deadSuppressed >= 0.30;
  console.log(`\n  VERDICT: ${safe && useful ? 'SUCCESS' : safe ? 'SAFE BUT USELESS' : useful ? 'UNSAFE' : 'FAILS OUTRIGHT'}`);
  return e;
}

const primary = buildRows(PRIMARY_WINDOW);
report('PRIMARY — published §11.4 rule, pinned 00Z lid, local 05-08', primary, { full: true });

/* --------------------------------------------- pre-specified secondaries */

console.log('\n\n--- pre-specified secondary analyses (preregistration §6) ---');
report('S1. Gate-relative window [gate-1, gate+2]', buildRows(gateRelWindow));

const inSeason = primary.filter((r) => {
  const m = parseInt(r.date.slice(5, 7), 10);
  return m >= 3 && m <= 10;
});
report('S2. In-season only (Mar-Oct, §4.5b)', inSeason);

const lidOnly = primary.map((r) => ({ ...r, call: r.lid >= 250 ? 'SLEEP IN' : r.lid < 100 ? 'PACK' : 'MAYBE' }));
report('S3. Lid alone, ignoring the wind term', lidOnly);

/* ------------------------------------------------------------- colour only */

console.log('\n\n--- descriptive, NOT used to support conclusions (preregistration §5) ---');
for (const [lo, hi] of [[0, 60], [60, 100], [100, 250], [250, 400], [400, 99999]]) {
  const g = primary.filter((r) => r.lid >= lo && r.lid < hi);
  if (!g.length) continue;
  const rate = g.filter((r) => r.rideable).length / g.length;
  const flag = g.length < 15 ? '  <- n<15, colour only' : '';
  console.log(`  lid ${String(lo).padStart(4)}-${String(hi === 99999 ? '+' : hi).padEnd(5)} ${pct(rate).padStart(6)}  (n=${g.length})${flag}`);
}

const anecdote = primary.find((r) => r.date === '2026-08-10');
if (anecdote) {
  console.log(`\n  [not evidence, §9] 2026-08-10: lid ${anecdote.lid.toFixed(0)}m, wind ${anecdote.wind.toFixed(1)}mph -> ${anecdote.call}, actually ${anecdote.rideable ? 'RIDEABLE' : 'dead'}`);
}

/* ------------------------------------------------------------- exploratory */

console.log('\n\n--- EXPLORATORY (preregistration §7) — hypothesis-generating ONLY.');
console.log("    These thresholds are chosen AFTER seeing the outcome and are therefore not a test.");
console.log('    They may not be quoted as a result and must be validated on data not used here.\n');
console.log('    SLEEP IN iff lid >= T   (nothing else):');
console.log('      T     sessions_lost      dead_suppressed   n(sleep)');
for (const T of [250, 300, 350, 400, 450, 500, 600]) {
  const e = endpoints(primary.map((r) => ({ ...r, call: r.lid >= T ? 'SLEEP IN' : 'MAYBE' })));
  console.log(
    `    ${String(T).padStart(4)}   ${pct(e.sessionsLost).padStart(6)} (${e.sessionsLostCount}/${e.nRide})` +
    `      ${pct(e.deadSuppressed).padStart(6)}            ${e.nSleep}`,
  );
}
