#!/usr/bin/env node
/**
 * Timezone-independence regression test.
 *
 * This bug has shipped TWICE (research/katabatic-prediction.md §9.1). Both times it produced
 * *better-looking* numbers and nothing errored, so it survived until a human happened to notice
 * that a base rate disagreed with the research notes. That is not a reliable detector, hence this.
 *
 * The whole research pipeline defines its windows in Colorado time — park gate, overnight
 * predictor window, call times, Ecowitt request strings. Any of those built from the machine
 * clock silently shifts when the laptop travels, and a one-hour shift at the 6am gate is enough
 * to re-admit the pre-dawn mornings the gate amendment exists to exclude.
 *
 * Every assertion below is an ABSOLUTE instant or a station-local rendering, so the expected
 * values do not depend on where this runs. Run it under several zones:
 *
 *   for Z in America/Denver America/Chicago Asia/Tokyo Europe/London UTC; do
 *     TZ=$Z node scripts/test-timezone-independence.mjs || echo "FAILED under $Z"
 *   done
 *
 * Usage: node scripts/test-timezone-independence.mjs
 */

import {
  zonedTime,
  zonedHour,
  stationDayOf,
  todayAtStation,
  fmtStationDateTime,
  fmtStationTime,
} from './lib/zone.mjs';
import { gateOpenTime, gateOpenHour } from './lib/season.mjs';
import { labelDay } from './lib/label.mjs';

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

console.log(`\nTimezone independence — running under TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}\n`);

console.log('zonedTime resolves Colorado wall-clock to a fixed instant:');
// MDT (UTC-6) in August: 06:00 MDT = 12:00 UTC
check('2026-08-02 06:00 MT', zonedTime(2026, 7, 2, 6, 0).toISOString(), '2026-08-02T12:00:00.000Z');
// MST (UTC-7) in December: 08:00 MST = 15:00 UTC
check('2026-12-15 08:00 MT', zonedTime(2026, 11, 15, 8, 0).toISOString(), '2026-12-15T15:00:00.000Z');
// DST boundaries — the two days a year a naive offset gets it wrong
check('spring-forward 2026-03-08 03:00 MT', zonedTime(2026, 2, 8, 3, 0).toISOString(), '2026-03-08T09:00:00.000Z');
check('fall-back 2026-11-01 01:00 MT', zonedTime(2026, 10, 1, 1, 0).toISOString(), '2026-11-01T07:00:00.000Z');

console.log('\nReading Colorado clock fields off an absolute instant:');
const noonUtc = new Date('2026-08-02T18:00:00Z'); // 12:00 MDT
check('zonedHour', zonedHour(noonUtc), 12);
check('fmtStationDateTime', fmtStationDateTime(noonUtc), '2026-08-02 12:00:00');
check('fmtStationTime', fmtStationTime(noonUtc), '12:00 PM');

// 06:30 UTC on the 3rd is still the evening of the 2nd in Colorado. A machine east of Denver
// reads the wrong calendar day here, which picks the wrong gate hour and the wrong archive file.
const lateEvening = new Date('2026-08-03T02:30:00Z'); // 20:30 MDT on the 2nd
check('stationDayOf rolls back correctly', stationDayOf(lateEvening).getDate(), 2);

// The archive lag report subtracts an archived Colorado date from "today". If "today" comes off
// the laptop instead of the station, every zone east of Denver reports a phantom extra day of
// lag after local midnight — which is what the Holfuy ">4 days behind is urgent" rule reacts to.
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
check('todayAtStation is the station day, not the machine day',
  iso(todayAtStation()), iso(stationDayOf(new Date())));
// An archive current through the station's today must read as 0 days behind from any zone.
const [ly, lm, ld] = iso(todayAtStation()).split('-').map(Number);
check('archive lag of a same-day archive is 0',
  Math.round((todayAtStation() - new Date(ly, lm - 1, ld)) / 86400000), 0);

console.log('\nPark gate lands at the right absolute instant (§4.5):');
// August gate is 06:00 MT = 12:00 UTC
check('Aug gate hour', gateOpenHour(new Date(2026, 7, 2)), 6);
check('Aug gate instant', gateOpenTime(new Date(2026, 7, 2)).toISOString(), '2026-08-02T12:00:00.000Z');
// December gate is 08:00 MST = 15:00 UTC
check('Dec gate hour', gateOpenHour(new Date(2026, 11, 15)), 8);
check('Dec gate instant', gateOpenTime(new Date(2026, 11, 15)).toISOString(), '2026-12-15T15:00:00.000Z');

console.log('\nThe label respects the gate regardless of machine zone:');
// A synthetic morning blowing hard from 05:00-05:55 MT and dead afterwards. August gate is 06:00,
// so this must label FALSE with the run counted as pre-gate. On a machine one hour east, a
// gate built from the local clock lands at 05:00 MT and wrongly labels this rideable — which is
// exactly the failure that inflated the base rate from 29.4% to 38.7%.
const points = [];
for (let m = 0; m < 60; m += 5) {
  points.push({ ts: Math.floor(zonedTime(2026, 7, 2, 5, m).getTime() / 1000), speed: 25, gust: 30, dir: 270 });
}
for (let m = 0; m < 60; m += 5) {
  points.push({ ts: Math.floor(zonedTime(2026, 7, 2, 6, m).getTime() / 1000), speed: 2, gust: 4, dir: 90 });
}
const result = labelDay({ station: 'test', date: '2026-08-02', status: 'ok', cycle_type: '5min', points });
check('pre-gate blow is NOT rideable', result.label, false);
check('...and is counted as pre-gate', result.preGateSustainedMinutes >= 30, true);
check('...and flagged missed-due-to-gate', result.missedDueToGate, true);
check('gate hour reported as station hour', result.gateOpenHour, 6);

// The mirror case: identical wind one hour later, entirely after the gate, must be rideable.
const afterGate = points.map((p) => ({ ...p, ts: p.ts + 3600 }));
const afterResult = labelDay({ station: 'test', date: '2026-08-02', status: 'ok', cycle_type: '5min', points: afterGate });
check('post-gate blow IS rideable', afterResult.label, true);

console.log('');
if (failures) {
  console.log(`❌ ${failures} assertion(s) failed under TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}.`);
  console.log('   Something is reading the machine clock where it should use scripts/lib/zone.mjs.');
  console.log('   See research/katabatic-prediction.md §9.1 before "fixing" the expected values.');
  process.exit(1);
}
console.log('🎉 All timezone assertions passed.');
