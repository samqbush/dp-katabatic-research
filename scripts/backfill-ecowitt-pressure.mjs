#!/usr/bin/env node

/**
 * Retrospectively enrich existing Soda Lakes observations with Ecowitt pressure.
 *
 * This must never use replaceDay: Ecowitt may now return a coarser day than the wind archive
 * originally captured. enrichObservationPressure only fills null pressure columns on exact
 * timestamp matches, preserving every existing observation and its original provenance.
 */

import {
  assertResearchCredentials,
  EcowittError,
  getHistory,
  sleep,
} from './lib/ecowitt.mjs';
import {
  closePool,
  enrichObservationPressure,
  listPressureBackfillDays,
  mergeDay,
  ping,
  replaceDay,
  storeConfigSummary,
} from './lib/archive-store.mjs';
import { spoolCount, spoolDrain, spoolReport } from './lib/spool.mjs';
import { requireEcowittMac, SODA_SLUG, stationBySlug } from './lib/stations.mjs';
import { zonedTime } from './lib/zone.mjs';

const DEFAULT_REQUEST_DELAY_MS = 1200;

function parseArgs(argv) {
  const args = {
    from: null,
    to: null,
    force: false,
    dryRun: false,
    delay: DEFAULT_REQUEST_DELAY_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--from' && next) args.from = next;
    if (argv[i] === '--to' && next) args.to = next;
    if (argv[i] === '--delay' && next) args.delay = Number.parseInt(next, 10);
    if (argv[i] === '--force') args.force = true;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  if (!Number.isFinite(args.delay) || args.delay < 0) {
    throw new Error('--delay must be a non-negative number of milliseconds.');
  }
  return args;
}

function dayInstant(day, hour, minute, second) {
  const [year, month, date] = day.split('-').map(Number);
  return zonedTime(year, month - 1, date, hour, minute, second);
}

async function drainSpool() {
  const pending = await spoolCount();
  if (pending === 0) return;
  console.log((await spoolReport()).message);
  const result = await spoolDrain({ replace: replaceDay, merge: mergeDay });
  console.log(`Spool: ${result.drained.length}/${result.attempted} replayed, ${result.remaining} pending`);
  if (result.remaining > 0 || result.corrupt.length > 0) {
    throw new Error('Pressure backfill requires an empty, healthy archive spool.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertResearchCredentials();

  console.log(storeConfigSummary());
  await ping();
  await drainSpool();

  const station = stationBySlug(SODA_SLUG);
  const mac = requireEcowittMac(SODA_SLUG);
  const days = await listPressureBackfillDays(SODA_SLUG, args);
  console.log(
    `Pressure backfill: ${station.name}, ${days.length} archived day(s)` +
      `${args.force ? ' (force)' : ''}${args.dryRun ? ' (dry run)' : ''}`
  );

  const tally = {
    fetched: 0,
    ok: 0,
    partial: 0,
    'no-data': 0,
    matched: 0,
    unmatched: 0,
    updated: 0,
    errors: 0,
  };
  const failures = [];

  for (const day of days) {
    let history;
    try {
      history = await getHistory(
        mac,
        dayInstant(day, 0, 0, 0),
        dayInstant(day, 23, 59, 59),
        {
          onRateLimit: (ms) =>
            console.log(`   rate limited — cooling down ${Math.round(ms / 1000)}s (${day})`),
        }
      );
    } catch (err) {
      if (!(err instanceof EcowittError)) throw err;
      failures.push({ day, message: err.message });
      tally.errors += 1;
      if (err.rateLimited) break;
      await sleep(args.delay);
      continue;
    }

    tally.fetched += 1;
    if (history.pressure.unmatchedCount > 0) {
      console.warn(
        `   ${day}: ${history.pressure.unmatchedCount} pressure timestamp(s) lacked wind matches`
      );
    }

    if (!args.dryRun) {
      const result = await enrichObservationPressure(SODA_SLUG, day, history.points, {
        fetchedAt: new Date().toISOString(),
        cycleType: history.pressure.cycleType,
        provenance: 'retrospective',
      });
      tally[result.status] += 1;
      tally.matched += result.matched;
      tally.unmatched += result.unmatched + history.pressure.unmatchedCount;
      tally.updated += result.updated;
    }

    await sleep(args.delay);
  }

  console.log(
    `Fetched ${tally.fetched}; pressure days ok ${tally.ok}, partial ${tally.partial}, ` +
      `no-data ${tally['no-data']}; matched ${tally.matched}, unmatched ${tally.unmatched}, ` +
      `updated ${tally.updated}; errors ${tally.errors}`
  );

  if (failures.length) {
    console.error('\nPressure backfill did not complete cleanly:');
    for (const failure of failures) console.error(`  ${failure.day}: ${failure.message}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`Pressure backfill failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);

