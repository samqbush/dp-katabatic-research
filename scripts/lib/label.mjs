/**
 * The label — the single definition of "was this morning worth it".
 *
 * ⚠️ ONE label, shared by the backtest, the live logger and any future analysis. §7 rule 1 is
 * explicit that it must be written down and not changed midway. If you are tempted to tweak it,
 * add a NEW named label instead and report both.
 *
 * AMENDED from the §7 proposal. The original read:
 *
 *     "did Soda sustain >=15 mph for >=30 continuous minutes between 05:00 and 08:00?"
 *
 * That counts mornings the user could not physically have ridden. The Bear Creek Lake Park gate
 * does not open until 08:00 in Nov–Feb and 07:00 in Mar/Apr/Oct (§4.5), so a morning blowing
 * 20 mph at 05:00 and dead by 06:00 scored as a positive despite being unreachable. Training on
 * that answers "did a rideable window exist somewhere" rather than "will I get a session if I
 * drive out now" — different questions, different conditional distributions.
 *
 * The label is therefore gate-conditioned: the qualifying window must lie ENTIRELY after gate
 * open. This lowers the measured base rate below §4.6's ~13%, which is the point.
 */

import { gateOpenHour, gateOpenTime } from './season.mjs';
import { zonedTimeFrom } from './zone.mjs';
import { calcSunrise, SUNRISE_COORDS } from './sunrise.mjs';

export const DEFAULT_THRESHOLD_MPH = 15;
export const DEFAULT_MIN_SUSTAINED_MIN = 30;

/**
 * How long after sunrise a katabatic event can still plausibly be running.
 *
 * §4.5 measured the sustained window closing a median +57 min after sunrise (25th +3, 75th +85).
 * Three hours is comfortably beyond even the long tail, so nothing real is excluded.
 *
 * This upper bound is NOT optional, and leaving it out is a trap worth flagging: without it the
 * label scans the whole day and happily counts **afternoon thermal wind** as a katabatic
 * positive. Measured on the first run, that inflated the base rate to 46% against the ~13–20%
 * §4.6 documents. Afternoon/thermal wind is a different physical problem, tracked separately in
 * the `wind-guru` project, and must never leak into this label.
 */
export const MAX_MINUTES_PAST_SUNRISE = 180;

/**
 * Coarsest archive resolution a day may have and still be labelable.
 *
 * §4.1 measured 30-min rows as decision-equivalent to 5-min rows. Ecowitt returns 240-min rows
 * for data older than roughly a year, and those are not usable: the label asks whether wind held
 * for 30 continuous minutes, which a 4-hour average is physically incapable of answering.
 */
export const MAX_LABELABLE_STEP_MIN = 30;

/**
 * How many minutes of coverage a single archived point represents.
 *
 * §4.1: the coarse points are true bucket *averages*, not samples — a 30-minute row is the mean
 * of its six 5-minute values (verified to within 0.02 mph). So one 30-minute point genuinely is
 * 30 minutes of sustained wind, and treating it as such is sound rather than a fudge.
 */
function cycleMinutes(cycleType) {
  if (cycleType === '5min') return 5;
  if (cycleType === '30min') return 30;
  const m = /^(\d+)min$/.exec(cycleType || '');
  return m ? parseInt(m[1], 10) : 5;
}

/**
 * Longest continuous stretch (in minutes) at or above `threshold`.
 *
 * A run is broken by a reading below threshold OR by a gap in the record — an outage is not
 * evidence that the wind continued, and assuming otherwise would manufacture positives.
 */
function longestSustainedRun(points, threshold, stepMin) {
  let best = { minutes: 0, startTs: null, endTs: null };
  let run = null;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    const contiguous = prev ? (p.ts - prev.ts) / 60 <= stepMin * 1.5 : true;

    if (p.speed >= threshold && (run === null || contiguous)) {
      if (run === null) run = { startTs: p.ts, endTs: p.ts, count: 1 };
      else {
        run.endTs = p.ts;
        run.count += 1;
      }
    } else if (p.speed >= threshold) {
      run = { startTs: p.ts, endTs: p.ts, count: 1 };
    } else {
      run = null;
    }

    if (run) {
      const minutes = run.count * stepMin;
      if (minutes > best.minutes) best = { minutes, startTs: run.startTs, endTs: run.endTs + stepMin * 60 };
    }
  }

  return best;
}

