/**
 * Active-event hold analysis — a SEPARATE problem from the go/no-go classifier.
 *
 * §4 of the plan is explicit that these are two different populations with two different
 * questions:
 *   - go/no-go classifier: "is this morning worth a drive at all?" — scored over EVERY morning.
 *   - hold analysis (this file): "given an event is ALREADY running at 05:45, will it still be
 *     running at the checkpoints that matter?" — scored ONLY over mornings already at/above
 *     threshold at 05:45. A below-threshold morning does not belong in this population; it is a
 *     go/no-go question, not a hold-duration question.
 *
 * Every function here operates on a single day's points and is careful about two failure modes
 * that would otherwise silently inflate confidence:
 *
 *   1. CENSORING. An event that is still running when the observation window (sunrise+3h, same
 *      bound `label.mjs` uses) closes has NOT been observed to end — it has been cut off. Reporting
 *      it as "ended at the window boundary" manufactures a duration that was never measured.
 *      Likewise a data gap (an outage) must not be read as the event dying quietly — §4.2's rule
 *      against reading absence as calm applies here exactly as it does to the label.
 *   2. PRE-GATE DEATHS. An event active at 05:45 that dies before the gate opens is real data
 *      about how long these events last — excluding it (looking only at events that survive to
 *      the gate) would select for survivors and bias every downstream duration estimate long.
 */

import { gateOpenTime } from './season.mjs';
import { MAX_MINUTES_PAST_SUNRISE } from './label.mjs';

function cycleMinutes(cycleType) {
  if (cycleType === '5min') return 5;
  if (cycleType === '30min') return 30;
  const m = /^(\d+)min$/.exec(cycleType || '');
  return m ? parseInt(m[1], 10) : 5;
}

/**
 * Trailing 30-minute average ending at `ts`, or `null` if there is no data in that window
 * (unknown — never coerced to below-threshold, per §4.2).
 */
function trailingAvg30(points, ts) {
  const win = points.filter((p) => p.ts <= ts && p.ts > ts - 30 * 60);
  if (!win.length) return null;
  return win.reduce((a, p) => a + p.speed, 0) / win.length;
}

/**
 * Was the event at or above `threshold` at `ts`? Returns 'above' | 'below' | 'unknown'.
 * 'unknown' covers both a genuine data gap AND a checkpoint that falls after the last archived
 * point for the day — both are "we don't know", never "it must have died".
 */
export function checkpointStatus(points, ts, threshold) {
  const avg = trailingAvg30(points, ts);
  if (avg === null) return 'unknown';
  return avg >= threshold ? 'above' : 'below';
}

/**
 * Descriptive full-event-end timing for an event already running at `fromTs`.
 *
 * Walks forward from `fromTs` to `toTs` (the observation window's outer bound) looking for the
 * first point that drops below `threshold`. Three outcomes:
 *   - `{ observed: true, endTs }`         — the run visibly ended inside the window.
 *   - `{ observed: false, reason: 'gap' }` — the data stops (a real gap) before either an end or
 *      the window boundary is reached. We cannot claim to know what happened in the gap.
 *   - `{ observed: false, reason: 'censored' }` — the event was still above threshold at every
 *      point through `toTs` — it did not end inside the observation window, it was cut off by it.
 */
export function findEventEnd(points, fromTs, toTs, threshold, stepMin) {
  const inWindow = points.filter((p) => p.ts >= fromTs && p.ts <= toTs).sort((a, b) => a.ts - b.ts);
  if (!inWindow.length) return { observed: false, reason: 'gap' };

  let prevTs = fromTs;
  for (const p of inWindow) {
    const gapMinutes = (p.ts - prevTs) / 60;
    // A gap materially larger than one step is a real outage, not a smooth continuation — we
    // cannot see what the wind did during it, so we must not claim an observed death just after.
    if (gapMinutes > stepMin * 1.5 && prevTs !== fromTs) {
      return { observed: false, reason: 'gap' };
    }
    if (p.speed < threshold) {
      return { observed: true, endTs: p.ts, durationMinutes: Math.round((p.ts - fromTs) / 60) };
    }
    prevTs = p.ts;
  }

  // Reached the end of available data without a drop. If that data reaches (approximately) the
  // window boundary, the event was genuinely still running when observation stopped — censored,
  // not missing. If it stops well short of the boundary, that shortfall is itself a gap.
  const lastTs = inWindow[inWindow.length - 1].ts;
  if (toTs - lastTs > stepMin * 1.5 * 60) return { observed: false, reason: 'gap' };
  return { observed: false, reason: 'censored', durationMinutes: Math.round((lastTs - fromTs) / 60) };
}

