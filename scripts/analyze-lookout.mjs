#!/usr/bin/env node
/**
 * Lookout Mtn ridge-flow analysis — an OPEN QUESTION, not a finding.
 *
 * §8.1 measured every accessible overnight predictor of the Soda morning session and found the
 * remote substitutes all worse than Soda's own meter (Soda AUC 0.729; Golden ridge PWS 0.627,
 * Hwy 93 RWIS 0.587, Rooney Rd RWIS 0.551), with combinations helping nothing. Lookout Mtn
 * (Holfuy 1295) is the one candidate never tested at scale, because it is the only true ridge-top
 * station inside the drainage — ~2,000 ft above Soda and upstream of the flow.
 *
 * That is a reason to COLLECT it. It is not evidence that it works, and it gets misremembered as
 * such. This script exists to settle the question with data rather than plausibility.
 *
 * The experiment is deliberately head-to-head. Reporting Lookout's AUC alone would be close to
 * meaningless: a ridge station will correlate with the session simply because both respond to the
 * same synoptic setup, so a "good" number could be entirely redundant with what Soda's own meter
 * already tells us at 5am for free. The question worth answering is whether Lookout beats SODA on
 * identical mornings. So both are scored over the same overnight window, on the same days,
 * against the same label.
 *
 * ⚠️ This script does not decide anything and must not be wired into the morning call. It appends
 * to research/lookout-log.csv and reports the state of the evidence. Per §3.3 it refuses to
 * interpret AUC below MIN_N_FOR_AUC mornings, because at n<30 the statistic is mostly noise and
 * quoting it would manufacture exactly the false confidence this file exists to prevent.
 *
 * Usage: node scripts/analyze-lookout.mjs [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { labelDay, parseArchiveDate } from './lib/label.mjs';
import { zonedTimeFrom } from './lib/zone.mjs';
import { readDays, closePool } from './lib/archive-store.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_CSV = path.join(REPO_ROOT, 'research', 'lookout-log.csv');

/**
 * Overnight predictor window, local time, matching §8.1 exactly.
 *
 * Holding this identical to the window that produced the 0.729/0.627/0.587/0.551 figures is the
 * whole point — a predictor scored over a different window is not comparable to them, and the
 * comparison is the only reason this table is interesting.
 */
const OVERNIGHT_START_HOUR = 0;
const OVERNIGHT_END_HOUR = 5;

/**
 * Minimum fraction of the overnight window that must actually be present.
 *
 * Holfuy drops out. A window with three surviving points has a computable mean that is not a
 * meaningful one, and letting it through would quietly enter noise into the sample as though it
 * were an observation. §4.2: absence is recorded, never averaged over.
 */
const MIN_COVERAGE = 0.6;

/**
 * How many minutes of the window a single sample is credited with covering.
 *
 * Holfuy days are MIXED cadence, and this is the subtle part. The archiver merges runs by
 * timestamp, so one file holds ~1-minute rows for the hours captured while they were fresh and
 * ~15-minute rows for the hours that had already thinned before anyone fetched them. The day's
 * `cycle_type` reports only the finest cadence present, so judging coverage against it fails days
 * that are in fact perfectly well observed — 2026-07-29 has 80 overnight samples at ~3.75 min
 * real spacing and scored 0.27 against a 1-minute ideal.
 *
 * Coverage is therefore measured in TIME, not sample count, by crediting each sample with the gap
 * that follows it up to this cap. 20 minutes accommodates the legitimate 15-minute cadence with
 * slack while staying inside §4.1's finding that 30-minute rows remain decision-equivalent.
 */
const SAMPLE_COVERAGE_CAP_MIN = 20;

/**
 * Below this many labelled mornings, AUC is reported as "not yet interpretable" and no ranking is
 * printed. §3.3 set 30 as the gate for acting on this dataset; the same gate applies to drawing
 * conclusions from it.
 */
const MIN_N_FOR_AUC = 30;