/**
 * Score one archived station-day.
 *
 * Returns `label: null` (NOT false) when the day is unobserved. §4.2 is emphatic that absence of
 * data must never be read as absence of wind; a null propagates that uncertainty instead of
 * silently manufacturing a negative and biasing every downstream statistic.
 */
export function labelDay(dayRecord, { threshold = DEFAULT_THRESHOLD_MPH, minSustainedMin = DEFAULT_MIN_SUSTAINED_MIN } = {}) {
  const date = parseArchiveDate(dayRecord.date);
  const gate = gateOpenTime(date);
  const gateTs = Math.floor(gate.getTime() / 1000);

  // The morning window is bounded at both ends: the gate at the front (access), sunrise+3h at
  // the back (physics). See MAX_MINUTES_PAST_SUNRISE — without the back edge this silently
  // scores afternoon thermals.
  const sunrise = calcSunrise(date, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
  const windowEndTs = sunrise
    ? Math.floor(sunrise.getTime() / 1000) + MAX_MINUTES_PAST_SUNRISE * 60
    : Math.floor(zonedTimeFrom(date, 11, 0, 0).getTime() / 1000);

  if (dayRecord.status !== 'ok' || !dayRecord.points?.length) {
    return {
      date: dayRecord.date,
      label: null,
      reason: dayRecord.reason || dayRecord.status,
      gateOpenHour: gateOpenHour(date),
      threshold,
    };
  }

  const step = cycleMinutes(dayRecord.cycle_type);

  // Resolution gate. §4.1 verified that 30-min rows are true averages and decision-equivalent
  // to 5-min rows (97% agreement) — but that finding does NOT extend to the 240-min rows the
  // API silently returns for data older than ~12 months. A 4-hour mean cannot resolve a 30-min
  // sustained run, so every such day would be labeled flat *by construction*, inventing a
  // negative out of a resolution artifact. That is the §4.2 failure mode wearing a disguise:
  // the data is present, so nothing looks wrong, and the bias is invisible in the day counts.
  // Return null and let it be excluded, exactly as an unobserved day is.
  if (step > MAX_LABELABLE_STEP_MIN) {
    return {
      date: dayRecord.date,
      label: null,
      reason: `insufficient-resolution:${dayRecord.cycle_type}`,
      gateOpenHour: gateOpenHour(date),
      cycleType: dayRecord.cycle_type,
      threshold,
    };
  }
  const inWindow = dayRecord.points.filter((p) => p.ts >= gateTs && p.ts <= windowEndTs);
  // Pre-gate but still inside the physical morning window — i.e. the event was real but the
  // park was shut. This is exactly what the gate amendment exists to stop counting.
  const beforeGate = dayRecord.points.filter((p) => p.ts < gateTs && p.ts <= windowEndTs);

  const best = longestSustainedRun(inWindow, threshold, step);
  const bestPreGate = longestSustainedRun(beforeGate, threshold, step);

  return {
    date: dayRecord.date,
    label: best.minutes >= minSustainedMin,
    sustainedMinutes: best.minutes,
    windowStartTs: best.startTs,
    windowEndTs: best.endTs,
    preGateSustainedMinutes: bestPreGate.minutes,
    missedDueToGate: best.minutes < minSustainedMin && bestPreGate.minutes >= minSustainedMin,
    gateOpenHour: gateOpenHour(date),
    sessionWindowEndTs: windowEndTs,
    cycleType: dayRecord.cycle_type,
    threshold,
    minSustainedMin,
  };
}

/**
 * Turn an archive date string into a Date carrying that calendar day.
 *
 * This is a calendar bag, not an instant: consumers (`gateOpenTime`, `classifyEmptyDay`,
 * `calcSunrise`) read Y/M/D back off it with the machine-local getters, so constructing it
 * machine-locally is what keeps that round-trip lossless. The station zone is pinned where a
 * calendar day is turned into a real instant — `zonedTime` in `gateOpenTime` and `calcSunrise` —
 * which is the only place it can be done correctly.
 */
export function parseArchiveDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
