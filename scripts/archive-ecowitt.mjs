#!/usr/bin/env node

/**
 * Ecowitt archiver — builds the Neon copy of the DP station history.
 *
 * Why this exists (research/katabatic-prediction.md §4.4): Ecowitt is a single point of failure,
 * and the Jan–Feb gap is proof the data is not guaranteed to exist later. This is insurance
 * against loss, and it is the substrate every backtest and P(hold) analysis reads from.
 *
 * Design constraints, all measured rather than assumed:
 *  - §4.3 Responses are size-capped (a 7-day 5min request returned 336 points, not 2016), so
 *    pulls MUST be chunked per-day and rate-limited.
 *  - §4.1 Resolution decays with age (5min → 30min after ~90 days). The 30-minute rows are true
 *    averages, not samples, and are decision-equivalent, so they are stored as first-class data.
 *  - §4.2 The winter shutdown is recorded as `unobserved`, never as calm and never as an error.
 *
 * Usage:
 *   node scripts/archive-ecowitt.mjs                      # backfill everything missing
 *   node scripts/archive-ecowitt.mjs --days 3             # just the last 3 days (daily append)
 *   node scripts/archive-ecowitt.mjs --from 2025-11-01 --to 2025-12-31
 *   node scripts/archive-ecowitt.mjs --station "DP Soda Lakes"
 *   node scripts/archive-ecowitt.mjs --force              # re-fetch days already archived
 */

import {
  getDpDevices,
  getHistory,
  sleep,
  EcowittError,
  assertResearchCredentials,
} from './lib/ecowitt.mjs';
import { classifyEmptyDay } from './lib/season.mjs';
import { zonedTimeFrom, todayAtStation, stationDayOf } from './lib/zone.mjs';
import {
  replaceDay,
  mergeDay,
  fetchedAtMap,
  dayBoundsEpoch,
  ping,
  storeConfigSummary,
  closePool,
} from './lib/archive-store.mjs';
import { spoolWrite, spoolCount, spoolReport, spoolDrain } from './lib/spool.mjs';
import { stationBySlug } from './lib/stations.mjs';

// How hard to try before giving a fetched day up to the spool. `replaceDay` is idempotent —
// delete-then-insert over one bounded day inside a transaction — so replaying it after a commit
// whose acknowledgement was lost lands on an identical end state. Retrying costs nothing and
// covers the common case: a single dropped serverless connection, not a dead database.
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_BASE_MS = 500;

// Politeness delay between per-day requests. The archive is a background chore; there is no
// reason to hammer a free API for it.
//
// Measured 2026-07-31: a full backfill at ~350ms/request tripped an undocumented Ecowitt rate
// cap ("The number of interface accesses reached the upper limit") after a few hundred calls.
// This is NOT in §4.3, which only documented the response-size cap. Backing off to a slower
// steady rate plus a real cooldown on 429-equivalents is what makes a 1300-request backfill
// survivable. Override with --delay if the limit ever changes.
const DEFAULT_REQUEST_DELAY_MS = 1200;

// Earliest date worth asking for — the Soda device was created 2025-06-09 (§4.2).
const DEFAULT_START = '2025-06-01';