const COLUMNS = [
  'date',
  // --- outcome: the canonical label, computed from Soda (§7 rule 1, one shared label) ---
  'label',
  'sustained_minutes',
  'gate_open_hour',
  // --- Lookout Mtn overnight predictors ---
  'lk_coverage',
  'lk_avg',
  'lk_max',
  'lk_p50',
  'lk_mean_dir',
  'lk_dir_consistency',
  'lk_trend_delta',
  // --- Soda's own overnight predictors, same window, for head-to-head ---
  'sd_coverage',
  'sd_avg',
  'sd_max',
  'sd_p50',
  'sd_mean_dir',
  'sd_dir_consistency',
  'sd_trend_delta',
];

/** Circular mean of compass bearings, plus resultant length as a consistency measure in [0,1]. */
function circularDir(points, weights) {
  if (!points.length) return { dir: null, consistency: null };
  let x = 0;
  let y = 0;
  let wsum = 0;
  for (let i = 0; i < points.length; i++) {
    const w = weights ? weights[i] : 1;
    const r = (points[i].dir * Math.PI) / 180;
    x += Math.cos(r) * w;
    y += Math.sin(r) * w;
    wsum += w;
  }
  x /= wsum;
  y /= wsum;
  let dir = (Math.atan2(y, x) * 180) / Math.PI;
  if (dir < 0) dir += 360;
  const consistency = Math.sqrt(x * x + y * y);
  return { dir: Math.round(dir), consistency: +consistency.toFixed(3) };
}