/**
 * Analyze one archived day already confirmed active (avg30 >= threshold) at `callTs`.
 * Returns null if the day cannot be analyzed at all (no points past callTs).
 */
export function analyzeActiveDay(dayRecord, callTs, threshold) {
  const points = dayRecord.points;
  const step = cycleMinutes(dayRecord.cycle_type);
  const day = new Date(callTs * 1000);
  const gateTs = Math.floor(gateOpenTime(day).getTime() / 1000);

  // The same descriptive outer bound the label uses — an event still blowing at sunrise+3h is
  // astronomically implausible to be genuinely katabatic, but more importantly, three hours past
  // sunrise is far past anything this analysis is meant to speak to.
  const windowEndTs = callTs + MAX_MINUTES_PAST_SUNRISE * 60;

  const checkpoints = {
    gate: gateTs,
    gatePlus30: gateTs + 30 * 60,
    gatePlus60: gateTs + 60 * 60,
  };

  const checkpointResults = {};
  for (const [name, ts] of Object.entries(checkpoints)) {
    checkpointResults[name] = ts > windowEndTs ? 'unknown' : checkpointStatus(points, ts, threshold);
  }

  const eventEnd = findEventEnd(points, callTs, windowEndTs, threshold, step);

  return { checkpoints: checkpointResults, eventEnd };
}

/**
 * Minimum sample for reporting a group-specific rate on its own (plan's promotion-criteria bar,
 * §4). Smaller groups fall back to the overall active-event rate — the caller must always show
 * both sample sizes when it does, never present the fallback silently.
 */
export const MIN_GROUP_SIZE = 15;

/**
 * Decide whether a group summary (from `summarizeGroup`) is large enough to report on its own, or
 * whether the caller should fall back to the overall rate instead. Centralized here (rather than
 * re-implemented at each call site) so the exact same n>=15 rule governs the CLI report, the
 * generated JSON artifact's consumers, and this file's own tests.
 */
export function pickGroupOrOverall(group, overall, minGroupSize = MIN_GROUP_SIZE) {
  const useGroup = Boolean(group) && group.n >= minGroupSize;
  return { useGroup, summary: useGroup ? group : overall };
}

/**
 * Summarize a group of `analyzeActiveDay` results into checkpoint hold rates and a censoring-aware
 * duration distribution.
 *
 * `minGroupSize` (default 15, per the plan's promotion criteria) is the smallest sample a
 * group-specific rate may be reported for; smaller groups fall back to the caller reporting the
 * overall rate instead, with both sample sizes disclosed.
 */
export function summarizeGroup(results) {
  const n = results.length;
  const rate = (name) => {
    const known = results.filter((r) => r.checkpoints[name] !== 'unknown');
    const above = known.filter((r) => r.checkpoints[name] === 'above');
    return { n: known.length, above: above.length, rate: known.length ? above.length / known.length : null };
  };

  const observedDurations = results.filter((r) => r.eventEnd.observed).map((r) => r.eventEnd.durationMinutes);
  const censoredDurations = results.filter((r) => !r.eventEnd.observed && r.eventEnd.reason === 'censored').map((r) => r.eventEnd.durationMinutes);
  const gaps = results.filter((r) => !r.eventEnd.observed && r.eventEnd.reason === 'gap').length;

  const sorted = [...observedDurations].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

  return {
    n,
    gate: rate('gate'),
    gatePlus30: rate('gatePlus30'),
    gatePlus60: rate('gatePlus60'),
    duration: {
      observedCount: observedDurations.length,
      censoredCount: censoredDurations.length,
      unknownDueToGap: gaps,
      medianMinutes: pct(50),
      p25Minutes: pct(25),
      p75Minutes: pct(75),
      minObservedMinutes: sorted.length ? sorted[0] : null,
      maxObservedMinutes: sorted.length ? sorted[sorted.length - 1] : null,
      // Censored events ran at LEAST this long — reported separately, never averaged into the
      // observed distribution, which would understate how long these events really run.
      minCensoredMinutes: censoredDurations.length ? Math.min(...censoredDurations) : null,
    },
  };
}
