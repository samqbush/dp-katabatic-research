/**
 * v2 features and call rule.
 *
 * v1 (`call-rule.mjs`) is frozen and must not change — see its header comment. This module is
 * where corrections found while reviewing the live skill against the research doc land instead.
 *
 * WHAT CHANGED FROM v1, AND WHY:
 *
 * 1. Neighbour signal no longer suppresses a call. v1 treated a blowing neighbour as a negative
 *    signal (`ratio > 0.9 ? -1`). §8 of the research (308 paired Soda/Standley days) found the
 *    opposite: Soda was rideable on 75% of mornings where Standley was ALSO blowing, versus 26%
 *    when Standley was flat. A blowing neighbour raises the odds of a rideable Soda morning; it
 *    must never lower them. It can still describe the event differently (a synoptic event may
 *    not die at sunrise the way a local drainage jet does) — that is wording, not suppression.
 *
 * 2. The live skill script previously computed its own bespoke stats (single-latest-reading for
 *    neighbours, a 30-minute direction window) instead of calling the shared feature function at
 *    all — the real "drift", and the reason live verdicts were never actually produced. v2 is
 *    used directly by both the backtest and the live script, so there is exactly one feature
 *    calculation from here on, not two implementations that happen to agree or (as here) don't.
 *
 * 3. Added a rolling percent-over-threshold trajectory (`pctOverThresholdSlices`,
 *    `pctOverThresholdTrendDelta`) as a CANDIDATE classifier feature. Per the calibration case in
 *    SKILL.md, `over-N` can be sliding hard while the mean-based trend word still reads HOLDING.
 *    It is carried on every feature vector and logged, but — per the promotion criteria — it does
 *    NOT alter `callRuleV2`'s score/verdict cutoffs unless a real backtest comparison shows it
 *    earns its place. Today it is descriptive only: it changes the wording a caller uses, never
 *    the go/no-go, matching SKILL.md's existing "sharpen the advice, don't suppress the go" rule.
 *
 * Everything else (thresholds, direction window, trend band, stale/hard-gate handling, park
 * access hard-stop) is byte-for-byte the same math as v1 — v2 is a targeted correction, not a
 * rewrite, so any behavior change is attributable to one of the three items above.
 */

import { computeFeatures as computeFeaturesV1, IDEAL_DIRECTION, TREND_BAND_MPH } from './call-rule.mjs';
import { FEATURE_VERSION_V2, RULE_VERSION_V2 } from './versions.mjs';

export { IDEAL_DIRECTION, TREND_BAND_MPH };

const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

/**
 * The trajectory of "share of the last 15 minutes at/above threshold", sampled at four 15-minute
 * slices covering the last hour (t-60..t-45, t-45..t-30, t-30..t-15, t-15..t). Reported oldest
 * first. `null` entries mean no readings fell in that slice (not zero — §4.2).
 */
function pctOverThresholdSlices(points, callTimeTs, threshold) {
  const slices = [];
  for (let i = 3; i >= 0; i--) {
    const end = callTimeTs - i * 15 * 60;
    const start = end - 15 * 60;
    const inSlice = points.filter((p) => p.ts > start && p.ts <= end);
    const speeds = inSlice.map((p) => p.speed);
    slices.push(speeds.length ? (speeds.filter((s) => s >= threshold).length / speeds.length) * 100 : null);
  }
  return slices;
}

/**
 * Build the v2 feature vector. Same signature as v1's `computeFeatures`; same lookahead barrier
 * (delegated to v1's own filter, so the guarantee is inherited rather than re-implemented).
 */
export function computeFeaturesV2(points, callTimeTs, opts = {}) {
  const v1 = computeFeaturesV1(points, callTimeTs, opts);
  if (!v1) return null;

  const threshold = opts.threshold ?? 15;
  const visible = points.filter((p) => p.ts <= callTimeTs);
  const slices = pctOverThresholdSlices(visible, callTimeTs, threshold);
  const observedSlices = slices.filter((s) => s !== null);
  const first = observedSlices[0] ?? null;
  const last = observedSlices[observedSlices.length - 1] ?? null;
  const trendDelta = first !== null && last !== null ? last - first : null;

  return {
    ...v1,
    pctOverThresholdSlices: slices,
    pctOverThresholdTrendDelta: trendDelta,
  };
}

/**
 * v2 call rule. Identical scoring structure to v1 except the neighbour signal (see header),
 * plus a descriptive-only note when the over-N trajectory is sliding even if the mean trend
 * isn't. That note changes wording, never `verdict`/`score` — a declining trajectory must sharpen
 * the advice, not suppress a go (SKILL.md, "Sustained level vs. the user's threshold").
 */
