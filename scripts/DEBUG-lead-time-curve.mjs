#!/usr/bin/env node

/**
 * DEBUG / ANALYSIS SCRIPT — safe to delete.
 *
 * LEAD-TIME CURVE. Tests the corrected hypothesis behind this whole re-examination:
 *
 *   Does forecast skill for the morning improve materially as the run gets closer to it?
 *
 * §13 scored Open-Meteo `_previous_day1` (~24 h lead) and got a bad result. The first draft of
 * the plan claimed that was "out of HRRR's range" — WRONG, HRRR's 00/06/12/18Z runs go to 48 h.
 * The surviving, weaker claim is that skill may improve between ~24 h and the ~11-14 h lead of
 * the 00Z run actually available at an 8 p.m. decision.
 *
 * This is the clean way to test it, and it needs no GRIB pipeline:
 *   - SAME product (single-runs api), so no vendor/interpolation confound
 *   - SAME mornings, so the comparison is PAIRED (§13's "100% -> 17%" was not)
 *   - SAME frozen §11.4 rule, so no threshold tuning
 *   - ONLY the run varies
 *
 * For a morning D at local 05-08:
 *   run D     T00:00  -> f11-f14  ~11-14 h lead   ACTIONABLE at 8 p.m. the evening before
 *   run D-1   T12:00  -> f23-f26  ~23-26 h lead   comparable to what §13 scored
 *   run D-1   T00:00  -> f35-f38  ~35-38 h lead   two evenings before
 *
 * Only the first is actionable. The others are diagnostic: they say how much skill exists at
 * longer lead, not what the user could have acted on.
 */

import axios from 'axios';
import fs from 'node:fs/promises';
import { readDays, closePool } from './lib/archive-store.mjs';
import { labelDay, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';

const SITE = { lat: 39.646115, lon: -105.174958 };
const SLUG = 'dp-soda-lakes';
const ARCHIVE_START = '2026-04-02';
const API = 'https://single-runs-api.open-meteo.com/v1/forecast';
const CACHE = new URL('./.lead-curve-cache.json', import.meta.url);

const mean = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shift = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The published §11.4 rule. Frozen. */
function packCall(wind, lid) {
  if (wind >= 9 && lid < 250) return 'PACK';
  if (wind < 5 && lid >= 250) return 'SLEEP IN';
  if (wind < 6 && lid >= 100) return 'SLEEP IN';
  return 'MAYBE';
}

const CONFIGS = [
  { key: 'lead11', label: '00Z same date   (~11-14 h)  <- ACTIONABLE at 8 p.m.', run: (d) => `${d}T00:00` },
  { key: 'lead23', label: '12Z prev day    (~23-26 h)  diagnostic, ~what §13 scored', run: (d) => `${shift(d, -1)}T12:00` },
  { key: 'lead35', label: '00Z prev day    (~35-38 h)  diagnostic', run: (d) => `${shift(d, -1)}T00:00` },
];

/* ---------------------------------------------------------------- labels */

const days = await readDays(SLUG, {});
const label = new Map();
for (const day of days) {
  const r = labelDay(day, { threshold: DEFAULT_THRESHOLD_MPH });
  if (r.label !== null) label.set(day.date, r.label);
}
await closePool();
const dates = [...label.keys()].filter((d) => d >= ARCHIVE_START).sort();

/* -------------------------------------------------------------- forecasts */

let cache = {};
try { cache = JSON.parse(await fs.readFile(CACHE, 'utf8')); } catch { /* first run */ }

for (const cfg of CONFIGS) {
  let miss = 0, fail = 0;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const ck = `${cfg.key}|${d}`;
    if (cache[ck] !== undefined) continue;
    miss++;
    try {
      const res = await axios.get(API, {
        params: {
          latitude: SITE.lat, longitude: SITE.lon,
          hourly: 'boundary_layer_height,wind_speed_10m',
          models: 'gfs_hrrr', run: cfg.run(d),
          timezone: 'America/Denver', wind_speed_unit: 'mph',
        },
        timeout: 60000,
      });
      const h = res.data.hourly;
      const rec = {};
      for (let j = 0; j < h.time.length; j++) {
        const [dd, tt] = h.time[j].split('T');
        if (dd !== d) continue;
        const hr = parseInt(tt.slice(0, 2), 10);
        if (hr < 5 || hr > 8) continue;
        rec[hr] = { lid: h.boundary_layer_height[j], wind: h.wind_speed_10m[j] };
      }
      cache[ck] = rec;
    } catch (e) {
      cache[ck] = null; // run genuinely unavailable — never treat as calm (§4.2)
      fail++;
    }
    await sleep(220);
    if (miss % 25 === 0) process.stdout.write(`\r  ${cfg.key}: fetched ${miss}`);
  }
  if (miss) console.log(`\r  ${cfg.key}: fetched ${miss}, unavailable ${fail}`);
  await fs.writeFile(CACHE, JSON.stringify(cache));
}