function parseArgs(argv) {
  const args = { station: null, force: false, from: null, to: null, days: null, dryRun: false, delay: DEFAULT_REQUEST_DELAY_MS };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--station' && next) args.station = next;
    if (argv[i] === '--from' && next) args.from = next;
    if (argv[i] === '--to' && next) args.to = next;
    if (argv[i] === '--days' && next) args.days = parseInt(next, 10);
    if (argv[i] === '--delay' && next) args.delay = parseInt(next, 10);
    if (argv[i] === '--force') args.force = true;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

const p2 = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** Station slug: "DP Soda Lakes" -> "dp-soda-lakes". */
export function stationSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Is an already-archived day actually finished?
 *
 * A run that happens *during* a day writes that day's partial history — the scheduled workflow
 * fires mid-morning, so it captures midnight-to-then and stops. Because the archiver skipped
 * anything already archived, that stub was then frozen forever and every later run walked past
 * it. Measured 2026-07-31: 2026-07-31 held 138 of 288 rows, ending 11:25.
 *
 * That silently truncates exactly the window the research cares about, on the day the job runs.
 * So completeness is judged by whether the fetch happened after the day was over, not by whether
 * a record merely exists. Mid-flight captures are re-fetched once and then settle.
 *
 * Evaluated against a map prefetched ONCE per station rather than by calling the store's
 * isComplete() per day: that helper is readDay() underneath, so a re-backfill from DEFAULT_START
 * would be ~1300 days x 2 remote round-trips hauling ~370k observation rows across the wire and
 * discarding all of them except `fetched_at`.
 *
 * The end bound comes from dayBoundsEpoch, which is DST-aware — a hardcoded +24h would misjudge
 * the two changeover days a year, and those are real mornings in this archive.
 */
function isDayComplete(fetchedAt, date) {
  if (!fetchedAt) return false; // absent from the map = never archived
  const { endSec } = dayBoundsEpoch(date);
  return new Date(fetchedAt).getTime() >= endSec * 1000;
}


function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function eachDay(from, to) {
  const days = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cur <= to) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/**
 * Fetch and persist one station-day.
 *
 * Returns a summary describing what happened. An empty response is a legitimate, recordable
 * outcome — it is classified via `classifyEmptyDay`, never written as calm, and never thrown.
 * A transport failure is a *different* thing and is reported as `error` so the run summary can
 * surface it for a retry, rather than being silently baked into the archive as absence.
 */
async function archiveDay(device, date, { force = false, dryRun = false, archived } = {}) {
  const slug = stationSlug(device.name);

  // Deliberately NOT wrapped in a try/catch that treats a lookup failure as "not complete".
  // The file-backed version did that — an unreadable file was not evidence of anything, so it
  // re-fetched. Against Neon the same rule is actively harmful: one transient DB blip would mark
  // every day incomplete and re-fetch the entire range, burning the Ecowitt account's rate cap
  // ("The number of interface accesses reached the upper limit") for data already stored. The
  // pre-flight ping() in main() is what makes propagating correct — do not "fix" this back.
  if (!force && isDayComplete(archived.get(isoDay(date)), date)) {
    return { day: isoDay(date), status: 'skipped-exists' };
  }

  // Days before the device existed are not "missing data" — there was no station yet. Don't
  // request them, and don't let them pollute the unexplained-gap report.
  if (device.createtime) {
    const created = new Date(device.createtime * 1000);
    const createdDay = stationDayOf(created);
    if (date < createdDay) return { day: isoDay(date), status: 'pre-creation' };
  }

  const start = zonedTimeFrom(date, 0, 0, 0);
  const end = zonedTimeFrom(date, 23, 59, 59);

  let points;
  let cycleType;
  let pressure;
  try {
    ({ points, cycleType, pressure } = await getHistory(device.mac, start, end, {
      onRateLimit: (ms) => console.log(`   ⏳ rate limited — cooling down ${Math.round(ms / 1000)}s (${isoDay(date)})`),
    }));
  } catch (err) {
    return { day: isoDay(date), status: 'error', message: err.message, rateLimited: !!err.rateLimited };
  }

  if (pressure.unmatchedCount > 0 || (pressure.matchedCount === 0 && pressure.absoluteCount + pressure.relativeCount > 0)) {
    console.warn(
      `   ⚠ ${device.name} ${isoDay(date)}: pressure timestamps did not fully align with wind ` +
        `(matched=${pressure.matchedCount}, unmatched=${pressure.unmatchedCount})`
    );
  }

  const fetchedAt = new Date().toISOString();
  const base = {
    station: device.name,
    mac: device.mac,
    date: isoDay(date),
    fetched_at: fetchedAt,
    pressure_fetched_at: fetchedAt,
    pressure_cycle_type: pressure.cycleType,
    pressure_provenance: 'co-captured',
  };

  const record = points.length
    ? { ...base, status: 'ok', cycle_type: cycleType, point_count: points.length, points }
    : { ...base, ...classifyEmptyDay(date, device.name), cycle_type: null, point_count: 0, points: [] };

  let writeFailure = null;
  if (!dryRun) {
    // replaceDay, not mergeDay: this archiver rebuilds the whole day, so a refetch must replace
    // it. Merging would leave points from a previous fetch that this record no longer contains —
    // and a day re-fetched as unobserved would keep its old wind, which is the "dark day reported
    // as calm" failure the project forbids.
    writeFailure = await writeWithRetry(slug, record);
  }

  return {
    day: isoDay(date),
    status: record.status,
    reason: record.reason,
    points: points.length,
    cycleType,
    pressure,
    writeFailure,
  };
}

/**
 * Write a day, retrying briefly, and spool it if the database still will not take it.
 *
 * Retrying is safe because replaceDay is idempotent: delete-then-insert over one bounded day
 * inside a transaction, so a replay after a lost commit acknowledgement produces the identical
 * end state rather than duplicated observations.
 *
 * @returns {Promise<null|{message: string, spooled: boolean, spoolError: string|null}>} null on
 *   success. Non-null means this day is NOT in the database and the run must abort.
 */
async function writeWithRetry(slug, record) {
  let lastErr;
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    try {
      await replaceDay(slug, record);
      return null;
    } catch (err) {
      lastErr = err;
      if (attempt < WRITE_ATTEMPTS) {
        console.log(`   ↻ write of ${slug} ${record.date} failed (${err.message}) — retry ${attempt}/${WRITE_ATTEMPTS - 1}`);
        await sleep(WRITE_RETRY_BASE_MS * attempt);
      }
    }
  }

  // The points are in memory and cost rate-limit budget to obtain; Ecowitt downsamples past ~90
  // days, so dropping them here would permanently coarsen this day. Park them on disk so a later
  // run can replay them into Neon without spending another fetch.
  try {
    await spoolWrite(slug, 'replace', record);
    return { message: lastErr.message, spooled: true, spoolError: null };
  } catch (spoolErr) {
    return { message: lastErr.message, spooled: false, spoolError: spoolErr.message };
  }
}