export function callRuleV2(f, { threshold = 15 } = {}) {
  if (!f) return { verdict: 'NO_DATA', score: null, signals: {}, reasons: ['no readings available at call time'] };

  const reasons = [];
  const signals = {};

  if (f.avg30 === null || f.avg30 === undefined) {
    return {
      verdict: 'STALE',
      score: null,
      signals: {},
      reasons: ['no readings in the last 30 minutes — meter stale or offline, conditions unknown'],
    };
  }

  if (f.avg30 < threshold * 0.6) {
    return {
      verdict: 'NO_GO',
      score: 0,
      signals: { sustained: -2 },
      reasons: [`sustained ${f.avg30.toFixed(1)} mph is far below the ${threshold} mph threshold`],
    };
  }

  let score = 0;

  if (f.avg30 >= threshold) {
    signals.sustained = 2;
    reasons.push(`sustained ${f.avg30.toFixed(1)} mph is at or above ${threshold}`);
  } else if (f.avg30 >= threshold * 0.85) {
    signals.sustained = 1;
    reasons.push(`sustained ${f.avg30.toFixed(1)} mph is marginal against ${threshold}`);
  } else {
    signals.sustained = -1;
    reasons.push(`sustained ${f.avg30.toFixed(1)} mph is below ${threshold}`);
  }
  score += signals.sustained;

  if (f.inIdealPct !== null) {
    if (f.inIdealPct >= 80) {
      signals.direction = 2;
      reasons.push(`direction locked in the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    } else if (f.inIdealPct >= 50) {
      signals.direction = 0;
      reasons.push(`direction partially in the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    } else {
      signals.direction = -2;
      reasons.push(`direction mostly outside the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    }
    score += signals.direction;
  }

  if (f.trend) {
    signals.trend = f.trend === 'BUILDING' ? 1 : f.trend === 'DECAYING' ? -1 : 0;
    score += signals.trend;
    reasons.push(`trend ${f.trend}${f.trendDelta !== null ? ` (${f.trendDelta >= 0 ? '+' : ''}${f.trendDelta.toFixed(1)} mph)` : ''}`);
  }

  if (f.rhDelta !== null) {
    signals.humidity = f.rhDelta <= -5 ? 1 : f.rhDelta >= 5 ? -1 : 0;
    score += signals.humidity;
    if (signals.humidity !== 0) reasons.push(`humidity ${f.rhDelta < 0 ? 'falling' : 'rising'} (${f.rhDelta.toFixed(0)}%)`);
  }

  // --- FIXED from v1: a blowing neighbour must never subtract. §8: P(rideable | neighbour
  // blowing) = 75% vs 26% when flat — the correlation runs the opposite direction from v1's
  // penalty. Calm neighbours remain a positive confirmation of a local jet; blowing neighbours
  // are neutral to the go/no-go (they change the *decay* story, handled below in reasons only).
  if (f.neighborMax !== null && f.avg30 > 0) {
    const ratio = f.neighborMax / f.avg30;
    signals.neighbors = ratio < 0.5 ? 1 : 0;
    score += signals.neighbors;
    if (signals.neighbors === 1) reasons.push('neighbours calm — consistent with a local drainage jet');
    else if (ratio > 0.9) reasons.push('neighbours also blowing — may be a synoptic event; does not argue against going (§8)');
  }

  if (f.minutesPastSunrise !== null && f.minutesPastSunrise > 85) {
    signals.sunrise = -2;
    score += signals.sunrise;
    reasons.push(`${f.minutesPastSunrise} min past sunrise — beyond the 75th-percentile window close`);
  } else if (f.minutesPastSunrise !== null && f.minutesPastSunrise > 57) {
    signals.sunrise = -1;
    score += signals.sunrise;
    reasons.push(`${f.minutesPastSunrise} min past sunrise — past the median window close`);
  }

  if (f.minutesUntilGate > 0 && f.minutesPastSunrise !== null && f.minutesPastSunrise + f.minutesUntilGate > 85) {
    return {
      verdict: 'NO_GO',
      score,
      signals,
      reasons: [...reasons, `gate opens in ${f.minutesUntilGate} min, by which point the event is normally over`],
    };
  }

  // Descriptive-only: sharpen the wording when over-N is sliding, never change the verdict.
  if (f.pctOverThresholdTrendDelta !== null && f.pctOverThresholdTrendDelta <= -20) {
    reasons.push(
      `over-${threshold} share fell ${Math.abs(f.pctOverThresholdTrendDelta).toFixed(0)}pp over the last hour — fading, be at the gate on time, don't count on the back half`
    );
  }

  const verdict = score >= 4 ? 'GO' : score >= 1 ? 'MARGINAL' : 'NO_GO';
  return { verdict, score, signals, reasons };
}

export const FEATURE_VERSION = FEATURE_VERSION_V2;
export const RULE_VERSION = RULE_VERSION_V2;
