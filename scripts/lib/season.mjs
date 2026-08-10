/**
 * Seasonal and park-access constraints for the DP stations.
 *
 * ⚠️ These numbers are OWNED by research/katabatic-prediction.md (§4.2, §4.5) and mirrored in
 * `.github/skills/dp-katabatic-check/SKILL.md`. If you change them, change all three or they
 * will silently drift.
 */

import { zonedTimeFrom } from './zone.mjs';

/**
 * Bear Creek Lake Park gate hours (§4.5). No amount of wind matters before the gate opens —
 * this is a hard constraint on what counts as a rideable morning.
 *
 * Indexed by month (0 = January).
 */
const GATE_OPEN_HOUR_BY_MONTH = [
  8, // Jan
  8, // Feb
  7, // Mar
  7, // Apr
  6, // May
  6, // Jun
  6, // Jul
  6, // Aug
  6, // Sep
  7, // Oct
  8, // Nov
  8, // Dec
];

/** Hour (local, 24h) the park gate opens for a given date. */
export function gateOpenHour(date) {
  return GATE_OPEN_HOUR_BY_MONTH[date.getMonth()];
}

/** Date object for gate-open on the given day, in station-local time (§ zone.mjs). */
export function gateOpenTime(date) {
  return zonedTimeFrom(date, gateOpenHour(date), 0, 0);
}

/**
 * The Soda meter runs on the ski shop's wifi, which is switched off once Little Soda freezes.
 * Observed dark 2026-01-06 → 2026-02-28, resuming 2026-03-01, and this repeats annually (§4.2).
 *
 * The data was never transmitted, so it is unrecoverable from anywhere. Absence here must be
 * recorded as *unobserved* and NEVER as calm — silently averaging zeros into a winter baseline
 * would produce exactly the confidently-wrong output this project exists to avoid.
 */
export function isSeasonalShutdown(date, stationName) {
  if (!/soda/i.test(stationName)) return false;
  const m = date.getMonth();
  const d = date.getDate();
  if (m === 0 && d >= 6) return true; // Jan 6 onward
  if (m === 1) return true; // all of Feb
  return false;
}

/**
 * The exact freeze/thaw date shifts year to year, so days just outside the observed window are
 * ambiguous rather than definitively a fault. Flag them for review instead of asserting a cause.
 */
export function isSeasonalShoulder(date, stationName) {
  if (!/soda/i.test(stationName)) return false;
  const m = date.getMonth();
  const d = date.getDate();
  if (m === 11 && d >= 15) return true; // Dec 15–31
  if (m === 0 && d <= 5) return true; // Jan 1–5
  if (m === 2 && d <= 15) return true; // Mar 1–15
  return false;
}

/**
 * Classify a day that returned no data. Never returns anything implying calm conditions.
 * `unobserved` = known seasonal shutdown; `no-data` = unexplained, needs a human look.
 */
export function classifyEmptyDay(date, stationName) {
  if (isSeasonalShutdown(date, stationName)) {
    return { status: 'unobserved', reason: 'seasonal-shutdown' };
  }
  if (isSeasonalShoulder(date, stationName)) {
    return { status: 'unobserved', reason: 'possible-seasonal-shutdown-shoulder' };
  }
  return { status: 'no-data', reason: 'unexplained' };
}
