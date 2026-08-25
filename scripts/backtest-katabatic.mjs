#!/usr/bin/env node

/**
 * Backtest — replay the deterministic call rule across every archived morning.
 *
 * This is the deliverable that answers the user's actual question: *"what are we predicting, and
 * is it any good?"* It converts an unfalsifiable LLM judgment into a scored, reproducible record.
 *
 * ⚠️ NO LOOKAHEAD. Every feature is computed by `computeFeatures`, which filters to readings at
 * or before the call time. That barrier is asserted in __tests__/utils/katabaticBacktest.test.js.
 * If it is ever breached, results will look BETTER than reality — the worst failure mode here.
 *
 * Usage:
 *   node scripts/backtest-katabatic.mjs
 *   node scripts/backtest-katabatic.mjs --threshold 12 --out research/prediction-log.csv
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT, SUNRISE_COORDS } from './lib/ecowitt.mjs';
import { computeFeatures, callRule, FEATURE_VERSION as FEATURE_VERSION_V1, RULE_VERSION as RULE_VERSION_V1 } from './lib/call-rule.mjs';
import { computeFeaturesV2, callRuleV2, FEATURE_VERSION as FEATURE_VERSION_V2, RULE_VERSION as RULE_VERSION_V2 } from './lib/call-rule-v2.mjs';
import { computeFeaturesV3, callRuleV3, FEATURE_VERSION as FEATURE_VERSION_V3, RULE_VERSION as RULE_VERSION_V3 } from './lib/call-rule-v3.mjs';
import { computeFeaturesV4, callRuleV4, FEATURE_VERSION as FEATURE_VERSION_V4, RULE_VERSION as RULE_VERSION_V4 } from './lib/call-rule-v4.mjs';
import { computeFeaturesV5, callRuleV5, FEATURE_VERSION as FEATURE_VERSION_V5, RULE_VERSION as RULE_VERSION_V5 } from './lib/call-rule-v5.mjs';
import { classifySession, parseArchiveDate, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { calcSunrise } from './lib/sunrise.mjs';
import { buildLogRow } from './lib/prediction-log.mjs';
import { readAllRows, upsertRows } from './lib/prediction-log-store.mjs';
import { zonedTimeFrom } from './lib/zone.mjs';
import { readDays, storeConfigSummary, closePool } from './lib/archive-store.mjs';

const DEFAULT_OUT = join(REPO_ROOT, 'research', 'prediction-log.csv');

const TARGET_SLUG = 'dp-soda-lakes';
const NEIGHBOR_SLUGS = ['dp-standley-west', 'dp-boulder-res'];

// The window a dawn patrol decision actually gets made in.
const CALL_START_MIN = 5 * 60;
const CALL_END_MIN = 7 * 60;
const CALL_STEP_MIN = 15;

function parseArgs(argv) {
  const args = { threshold: DEFAULT_THRESHOLD_MPH, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--threshold' && next) args.threshold = parseFloat(next);
    if (argv[i] === '--out' && next) args.out = next;
  }
  return args;
}

/**
 * Load every archived day for a station, keyed by date.
 *
 * Goes through the archive store, which reads from Neon — the only store. Uses the bulk read
 * rather than a day-at-a-time loop: against Neon that would be ~900 round trips.
 */
async function loadStation(slug) {
  const byDate = new Map();
  for (const rec of await readDays(slug)) byDate.set(rec.date, rec);
  return byDate;
}

