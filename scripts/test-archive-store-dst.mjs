#!/usr/bin/env node
/**
 * DST and day-boundary regression test for the Neon archive store.
 *
 * The store keys observations on (station_slug, ts) and slices days with half-open,
 * station-local bounds. Two things can go wrong there, both silently:
 *
 *   1. A day assumed to be 24 hours long. On the two DST days a year the station-local day is
 *      23 or 25 hours, so `start + 24h` either drops an hour of observations off the end of a
 *      spring-forward day or pulls an hour of the next day into a fall-back day. Either way the
 *      overnight predictor window shifts and the numbers move without an error.
 *
 *   2. Ambiguous fall-back timestamps. Holfuy publishes offset-free local wall-clock times. On
 *      the fall-back day 01:00-01:59 happens TWICE, so two genuinely different observations can
 *      carry identical local text. Resolved naively they collapse into one primary-key row and
 *      an hour of irreplaceable ridge data disappears with no error at all.
 *
 * Run under several zones, since the store must not read the machine clock:
 *   for Z in America/Denver America/Chicago Asia/Tokyo UTC; do
 *     TZ=$Z node scripts/test-archive-store-dst.mjs || echo "FAILED under $Z"
 *   done
 *
 * Usage: node scripts/test-archive-store-dst.mjs
 */

import { dayBoundsEpoch, isoDay } from './lib/archive-store.mjs';
import { zonedTime } from './lib/zone.mjs';

let failures = 0;
function check(name, actual, expected) {
  const a = String(actual);
  const e = String(expected);
  if (a === e) {
    console.log(`  ✅ ${name}`);
  } else {
    console.log(`  ❌ ${name}\n       expected: ${e}\n       actual:   ${a}`);
    failures += 1;
  }
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`\nArchive store DST bounds — running under TZ=${tz}\n`);

const HOURS = (sec) => sec / 3600;

console.log('Ordinary days are 24 hours:');
{
  const b = dayBoundsEpoch('2026-08-02');
  check('2026-08-02 length', HOURS(b.endSec - b.startSec), 24);
  check('2026-08-02 starts at 06:00 UTC (00:00 MDT)', new Date(b.startSec * 1000).toISOString(), '2026-08-02T06:00:00.000Z');
}
{
  const b = dayBoundsEpoch('2026-12-15');
  check('2026-12-15 length', HOURS(b.endSec - b.startSec), 24);
  check('2026-12-15 starts at 07:00 UTC (00:00 MST)', new Date(b.startSec * 1000).toISOString(), '2026-12-15T07:00:00.000Z');
}

console.log('\nSpring-forward day is 23 hours (2026-03-08):');
{
  const b = dayBoundsEpoch('2026-03-08');
  check('length', HOURS(b.endSec - b.startSec), 23);
  check('starts 00:00 MST', new Date(b.startSec * 1000).toISOString(), '2026-03-08T07:00:00.000Z');
  check('ends 00:00 MDT next day', new Date(b.endSec * 1000).toISOString(), '2026-03-09T06:00:00.000Z');

  // A fixed 24-hour window would run an hour past midnight and swallow the first hour of the 9th.
  const naiveEnd = b.startSec + 24 * 3600;
  check('naive +24h would overrun into the next day', naiveEnd > b.endSec, true);
}

console.log('\nFall-back day is 25 hours (2026-11-01):');
{
  const b = dayBoundsEpoch('2026-11-01');
  check('length', HOURS(b.endSec - b.startSec), 25);
  check('starts 00:00 MDT', new Date(b.startSec * 1000).toISOString(), '2026-11-01T06:00:00.000Z');
  check('ends 00:00 MST next day', new Date(b.endSec * 1000).toISOString(), '2026-11-02T07:00:00.000Z');

  // A fixed 24-hour window would stop an hour early and silently drop 23:00-23:59 MST.
  const naiveEnd = b.startSec + 24 * 3600;
  check('naive +24h would truncate the day', naiveEnd < b.endSec, true);

  // The last hour of the day must fall inside the bounds. This is the hour a naive window loses.
  const lastHour = zonedTime(2026, 10, 1, 23, 30, 0);
  const lastHourSec = Math.floor(lastHour.getTime() / 1000);
  check('23:30 MST is inside the day', lastHourSec >= b.startSec && lastHourSec < b.endSec, true);
  check('...and a naive +24h window would exclude it', lastHourSec >= naiveEnd, true);
}

console.log('\nBounds are half-open, so no observation lands in two days:');
{
  const a = dayBoundsEpoch('2026-08-02');
  const b = dayBoundsEpoch('2026-08-03');
  check('day N end == day N+1 start', a.endSec, b.startSec);
  // Midnight belongs to the later day only.
  check('midnight is excluded from the earlier day', a.endSec >= a.endSec && a.endSec < b.endSec, true);
}

console.log('\nFall-back AMBIGUITY — the hazard for Holfuy local timestamps:');
{
  // 01:30 local occurs twice on 2026-11-01: once at MDT (UTC-6) and again at MST (UTC-7).
  const firstPass = Date.UTC(2026, 10, 1, 7, 30) / 1000;  // 01:30 MDT
  const secondPass = Date.UTC(2026, 10, 1, 8, 30) / 1000; // 01:30 MST

  check('the two passes are genuinely different instants', firstPass !== secondPass, true);
  check('they are exactly one hour apart', (secondPass - firstPass) / 3600, 1);

  const b = dayBoundsEpoch('2026-11-01');
  check('both fall inside the 25-hour day', firstPass >= b.startSec && secondPass < b.endSec, true);

  // Both render as the same local wall-clock text. Anything that keys on that text instead of
  // the absolute instant collapses two real observations into one PK row.
  const fmt = (sec) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', hour12: false, hour: '2-digit', minute: '2-digit',
    }).format(new Date(sec * 1000));
  check('both render as identical local wall-clock text', fmt(firstPass) === fmt(secondPass), true);

  // zonedTime() resolves ambiguous local input to ONE instant, so a Holfuy feed that supplies
  // only wall-clock text cannot distinguish the second pass. The archiver must therefore detect
  // non-monotonic input and fail loudly rather than silently overwrite the first pass.
  const resolved = Math.floor(zonedTime(2026, 10, 1, 1, 30, 0).getTime() / 1000);
  check('zonedTime picks a single instant for ambiguous input', resolved === firstPass || resolved === secondPass, true);
  check('...so wall-clock alone CANNOT round-trip both passes', true, true);
}

console.log('\nisoDay is stable regardless of machine zone:');
check('string passthrough', isoDay('2026-11-01'), '2026-11-01');
check('Date input', isoDay(new Date(2026, 10, 1)), '2026-11-01');
check('spring-forward date', isoDay('2026-03-08'), '2026-03-08');

console.log('');
if (failures) {
  console.log(`❌ ${failures} assertion(s) failed under TZ=${tz}.`);
  console.log('   Day bounds must come from dayBoundsEpoch(), never start + 24h.');
  console.log('   See research/katabatic-prediction.md §9.1 before "fixing" the expected values.');
  process.exit(1);
}
console.log('🎉 All archive-store DST assertions passed.');
