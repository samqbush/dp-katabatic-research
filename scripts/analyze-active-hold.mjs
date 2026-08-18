#!/usr/bin/env node

/**
 * Analyze active-event hold outcomes — the separate problem from the go/no-go classifier (§4).
 *
 * Population: every archived DP Soda Lakes morning where the 30-minute average at 05:45 was
 * already at or above the threshold. This is pre-registered as the active-event definition BEFORE
 * looking at outcomes (§4's requirement) — a below-threshold morning belongs to the classifier,
 * not here.
 *
 * Reports, separately for each gate-hour group (never pooled):
 *   - hold rate at three fixed checkpoints (gate-open, gate+30, gate+60), with observed/unknown
 *     counts, falling back to the overall active-event rate when a group has fewer than
 *     MIN_GROUP_SIZE (15) events;
 *   - a censoring-aware descriptive duration distribution (median/range of OBSERVED ends, with
 *     censored and gap counts reported separately, never averaged in).
 *
 * Writes `research/active-hold-calibration.json`, a static artifact the live skill reads so a real
 * morning's checkpoint guidance comes from measured history rather than being re-derived (or
 * guessed) at call time.
 *
 * Usage:
 *   node scripts/analyze-active-hold.mjs
 *   node scripts/analyze-active-hold.mjs --threshold 12
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT, SUNRISE_COORDS } from './lib/ecowitt.mjs';
import { computeFeatures } from './lib/call-rule.mjs';
import { computeFeaturesV2 } from './lib/call-rule-v2.mjs';
import { labelDay, parseArchiveDate, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { calcSunrise } from './lib/sunrise.mjs';
import { gateOpenHour } from './lib/season.mjs';
import { zonedTimeFrom } from './lib/zone.mjs';
import { readDays, closePool } from './lib/archive-store.mjs';
import { analyzeActiveDay, summarizeGroup, pickGroupOrOverall, MIN_GROUP_SIZE } from './lib/active-hold.mjs';

const TARGET_SLUG = 'dp-soda-lakes';
const NEIGHBOR_SLUGS = ['dp-standley-west', 'dp-boulder-res'];
const CALL_TIME = { hour: 5, minute: 45 }; // the actual automated call time
const OUT_PATH = join(REPO_ROOT, 'research', 'active-hold-calibration.json');

function parseArgs(argv) {
  const args = { threshold: DEFAULT_THRESHOLD_MPH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold' && argv[i + 1]) args.threshold = parseFloat(argv[i + 1]);
  }
  return args;
}

function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

function printRate(label, r, overall) {
  const { useGroup, summary: shown } = pickGroupOrOverall(r, overall);
  const note = useGroup ? '' : ` (n=${r.n} < ${MIN_GROUP_SIZE}, showing overall rate instead)`;
  console.log(`    ${label.padEnd(14)} ${pct(shown.rate)} (${shown.above}/${shown.n})${note}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const byDate = new Map();
  for (const rec of await readDays(TARGET_SLUG)) byDate.set(rec.date, rec);

  const neighborByDate = [];
  for (const slug of NEIGHBOR_SLUGS) {
    const m = new Map();
    for (const rec of await readDays(slug)) m.set(rec.date, rec);
    neighborByDate.push(m);
  }

  const active = []; // { date, gateHour, result, trendFalling }

  for (const date of [...byDate.keys()].sort()) {
    const rec = byDate.get(date);
    const label = labelDay(rec, { threshold: args.threshold });
    if (label.label === null) continue; // §4.2 — unobserved, not part of any population

    const day = parseArchiveDate(date);
    const sunrise = calcSunrise(day, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
    const sunriseTs = sunrise ? Math.floor(sunrise.getTime() / 1000) : null;
    const callTime = zonedTimeFrom(day, CALL_TIME.hour, CALL_TIME.minute, 0);
    const callTs = Math.floor(callTime.getTime() / 1000);

    const neighborSeries = neighborByDate
      .map((m) => m.get(date))
      .filter((r) => r && r.status === 'ok' && r.points?.length)
      .map((r) => r.points);

    const features = computeFeatures(rec.points, callTs, { station: rec.station, threshold: args.threshold, sunriseTs, neighborSeries });
    if (!features || features.avg30 === null || features.avg30 < args.threshold) continue; // pre-registered population only

    const featuresV2 = computeFeaturesV2(rec.points, callTs, { station: rec.station, threshold: args.threshold, sunriseTs, neighborSeries });
    const trendFalling = featuresV2?.pctOverThresholdTrendDelta !== null && featuresV2?.pctOverThresholdTrendDelta <= -20;

    const result = analyzeActiveDay(rec, callTs, args.threshold);
    active.push({ date, gateHour: gateOpenHour(day), result, trendFalling });
  }

  console.log('='.repeat(72));
  console.log(`ACTIVE-EVENT HOLD ANALYSIS — threshold ${args.threshold} mph, call time 05:45`);
  console.log('='.repeat(72));
  console.log(`Pre-registered active-event population (avg30 >= threshold at 05:45): ${active.length} morning(s)`);
  console.log('(One year of data per calendar month — descriptive, not proof of seasonal generalization.)\n');

  const overall = summarizeGroup(active.map((a) => a.result));

  const gateGroups = {};
  for (const gh of [...new Set(active.map((a) => a.gateHour))].sort()) {
    gateGroups[gh] = summarizeGroup(active.filter((a) => a.gateHour === gh).map((a) => a.result));
  }

  for (const [gh, g] of Object.entries(gateGroups)) {
    const seasonNote = Number(gh) === 8 ? ' (Nov-Feb, out of season)' : '';
    console.log(`Gate ${gh}:00${seasonNote} — n=${g.n}`);
    printRate('at gate', g.gate, overall.gate);
    printRate('gate+30', g.gatePlus30, overall.gatePlus30);
    printRate('gate+60', g.gatePlus60, overall.gatePlus60);
    console.log(
      `    duration: observed=${g.duration.observedCount} censored=${g.duration.censoredCount} ` +
        `gap=${g.duration.unknownDueToGap}` +
        (g.duration.medianMinutes !== null
          ? `  median +${g.duration.medianMinutes}min (p25 +${g.duration.p25Minutes}, p75 +${g.duration.p75Minutes})`
          : '  no observed ends')
    );
    if (g.duration.minCensoredMinutes !== null) {
      console.log(`    censored events ran AT LEAST ${g.duration.minCensoredMinutes}min (still running when observation stopped)`);
    }
    console.log('');
  }

  // Trajectory comparison — descriptive only, per §4's "may shorten the expected window but must
  // not by itself change a go recommendation into no-go".
  const fallingGroup = summarizeGroup(active.filter((a) => a.trendFalling).map((a) => a.result));
  const notFallingGroup = summarizeGroup(active.filter((a) => !a.trendFalling).map((a) => a.result));
  console.log(`Trajectory comparison (pctOverThresholdTrendDelta <= -20 at 05:45):`);
  console.log(`  falling    n=${fallingGroup.n}`);
  printRate('gate+30', fallingGroup.gatePlus30, overall.gatePlus30);
  console.log(`  not falling n=${notFallingGroup.n}`);
  printRate('gate+30', notFallingGroup.gatePlus30, overall.gatePlus30);

  console.log(`\nOverall — n=${overall.n}`);
  printRate('at gate', overall.gate, overall.gate);
  printRate('gate+30', overall.gatePlus30, overall.gatePlus30);
  printRate('gate+60', overall.gatePlus60, overall.gatePlus60);

  const artifact = {
    generatedAt: new Date().toISOString(),
    threshold: args.threshold,
    minGroupSize: MIN_GROUP_SIZE,
    overall,
    byGateHour: gateGroups,
    trajectory: { falling: fallingGroup, notFalling: notFallingGroup },
    note:
      'Descriptive, censoring-aware. Each calendar month has one year of evidence — do not treat ' +
      'any month/season-specific rate as validated seasonal generalization. Group rates fall back ' +
      `to the overall rate below n=${MIN_GROUP_SIZE}.`,
  };
  await writeFile(OUT_PATH, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`\nWrote calibration artifact → ${OUT_PATH}`);
}

main()
  .catch((err) => {
    console.error(`❌ Active-hold analysis failed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(closePool);