const fmtHM = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const target = await loadStation(TARGET_SLUG);
  if (!target.size) {
    console.error(`❌ No archive found for ${TARGET_SLUG} (store: ${storeConfigSummary()}). Run scripts/archive-ecowitt.mjs first.`);
    process.exit(1);
  }

  const neighbors = [];
  for (const slug of NEIGHBOR_SLUGS) neighbors.push(await loadStation(slug));

  const rows = [];
  const dayLabels = [];
  let unobserved = 0;

  for (const date of [...target.keys()].sort()) {
    const rec = target.get(date);
    // `classifySession` returns everything `labelDay` did, plus the additive canoe tier. The
    // primary `label` is unchanged, so every frozen v1–v5 result stays reproducible.
    const label = classifySession(rec, { threshold: args.threshold });

    // §4.2: unobserved is NOT a negative. Excluded entirely rather than counted as a calm day.
    if (label.label === null) {
      unobserved++;
      continue;
    }
    dayLabels.push(label);

    const day = parseArchiveDate(date);
    const sunrise = calcSunrise(day, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
    const sunriseTs = sunrise ? Math.floor(sunrise.getTime() / 1000) : null;

    const neighborSeries = neighbors
      .map((n) => n.get(date))
      .filter((r) => r && r.status === 'ok' && r.points?.length)
      .map((r) => r.points);

    for (let m = CALL_START_MIN; m <= CALL_END_MIN; m += CALL_STEP_MIN) {
      // Station-local, not machine-local — a 06:30 call means 06:30 in Colorado (see zone.mjs).
      const callTime = zonedTimeFrom(day, Math.floor(m / 60), m % 60, 0);
      const callTs = Math.floor(callTime.getTime() / 1000);

      // v1 — frozen. Must reproduce exactly what has already been documented.
      const featuresV1 = computeFeatures(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      if (featuresV1) {
        const callV1 = callRule(featuresV1, { threshold: args.threshold });
        rows.push(
          buildLogRow({
            source: 'backtest',
            date,
            callTime: fmtHM(m),
            station: rec.station,
            threshold: args.threshold,
            features: featuresV1,
            call: callV1,
            label,
            featureVersion: FEATURE_VERSION_V1,
            ruleVersion: RULE_VERSION_V1,
          })
        );
      }

      // v2 — the corrected candidate. Written as a PAIRED row (same source, distinct
      // rule_version) rather than overwriting v1, so both remain independently scoreable.
      const featuresV2 = computeFeaturesV2(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      if (featuresV2) {
        const callV2 = callRuleV2(featuresV2, { threshold: args.threshold });
        rows.push(
          buildLogRow({
            source: 'backtest',
            date,
            callTime: fmtHM(m),
            station: rec.station,
            threshold: args.threshold,
            features: featuresV2,
            call: callV2,
            label,
            featureVersion: FEATURE_VERSION_V2,
            ruleVersion: RULE_VERSION_V2,
          })
        );
      }

      // v3 — separates threshold-specific session readiness from katabatic structure.
      const featuresV3 = computeFeaturesV3(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      if (featuresV3) {
        const callV3 = callRuleV3(featuresV3, { threshold: args.threshold });
        rows.push(
          buildLogRow({
            source: 'backtest',
            date,
            callTime: fmtHM(m),
            station: rec.station,
            threshold: args.threshold,
            features: featuresV3,
            call: callV3,
            label,
            featureVersion: FEATURE_VERSION_V3,
            ruleVersion: RULE_VERSION_V3,
          })
        );
      }

      // v4 — preserves near-threshold late builders as MARGINAL while keeping severe collapses
      // and materially sub-threshold setups at NO_GO.
      const featuresV4 = computeFeaturesV4(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      if (featuresV4) {
        const callV4 = callRuleV4(featuresV4, { threshold: args.threshold });
        rows.push(
          buildLogRow({
            source: 'backtest',
            date,
            callTime: fmtHM(m),
            station: rec.station,
            threshold: args.threshold,
            features: featuresV4,
            call: callV4,
            label,
            featureVersion: FEATURE_VERSION_V4,
            ruleVersion: RULE_VERSION_V4,
          })
        );
      }

      // v5 — suppresses only materially weak or never-reached-and-collapsing amplitude.
      const featuresV5 = computeFeaturesV5(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      if (featuresV5) {
        const callV5 = callRuleV5(featuresV5, { threshold: args.threshold });
        rows.push(
          buildLogRow({
            source: 'backtest',
            date,
            callTime: fmtHM(m),
            station: rec.station,
            threshold: args.threshold,
            features: featuresV5,
            call: callV5,
            label,
            featureVersion: FEATURE_VERSION_V5,
            ruleVersion: RULE_VERSION_V5,
          })
        );
      }
    }
  }

  await mkdir(join(args.out, '..'), { recursive: true });

  // Upsert by (source, date, call_time, station, rule_version). This regenerates every backtest
  // row from scratch each run WITHOUT touching `live`/`retrospective` rows (different `source`,
  // so a different key) — those are appended by the live skill at call time and can never be
  // reconstructed. A plain overwrite would silently destroy them, exactly the unrecoverable data
  // loss §4.2 exists to prevent. v1 and v2 backtest rows also coexist rather than colliding,
  // because `rule_version` is part of the key.
  const before = await readAllRows(args.out);
  const preservedCount = before.filter((r) => r.source !== 'backtest').length;
  const result = await upsertRows(args.out, rows);
  if (preservedCount) console.log(`Preserved ${preservedCount} non-backtest row(s) (live/retrospective) from previous runs.`);

  const positives = dayLabels.filter((l) => l.label).length;
  const missedByGate = dayLabels.filter((l) => l.missedDueToGate).length;

  console.log('='.repeat(72));
  console.log(`BACKTEST — DP Soda Lakes, threshold ${args.threshold} mph`);
  console.log('='.repeat(72));
  console.log(`Scored days:        ${dayLabels.length}`);
  console.log(`Excluded (unobserved, never counted as calm): ${unobserved}`);
  console.log(`Rideable mornings:  ${positives} (${((positives / dayLabels.length) * 100).toFixed(1)}% base rate, gate-conditioned)`);
  console.log(`Blew well but before the gate opened: ${missedByGate}`);
  console.log(`Rows written (v1+v2+v3+v4+v5 paired): ${rows.length} → ${args.out} (${result.total} total rows in file)`);
  console.log(`\nNext: node scripts/score-backtest.mjs --rule-version call-rule-v1`);
  console.log(`      node scripts/score-backtest.mjs --rule-version call-rule-v2`);
  console.log(`      node scripts/score-backtest.mjs --rule-version call-rule-v3`);
  console.log(`      node scripts/score-backtest.mjs --rule-version call-rule-v4`);
  console.log(`      node scripts/score-backtest.mjs --rule-version call-rule-v5`);
}

main()
  .catch((err) => {
    console.error(`❌ Backtest failed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(closePool);
