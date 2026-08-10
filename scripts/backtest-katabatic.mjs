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

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT, SUNRISE_COORDS } from './lib/ecowitt.mjs';
import { computeFeatures, callRule } from './lib/call-rule.mjs';
import { labelDay, parseArchiveDate, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { calcSunrise } from './lib/sunrise.mjs';
import { csvHeader, toCsvRow, buildLogRow } from './lib/prediction-log.mjs';
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
    const label = labelDay(rec, { threshold: args.threshold });

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

      const features = computeFeatures(rec.points, callTs, {
        station: rec.station,
        threshold: args.threshold,
        sunriseTs,
        neighborSeries,
      });
      // No readings yet at this hour — a real morning would have nothing to look at either.
      if (!features) continue;

      const call = callRule(features, { threshold: args.threshold });
      rows.push(
        buildLogRow({
          source: 'backtest',
          date,
          callTime: fmtHM(m),
          station: rec.station,
          threshold: args.threshold,
          features,
          call,
          label,
        })
      );
    }
  }

  await mkdir(join(args.out, '..'), { recursive: true });

  // Preserve live rows. The backtest regenerates every `backtest` row from scratch each run, but
  // `live` rows are appended by katabatic-check.mjs at call time and can never be reconstructed —
  // they record what the meter showed at the moment a real decision was made. A plain overwrite
  // here would silently destroy them on the very first scheduled run, which is exactly the kind
  // of unrecoverable data loss §4.2 exists to prevent.
  let preserved = [];
  try {
    const existing = await readFile(args.out, 'utf8');
    preserved = existing
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('source,') && !line.startsWith('backtest,'))
      .map((line) => line + '\n');
  } catch {
    // No prior log — first run.
  }

  await writeFile(args.out, csvHeader() + rows.map(toCsvRow).join('') + preserved.join(''));
  if (preserved.length) console.log(`Preserved ${preserved.length} live row(s) from previous runs.`);

  const positives = dayLabels.filter((l) => l.label).length;
  const missedByGate = dayLabels.filter((l) => l.missedDueToGate).length;

  console.log('='.repeat(72));
  console.log(`BACKTEST — DP Soda Lakes, threshold ${args.threshold} mph`);
  console.log('='.repeat(72));
  console.log(`Scored days:        ${dayLabels.length}`);
  console.log(`Excluded (unobserved, never counted as calm): ${unobserved}`);
  console.log(`Rideable mornings:  ${positives} (${((positives / dayLabels.length) * 100).toFixed(1)}% base rate, gate-conditioned)`);
  console.log(`Blew well but before the gate opened: ${missedByGate}`);
  console.log(`Rows written:       ${rows.length} → ${args.out}`);
  console.log(`\nNext: node scripts/score-backtest.mjs`);
}

main()
  .catch((err) => {
    console.error(`❌ Backtest failed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(closePool);