/* ---------------------------------------------------------------- scoring */

function rowsFor(key, restrictTo = null) {
  const out = [];
  for (const d of dates) {
    if (restrictTo && !restrictTo.has(d)) continue;
    const rec = cache[`${key}|${d}`];
    if (!rec) continue;
    const lids = [], winds = [];
    for (const hr of [5, 6, 7, 8]) {
      const v = rec[hr];
      if (!v) continue;
      if (Number.isFinite(v.lid)) lids.push(v.lid);
      if (Number.isFinite(v.wind)) winds.push(v.wind);
    }
    if (lids.length < 3 || winds.length < 3) continue;
    const lid = mean(lids), wind = mean(winds);
    if (!Number.isFinite(lid) || !Number.isFinite(wind)) continue;
    out.push({ date: d, rideable: label.get(d), lid, wind, call: packCall(wind, lid) });
  }
  return out;
}

function score(rows) {
  const ride = rows.filter((r) => r.rideable), dead = rows.filter((r) => !r.rideable);
  const pack = rows.filter((r) => r.call === 'PACK');
  const scored = rows.map((r) => ({ s: -r.lid, y: r.rideable ? 1 : 0 })).sort((a, b) => b.s - a.s);
  const P = scored.filter((x) => x.y).length, N = scored.length - P;
  let tp = 0, fp = 0, auc = 0, pTp = 0, pFp = 0;
  for (const x of scored) {
    if (x.y) tp++; else fp++;
    auc += (fp - pFp) * (tp + pTp) / 2; pTp = tp; pFp = fp;
  }
  return {
    n: rows.length, nRide: ride.length,
    lost: ride.length ? ride.filter((r) => r.call === 'SLEEP IN').length / ride.length : NaN,
    lostN: ride.filter((r) => r.call === 'SLEEP IN').length,
    supp: dead.length ? dead.filter((r) => r.call === 'SLEEP IN').length / dead.length : NaN,
    prec: pack.length ? pack.filter((r) => r.rideable).length / pack.length : NaN,
    nPack: pack.length,
    auc: P && N ? auc / (P * N) : NaN,
  };
}

// Restrict every lead to the mornings ALL leads resolve, so the comparison is strictly paired.
const common = new Set(dates.filter((d) => CONFIGS.every((c) => {
  const rec = cache[`${c.key}|${d}`];
  if (!rec) return false;
  const hrs = [5, 6, 7, 8].filter((h) => rec[h] && Number.isFinite(rec[h].lid) && Number.isFinite(rec[h].wind));
  return hrs.length >= 3;
})));

console.log(`\nPaired sample: ${common.size} mornings resolved at all three leads`);
const base = [...common].filter((d) => label.get(d)).length / common.size;
console.log(`Base rate: ${pct(base)}\n`);
console.log('Same mornings, same frozen §11.4 rule, same product. Only the run differs.\n');
console.log('  lead                                          sessions_lost  dead_supp  PACK prec  ROC-AUC');
for (const cfg of CONFIGS) {
  const s = score(rowsFor(cfg.key, common));
  console.log(
    `  ${cfg.label.padEnd(44)}  ${pct(s.lost).padStart(6)} (${s.lostN}/${s.nRide})` +
    `  ${pct(s.supp).padStart(6)}    ${pct(s.prec).padStart(6)} (n=${String(s.nPack).padStart(2)})   ${s.auc.toFixed(3)}`,
  );
}

console.log('\n  ROC-AUC is on the continuous lid alone (0.5 = no skill) and is the cleanest');
console.log('  lead-time comparison here: it involves no thresholds at all.');