async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Gate before a single request goes out. This job is the heaviest Ecowitt consumer in the repo
  // and Ecowitt rate-limits per account, so running it on the keys compiled into the shipped app
  // risks taking wind data down for every installed app. Refuse rather than warn.
  try {
    assertResearchCredentials();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  console.log(storeConfigSummary());

  // Pre-flight the database BEFORE the first Ecowitt call — including the device list, which is
  // itself a metered request. Neon is now the only copy, so a dead database, an expired
  // credential or no network turns every fetched day into data that cost rate-limit budget and
  // then has nowhere to go. Probing first converts that whole class of failure from silent loss
  // into a clean no-op.
  try {
    await ping();
  } catch (err) {
    console.error(
      `❌ ${err.message}\n` +
        '   Nothing was fetched, so no data was lost — Ecowitt still holds ~90 days of 5-minute\n' +
        '   history. Fix the connection and re-run.'
    );
    process.exit(1);
  }

  // Replay anything a previous run could not write before spending new requests. A spool that
  // silently never drains is data loss with better hiding, so it is shouted about verbatim.
  if ((await spoolCount()) > 0) {
    const report = await spoolReport();
    console.log(report.message);
    const drain = await spoolDrain({ replace: replaceDay, merge: mergeDay });
    console.log(`   spool: ${drain.drained.length}/${drain.attempted} replayed into Neon, ${drain.remaining} still pending`);
    for (const f of drain.failed) console.log(`   still spooled: ${f.slug} ${f.date} (${f.mode}) — ${f.error}`);
    for (const c of drain.corrupt) console.log(`   UNREADABLE spool entry: ${c.path} — ${c.error}`);
  }

  let devices;
  try {
    devices = await getDpDevices();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  if (args.station) {
    devices = devices.filter((d) => d.name.toLowerCase().includes(args.station.toLowerCase()));
    if (!devices.length) {
      console.error(`❌ No DP station matching "${args.station}".`);
      process.exit(1);
    }
  }

  const today = todayAtStation();
  let from;
  let to = args.to ? parseDay(args.to) : new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (args.days) {
    from = new Date(to);
    from.setDate(from.getDate() - (args.days - 1));
  } else {
    from = parseDay(args.from || DEFAULT_START);
  }

  // Fail before spending a single request, not after. An unregistered device would throw inside
  // the store *between* a successful fetch and the write, discarding data that cost rate-limit
  // budget. Aborting here is free: Ecowitt still holds ~90 days of 5-minute history.
  const unregistered = devices.filter((d) => {
    try {
      stationBySlug(stationSlug(d.name));
      return false;
    } catch {
      return true;
    }
  });
  if (unregistered.length) {
    console.error(
      `❌ ${unregistered.length} Ecowitt device(s) are not in scripts/lib/stations.mjs:\n` +
        unregistered.map((d) => `   ${d.name}  ->  ${stationSlug(d.name)}`).join('\n') +
        '\n   Add them there (and re-run scripts/db/apply-schema.mjs), then re-run.\n' +
        '   Nothing was fetched, so no data was lost.'
    );
    process.exit(1);
  }

  console.log(`Archiving ${devices.length} station(s) from ${isoDay(from)} to ${isoDay(to)}${args.force ? ' (force)' : ''}${args.dryRun ? ' (dry run)' : ''}`);

  const errors = [];
  const unexplained = [];
  let writeAborted = null;
  let rateLimitAborted = false;

  for (const device of devices) {
    if (rateLimitAborted || writeAborted) break;
    const days = eachDay(from, to);
    const tally = { ok: 0, unobserved: 0, 'no-data': 0, 'skipped-exists': 0, 'pre-creation': 0, error: 0 };

    // ONE query per station, not one per candidate day. See isDayComplete.
    const archived = await fetchedAtMap(stationSlug(device.name));

    for (const day of days) {
      const res = await archiveDay(device, day, { force: args.force, dryRun: args.dryRun, archived });
      tally[res.status] = (tally[res.status] || 0) + 1;

      if (res.status === 'error') errors.push({ station: device.name, ...res });
      // §4.2: an unexplained empty day is the one case a human should actually look at.
      if (res.status === 'no-data') unexplained.push({ station: device.name, day: res.day });

      // A day that would not go into Neon stops the whole run. Ecowitt is fetched per-day inside
      // this loop, so continuing would keep spending a rate cap that a few hundred calls already
      // trips, on days that cannot be stored either. Same reasoning as the rate-limit stop below.
      if (res.writeFailure) {
        writeAborted = { station: device.name, day: res.day, ...res.writeFailure };
        break;
      }

      // If the cooldown didn't clear the cap, grinding on just wastes quota. The archive is
      // idempotent, so stopping and resuming later loses nothing.
      if (res.status === 'error' && res.rateLimited) {
        console.log(`\n⏹  Still rate limited after cooldown. Stopping cleanly — re-run to resume where this left off.`);
        rateLimitAborted = true;
        break;
      }

      if (res.status !== 'skipped-exists' && res.status !== 'pre-creation') await sleep(args.delay);
    }

    console.log(
      `${device.name.padEnd(20)} ok ${tally.ok}  unobserved ${tally.unobserved}  no-data ${tally['no-data']}  ` +
        `skipped ${tally['skipped-exists']}  pre-creation ${tally['pre-creation']}  errors ${tally.error}`
    );
  }

  if (unexplained.length) {
    console.log(`\n⚠️  ${unexplained.length} unexplained empty day(s) — outside the known seasonal shutdown:`);
    for (const u of unexplained.slice(0, 20)) console.log(`   ${u.station} ${u.day}`);
    if (unexplained.length > 20) console.log(`   ... and ${unexplained.length - 20} more`);
    console.log('   These are recorded as "no-data" (unobserved), never as calm. Worth a look.');
  }

  if (writeAborted) {
    console.error(
      `\n❌ ABORTED: ${writeAborted.station} ${writeAborted.day} could not be written to Neon after ` +
        `${WRITE_ATTEMPTS} attempts.\n   Cause: ${writeAborted.message}`
    );
    if (writeAborted.spooled) {
      console.error(
        `   That day's observations were fetched successfully and are parked in .archive-spool/ —\n` +
          '   NOT in the database. Fix Neon and re-run; the next run replays them before fetching\n' +
          '   anything, so no Ecowitt request is spent twice.'
      );
    } else {
      console.error(
        `   The spool write ALSO failed (${writeAborted.spoolError}), so those observations are now\n` +
          '   only in the lost process memory. Ecowitt downsamples past ~90 days, so re-run soon:\n' +
          '   inside that window the day is still re-fetchable at 5-minute resolution, after it is not.'
      );
    }
    console.error('   The run stopped here rather than burning more of the Ecowitt rate cap on days that\n   would also fail to store.');
    process.exitCode = 1;
  }

  if (errors.length) {
    console.log(`\n❌ ${errors.length} day(s) failed to fetch. These were NOT written to the archive —`);
    console.log('   re-run to retry. A fetch failure must never be archived as absence of wind.');
    for (const e of errors.slice(0, 10)) console.log(`   ${e.station} ${e.day}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so the helpers above stay importable by the backtest.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(`❌ Archive failed: ${err instanceof EcowittError ? err.message : err.stack}`);
      process.exitCode = 1;
    })
    // katabatic-refresh.mjs spawns this and waits on it; a leaked pool would stall the refresh.
    .finally(closePool);
}
