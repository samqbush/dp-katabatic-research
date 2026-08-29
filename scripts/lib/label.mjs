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
 * The "canoe club" floor — the sustained speed at which a downwind board and a bigger foil/wing
 * still works, even though a normal session does not.
 *
 * Named for what the riders call it: on these mornings the group switches to canoe-shaped
 * downwind boards, bigger foils and bigger wings, and rides the gusts. The user's own framing is
 * "I am able to ride in these conditions as long as the gusts keep coming, but I don't truly
 * enjoy it" — so this is a real session, materially worse than a 15 mph one, and NOT the same
 * outcome. It gets its own class rather than a lowered threshold, because collapsing the two
 * would silently rewrite the meaning of all 99 archived `label-v1` positives.
 *
 * Measured over 333 labelable Soda mornings: 99 rideable @15 (29.7%), a further 62 canoe-only
 * (18.6%), 172 flat. Nearly a fifth of all mornings were previously reported as a plain negative
 * despite offering a real — if unloved — session.
 *
 * ⚠️ There is deliberately NO gust criterion, and that is an empirical result rather than a
 * simplification. "As long as the gusts keep coming" turns out to be automatically true at this
 * station: of the 62 canoe mornings, 62/62 had at least half their readings gusting >=18 mph,
 * 62/62 had a mean gust >=16, and the median gust factor was 1.53. Sustained 12–15 mph drainage
 * flow at Soda always arrives gusty — that IS the jet's signature. A gust filter would remove at
 * most one morning while adding a tunable nobody could justify from data.
 */
export const CANOE_THRESHOLD_MPH = 12;

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

function physicalMorningBounds(date) {
  const sunrise = calcSunrise(date, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
  return {
    startTs: Math.floor(zonedTimeFrom(date, 0, 0, 0).getTime() / 1000),
    endTs: sunrise
      ? Math.floor(sunrise.getTime() / 1000) + MAX_MINUTES_PAST_SUNRISE * 60
      : Math.floor(zonedTimeFrom(date, 11, 0, 0).getTime() / 1000),
  };
}

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

function finiteMax(points, field) {
  const values = points
    .map((point) => point[field])
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

/**
 * Summarize what the wind actually did during the full physical morning, independent of park
 * access. The canonical rideable label below remains gate-conditioned.
 */
export function summarizeMorningWind(
  dayRecord,
  { threshold = DEFAULT_THRESHOLD_MPH } = {},
) {
  const date = parseArchiveDate(dayRecord.date);
  const { startTs, endTs } = physicalMorningBounds(date);
  const unknown = {
    maxSpeedMph: null,
    maxGustMph: null,
    sustainedMinutes: null,
    windowStartTs: startTs,
    windowEndTs: endTs,
  };

  if (dayRecord.status !== 'ok' || !dayRecord.points?.length) return unknown;

  const step = cycleMinutes(dayRecord.cycle_type);
  if (step > MAX_LABELABLE_STEP_MIN) return unknown;

  const points = dayRecord.points.filter((point) => point.ts >= startTs && point.ts <= endTs);
  const maxSpeedMph = finiteMax(points, 'speed');
  if (maxSpeedMph === null) return unknown;

  const best = longestSustainedRun(points, threshold, step);
  return {
    maxSpeedMph,
    maxGustMph: finiteMax(points, 'gust'),
    sustainedMinutes: best.minutes,
    windowStartTs: startTs,
    windowEndTs: endTs,
  };
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
  const { endTs: windowEndTs } = physicalMorningBounds(date);

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
 * Classify one archived station-day into a session class — a NEW named label (`session-class-v1`)
 * layered strictly on top of `labelDay`, which is left byte-identical.
 *
 * §7 rule 1: a published label may not be edited, only added to. So this does not touch
 * `label-v1`; it calls it, and answers a second question the original never asked — "if it wasn't
 * a real session, was it at least a canoe session?"
 *
 *   rideable → sustained >= threshold (15) for >= 30 min, entirely after gate-open. `label-v1`.
 *   canoe    → not rideable, but sustained >= canoeThreshold (12) for >= 30 min after gate-open.
 *   flat     → neither.
 *   null     → unobserved, insufficient resolution, or otherwise unlabelable.
 *
 * §4.2 null-safety is inherited rather than reimplemented: if `labelDay` cannot label the day,
 * neither can this, and `sessionClass` is `null` — NOT `'flat'`. A dark meter is not a calm
 * morning, and a canoe session is exactly the kind of modest event a fabricated negative would
 * erase.
 */
export function classifySession(
  dayRecord,
  {
    threshold = DEFAULT_THRESHOLD_MPH,
    canoeThreshold = CANOE_THRESHOLD_MPH,
    minSustainedMin = DEFAULT_MIN_SUSTAINED_MIN,
  } = {},
) {
  const rideable = labelDay(dayRecord, { threshold, minSustainedMin });

  // Unlabelable at the primary threshold means unlabelable, full stop. Every reason labelDay
  // bails (outage, 240-min rows, no points) applies identically at the canoe threshold.
  if (rideable.label === null) {
    return {
      ...rideable,
      sessionClass: null,
      canoeThreshold,
      canoeSustainedMinutes: null,
      canoePreGateSustainedMinutes: null,
      canoeMeanGustMph: null,
      canoePeakGustMph: null,
      canoePctGustAtLeast18: null,
      canoeMissedDueToGate: null,
    };
  }

  const canoe = labelDay(dayRecord, { threshold: canoeThreshold, minSustainedMin });
  const canoeWindowPoints =
    canoe.windowStartTs === null || canoe.windowStartTs === undefined ||
    canoe.windowEndTs === null || canoe.windowEndTs === undefined
      ? []
      : dayRecord.points.filter(
        (point) => point.ts >= canoe.windowStartTs && point.ts < canoe.windowEndTs
      );
  const canoeGusts = canoeWindowPoints
    .map((point) => Number(point.gust))
    .filter(Number.isFinite);

  return {
    ...rideable,
    sessionClass: rideable.label ? 'rideable' : canoe.label ? 'canoe' : 'flat',
    canoeThreshold,
    canoeSustainedMinutes: canoe.sustainedMinutes ?? null,
    canoePreGateSustainedMinutes: canoe.preGateSustainedMinutes ?? null,
    canoeMeanGustMph: canoeGusts.length
      ? canoeGusts.reduce((sum, gust) => sum + gust, 0) / canoeGusts.length
      : null,
    canoePeakGustMph: canoeGusts.length ? Math.max(...canoeGusts) : null,
    canoePctGustAtLeast18: canoeGusts.length
      ? (canoeGusts.filter((gust) => gust >= 18).length / canoeGusts.length) * 100
      : null,
    // Same gate trap as the primary label: a morning that ran 12+ only before the gate opened is
    // not a canoe session, it is an unreachable one.
    canoeMissedDueToGate: canoe.missedDueToGate ?? null,
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