/** Median with each value counting for its time weight, so sparse hours are not under-counted. */
function weightedMedian(values, weights) {
  if (!values.length) return null;
  const pairs = values.map((v, i) => ({ v, w: weights[i] })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((a, p) => a + p.w, 0);
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

/**
 * Summarise one station's overnight window.
 *
 * Returns null rather than zeros when the window is absent or too sparse — a calm night and an
 * offline station must never collapse to the same row.
 *
 * Every statistic here is TIME-WEIGHTED, for the mixed-cadence reason described at
 * SAMPLE_COVERAGE_CAP_MIN. A plain mean over a window holding 1-minute rows after 03:00 and
 * 15-minute rows before it is effectively a mean of the last two hours, which for a decaying
 * drainage flow is a materially different number from the overnight average it claims to be.
 */
function overnightFeatures(dayRecord, date) {
  if (!dayRecord || dayRecord.status !== 'ok' || !dayRecord.points?.length) return null;

  const start = zonedTimeFrom(date, OVERNIGHT_START_HOUR, 0, 0);
  const end = zonedTimeFrom(date, OVERNIGHT_END_HOUR, 0, 0);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);

  const pts = dayRecord.points.filter((p) => p.ts >= startTs && p.ts < endTs);
  if (!pts.length) return null;

  const capSec = SAMPLE_COVERAGE_CAP_MIN * 60;
  const weights = pts.map((p, i) => {
    const next = i + 1 < pts.length ? pts[i + 1].ts : endTs;
    return Math.min(next - p.ts, capSec);
  });
  const covered = weights.reduce((a, b) => a + b, 0);
  const coverage = Math.min(1, covered / (endTs - startTs));
  if (coverage < MIN_COVERAGE) return null;

  const wsum = weights.reduce((a, b) => a + b, 0);
  const wmean = (vals) => vals.reduce((acc, v, i) => acc + v * weights[i], 0) / wsum;

  const speeds = pts.map((p) => p.speed);
  const { dir, consistency } = circularDir(pts, weights);

  // Trend across the window: late half minus early half. A drainage flow that is still building
  // at 5am is a different animal from one already decaying, and the mean hides that entirely.
  const mid = startTs + (endTs - startTs) / 2;
  const earlyIdx = pts.map((p, i) => i).filter((i) => pts[i].ts < mid);
  const lateIdx = pts.map((p, i) => i).filter((i) => pts[i].ts >= mid);
  const wmeanIdx = (idx) => {
    const w = idx.reduce((a, i) => a + weights[i], 0);
    return w ? idx.reduce((a, i) => a + pts[i].speed * weights[i], 0) / w : null;
  };
  const eMean = wmeanIdx(earlyIdx);
  const lMean = wmeanIdx(lateIdx);
  const trendDelta = eMean !== null && lMean !== null ? +(lMean - eMean).toFixed(2) : null;

  return {
    coverage: +coverage.toFixed(2),
    avg: +wmean(speeds).toFixed(2),
    max: +Math.max(...speeds).toFixed(2),
    p50: +weightedMedian(speeds, weights).toFixed(2),
    meanDir: dir,
    dirConsistency: consistency,
    trendDelta,
  };
}

/**
 * Mann–Whitney AUC: probability a randomly chosen rideable morning scored higher than a randomly
 * chosen flat one. 0.5 is a coin flip. Ties are credited half, which matters here because a
 * dead-calm ridge produces genuinely tied low values.
 */
function auc(rows, key) {
  const usable = rows.filter((r) => r.label !== null && r[key] !== null && r[key] !== undefined);
  const pos = usable.filter((r) => r.label).map((r) => r[key]);
  const neg = usable.filter((r) => !r.label).map((r) => r[key]);
  if (!pos.length || !neg.length) return { auc: null, n: usable.length, pos: pos.length, neg: neg.length };

  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return {
    auc: +(wins / (pos.length * neg.length)).toFixed(3),
    n: usable.length,
    pos: pos.length,
    neg: neg.length,
  };
}

function escapeCsv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function build() {
  // Bulk-read both stations once. Against Neon a per-day read would be hundreds of round trips,
  // and the Lookout analysis needs the matching Soda day for every ridge day anyway.
  const lookoutDays = new Map();
  for (const rec of await readDays('lookout-mtn')) lookoutDays.set(rec.date, rec);
  const sodaDays = new Map();
  for (const rec of await readDays('dp-soda-lakes')) sodaDays.set(rec.date, rec);

  const lookoutDates = [...lookoutDays.keys()].sort();
  const rows = [];

  for (const dateStr of lookoutDates) {
    const lk = lookoutDays.get(dateStr) ?? null;
    const sd = sodaDays.get(dateStr) ?? null;
    const date = parseArchiveDate(dateStr);

    // No Soda day means no outcome to predict. Skip rather than invent one.
    if (!sd) continue;

    const outcome = labelDay(sd);
    const lkF = overnightFeatures(lk, date);
    const sdF = overnightFeatures(sd, date);

    rows.push({
      date: dateStr,
      label: outcome.label,
      sustained_minutes: outcome.sustainedMinutes ?? null,
      gate_open_hour: outcome.gateOpenHour,
      lk_coverage: lkF?.coverage ?? null,
      lk_avg: lkF?.avg ?? null,
      lk_max: lkF?.max ?? null,
      lk_p50: lkF?.p50 ?? null,
      lk_mean_dir: lkF?.meanDir ?? null,
      lk_dir_consistency: lkF?.dirConsistency ?? null,
      lk_trend_delta: lkF?.trendDelta ?? null,
      sd_coverage: sdF?.coverage ?? null,
      sd_avg: sdF?.avg ?? null,
      sd_max: sdF?.max ?? null,
      sd_p50: sdF?.p50 ?? null,
      sd_mean_dir: sdF?.meanDir ?? null,
      sd_dir_consistency: sdF?.dirConsistency ?? null,
      sd_trend_delta: sdF?.trendDelta ?? null,
    });
  }

  return rows;
}

function report(rows, quiet) {
  const withLookout = rows.filter((r) => r.lk_avg !== null);
  const scoreable = withLookout.filter((r) => r.label !== null);
  const rideable = scoreable.filter((r) => r.label).length;

  console.log('='.repeat(78));
  console.log('LOOKOUT MTN RIDGE FLOW — OPEN QUESTION, NOT A FINDING');
  console.log('='.repeat(78));
  console.log(`Days paired with a Soda day:        ${rows.length}`);
  console.log(`  ...with usable Lookout overnight: ${withLookout.length}`);
  console.log(`  ...and a non-null Soda label:     ${scoreable.length}  (${rideable} rideable)`);
  console.log(`Rows written: ${rows.length} → ${path.relative(REPO_ROOT, OUT_CSV)}`);

  if (!quiet && withLookout.length) {
    console.log('\ndate         label   sust   Lookout 00-05        Soda 00-05');
    console.log('-'.repeat(78));
    for (const r of withLookout) {
      const lab = r.label === null ? ' n/a ' : r.label ? ' YES ' : '  no ';
      const sust = r.sustained_minutes === null ? '   -' : String(r.sustained_minutes).padStart(4);
      const lk = r.lk_avg === null ? '     -    ' : `${String(r.lk_avg).padStart(5)} mph`;
      const sd = r.sd_avg === null ? '     -    ' : `${String(r.sd_avg).padStart(5)} mph`;
      console.log(`${r.date}  ${lab}  ${sust}m   ${lk} ${String(r.lk_mean_dir ?? '-').padStart(4)}°     ${sd} ${String(r.sd_mean_dir ?? '-').padStart(4)}°`);
    }
  }

  console.log('\n' + '-'.repeat(78));
  console.log('HEAD-TO-HEAD: does the ridge beat the meter we already have?');
  console.log('-'.repeat(78));

  if (scoreable.length < MIN_N_FOR_AUC) {
    const need = MIN_N_FOR_AUC - scoreable.length;
    console.log(`Not yet interpretable. ${scoreable.length} scoreable morning(s); §3.3 wants ${MIN_N_FOR_AUC}.`);
    console.log(`Need ~${need} more. AUC is deliberately not printed — at this n it would be noise,`);
    console.log('and quoting it is how an unvalidated hunch turns into a remembered "finding".');
    if (rideable === 0 || rideable === scoreable.length) {
      console.log('(Also: the sample is currently all-one-class, so AUC is undefined regardless.)');
    }
    return;
  }

  const candidates = [
    ['Lookout avg', 'lk_avg'],
    ['Lookout max', 'lk_max'],
    ['Lookout p50', 'lk_p50'],
    ['Lookout trend', 'lk_trend_delta'],
    ['Soda avg', 'sd_avg'],
    ['Soda max', 'sd_max'],
    ['Soda p50', 'sd_p50'],
    ['Soda trend', 'sd_trend_delta'],
  ];

  console.log('predictor          AUC     n   rideable  flat');
  for (const [name, key] of candidates) {
    const a = auc(scoreable, key);
    const v = a.auc === null ? '  n/a' : String(a.auc).padStart(5);
    console.log(`${name.padEnd(18)}${v}  ${String(a.n).padStart(3)}   ${String(a.pos).padStart(6)}  ${String(a.neg).padStart(4)}`);
  }

  const bestLk = Math.max(...['lk_avg', 'lk_max', 'lk_p50'].map((k) => auc(scoreable, k).auc ?? 0));
  const bestSd = Math.max(...['sd_avg', 'sd_max', 'sd_p50'].map((k) => auc(scoreable, k).auc ?? 0));
  console.log('');
  console.log(`Best Lookout: ${bestLk.toFixed(3)}   Best Soda: ${bestSd.toFixed(3)}`);
  console.log(
    bestLk > bestSd
      ? '→ Ridge is ahead on this sample. Worth a proper write-up in §8.1 before believing it.'
      : '→ Ridge does NOT beat Soda\'s own meter here, consistent with every other remote station\n  tested in §8.1. Keep collecting; do not wire it into the call.'
  );
  console.log('\n§8.1 reference (12 months, 06-08 session definition): Soda 0.729, Golden PWS 0.627,');
  console.log('Hwy 93 0.587, Rooney Rd 0.551. Those used a 06:00-08:00 outcome; the numbers above use');
  console.log('the canonical gate-conditioned label, so treat cross-comparison as indicative only.');
}

async function main() {
  const quiet = process.argv.includes('--quiet');
  const rows = await build();

  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => escapeCsv(r[c])).join(','));
  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

  report(rows, quiet);
}

main()
  .catch((err) => {
    console.error(`❌ Lookout analysis failed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(closePool);
