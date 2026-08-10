/**
 * The deterministic go/no-go rule.
 *
 * WHY THIS EXISTS: the call previously lived as LLM judgment in SKILL.md, which made it
 * unfalsifiable — there was no way to ask "how often is this right?" across history. Encoding it
 * as a pure function lets the backtest replay it over ~400 archived mornings.
 *
 * ⚠️ CRITICAL — NO LOOKAHEAD. `computeFeatures` must only ever see readings at or before
 * `callTime`. If a single later reading leaks in, every backtest number becomes meaningless AND
 * looks *better* than reality, which is the worst possible failure mode here. The filter lives in
 * one place for exactly that reason, and `scripts/lib/__tests__` asserts it.
 *
 * ⚠️ v1 IS A TRANSCRIPTION, NOT A FIT. The weights below are a direct reading of SKILL.md Step 2
 * and the physics in Appendix A — deliberately NOT tuned against the archive. That keeps the
 * first backtest genuinely out-of-sample. If you later tune these, you must re-score under the
 * monthly jackknife (§7 rule 4) or you are just measuring your own overfitting.
 */

import { gateOpenTime } from './season.mjs';

// Soda Lakes is the only station with a configured ideal (katabatic) direction window.
// Mirrors app/(tabs)/index.tsx and katabatic-check.mjs.
export const IDEAL_DIRECTION = {
  'DP Soda Lakes': { min: 270, max: 330, perfect: 297 },
};

// Katabatic flow is modulated by mountain waves on ~1-hour timescales, so a 30-min dip is normal
// breathing rather than the event ending. Poulos et al. (2007) predicts 1–3 m/s (2–7 mph) of
// expected modulation; the measured median intra-hour spread at this station is 5.6 mph. Both
// lines agree on ±3.0. A tighter band reports DECAYING during routine lulls — the costly error,
// because it talks the user out of a session that is still running. (§5)
export const TREND_BAND_MPH = 3.0;

export function circularMean(degrees) {
  if (!degrees.length) return null;
  let x = 0;
  let y = 0;
  for (const deg of degrees) {
    const r = (deg * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  return ((Math.atan2(y / degrees.length, x / degrees.length) * 180) / Math.PI + 360) % 360;
}

export function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function inRange(deg, min, max) {
  return min <= max ? deg >= min && deg <= max : deg >= min || deg <= max;
}

const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

/**
 * Build the feature vector visible at `callTime`.
 *
 * @param {object[]} points     Full day's points. Filtered internally — callers must NOT pre-trim.
 * @param {number}   callTimeTs Unix seconds. Nothing after this is readable.
 * @param {object[]} neighborPoints  Same-shape points from other stations, also filtered.
 */
export function computeFeatures(points, callTimeTs, { station = 'DP Soda Lakes', threshold = 15, sunriseTs = null, neighborSeries = [] } = {}) {
  // THE lookahead barrier. Everything downstream reads only `visible`.
  const visible = points.filter((p) => p.ts <= callTimeTs);
  if (!visible.length) return null;

  const ideal = IDEAL_DIRECTION[station] || null;
  const win = (mins) => visible.filter((p) => p.ts > callTimeTs - mins * 60);

  const last30 = win(30);
  const prev30 = visible.filter((p) => p.ts <= callTimeTs - 30 * 60 && p.ts > callTimeTs - 60 * 60);
  const last60 = win(60);

  const speeds30 = last30.map((p) => p.speed);
  const dirs60 = last60.map((p) => p.dir).filter(Number.isFinite);
  const meanDir = circularMean(dirs60);

  const rhPts = visible.filter((p) => Number.isFinite(p.rh));
  const rhDelta = rhPts.length > 1 ? rhPts[rhPts.length - 1].rh - rhPts[0].rh : null;

  const avg30 = mean(speeds30);
  const avgPrev30 = mean(prev30.map((p) => p.speed));
  const delta = avg30 !== null && avgPrev30 !== null ? avg30 - avgPrev30 : null;

  const neighborNow = neighborSeries
    .map((series) => {
      const nv = series.filter((p) => p.ts <= callTimeTs && p.ts > callTimeTs - 30 * 60);
      return mean(nv.map((p) => p.speed));
    })
    .filter((v) => v !== null);

  const date = new Date(callTimeTs * 1000);
  const gateTs = Math.floor(gateOpenTime(date).getTime() / 1000);

  return {
    callTimeTs,
    n: visible.length,
    avg30,
    avg60: mean(last60.map((p) => p.speed)),
    max30: speeds30.length ? Math.max(...speeds30) : null,
    min30: speeds30.length ? Math.min(...speeds30) : null,
    peakGust30: last30.length ? Math.max(...last30.map((p) => p.gust)) : null,
    pctOverThreshold30: speeds30.length ? (speeds30.filter((s) => s >= threshold).length / speeds30.length) * 100 : null,
    meanDir,
    dirConsistency: dirs60.length ? (dirs60.filter((d) => angularDiff(d, meanDir) <= 45).length / dirs60.length) * 100 : null,
    inIdealPct: ideal && dirs60.length ? (dirs60.filter((d) => inRange(d, ideal.min, ideal.max)).length / dirs60.length) * 100 : null,
    trendDelta: delta,
    trend: delta === null ? null : delta > TREND_BAND_MPH ? 'BUILDING' : delta < -TREND_BAND_MPH ? 'DECAYING' : 'HOLDING',
    rhDelta,
    neighborMax: neighborNow.length ? Math.max(...neighborNow) : null,
    minutesPastSunrise: sunriseTs ? Math.round((callTimeTs - sunriseTs) / 60) : null,
    minutesUntilGate: Math.round((gateTs - callTimeTs) / 60),
    threshold,
  };
}

/**
 * Apply the rule. Returns `{ verdict, score, signals, reasons }`.
 *
 * Verdicts are GO / MARGINAL / NO_GO. MARGINAL exists because §2's cost asymmetry makes a forced
 * binary actively harmful — a false negative costs a whole session, a false positive costs a
 * ~5-minute drive, so "probably not but go look" is a genuinely useful and honest answer.
 */
export function callRule(f, { threshold = 15 } = {}) {
  if (!f) return { verdict: 'NO_DATA', score: null, signals: {}, reasons: ['no readings available at call time'] };

  const reasons = [];
  const signals = {};

  // --- Stale/absent recent data. SKILL.md calls this "the single most dangerous failure mode",
  // and §4.2 forbids reading absence as calm. Resolve toward "go look": suppressing a morning on
  // missing data is a false negative, which costs a whole session (§2). ---
  if (f.avg30 === null || f.avg30 === undefined) {
    return {
      verdict: 'STALE',
      score: null,
      signals: {},
      reasons: ['no readings in the last 30 minutes — meter stale or offline, conditions unknown'],
    };
  }

  // --- Hard gate: nothing close to rideable. Cheap, unambiguous, and avoids scoring noise. ---
  if (f.avg30 < threshold * 0.6) {
    return {
      verdict: 'NO_GO',
      score: 0,
      signals: { sustained: -2 },
      reasons: [`sustained ${f.avg30.toFixed(1)} mph is far below the ${threshold} mph threshold`],
    };
  }

  let score = 0;

  // --- Sustained level vs. the user's actual threshold (SKILL.md Step 2) ---
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

  // --- Direction lock: "the most reliable tell" (SKILL.md Step 2) ---
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

  // --- Build shape. Note a DECAYING reading is only weakly penalised: Appendix A.3 warns that
  // sub-hourly variation is expected signal, not the event ending. ---
  if (f.trend) {
    signals.trend = f.trend === 'BUILDING' ? 1 : f.trend === 'DECAYING' ? -1 : 0;
    score += signals.trend;
    reasons.push(`trend ${f.trend}${f.trendDelta !== null ? ` (${f.trendDelta >= 0 ? '+' : ''}${f.trendDelta.toFixed(1)} mph)` : ''}`);
  }

  // --- Drying air confirms the radiative cooling that drives drainage flow ---
  if (f.rhDelta !== null) {
    signals.humidity = f.rhDelta <= -5 ? 1 : f.rhDelta >= 5 ? -1 : 0;
    score += signals.humidity;
    if (signals.humidity !== 0) reasons.push(`humidity ${f.rhDelta < 0 ? 'falling' : 'rising'} (${f.rhDelta.toFixed(0)}%)`);
  }

  // --- Neighbour contrast: a drainage jet is local. Everything blowing means a synoptic event,
  // which behaves differently and often does NOT die at sunrise. ---
  if (f.neighborMax !== null && f.avg30 > 0) {
    const ratio = f.neighborMax / f.avg30;
    signals.neighbors = ratio < 0.5 ? 1 : ratio > 0.9 ? -1 : 0;
    score += signals.neighbors;
    if (signals.neighbors === 1) reasons.push('neighbours calm — consistent with a local drainage jet');
    if (signals.neighbors === -1) reasons.push('neighbours also blowing — may be a synoptic event, not katabatic');
  }

  // --- Sunrise decay. Measured: the sustained window closes a median +57 min after sunrise
  // (25th +3, 75th +85), as solar heating erodes the nocturnal inversion (§4.5). ---
  if (f.minutesPastSunrise !== null && f.minutesPastSunrise > 85) {
    signals.sunrise = -2;
    score += signals.sunrise;
    reasons.push(`${f.minutesPastSunrise} min past sunrise — beyond the 75th-percentile window close`);
  } else if (f.minutesPastSunrise !== null && f.minutesPastSunrise > 57) {
    signals.sunrise = -1;
    score += signals.sunrise;
    reasons.push(`${f.minutesPastSunrise} min past sunrise — past the median window close`);
  }

  // --- Park access is a hard constraint, not a signal to weigh (§4.5). ---
  if (f.minutesUntilGate > 0 && f.minutesPastSunrise !== null && f.minutesPastSunrise + f.minutesUntilGate > 85) {
    return {
      verdict: 'NO_GO',
      score,
      signals,
      reasons: [...reasons, `gate opens in ${f.minutesUntilGate} min, by which point the event is normally over`],
    };
  }

  const verdict = score >= 4 ? 'GO' : score >= 1 ? 'MARGINAL' : 'NO_GO';
  return { verdict, score, signals, reasons };
}

/**
 * Collapse to the binary the label uses.
 *
 * MARGINAL and STALE both count as "go look". §2's asymmetry drives this: a false negative costs
 * an entire session while a false positive costs a ~5-minute drive, so anything short of a
 * confident "dead" should not talk the user out of the morning.
 */
export function verdictToBinary(verdict) {
  return verdict === 'GO' || verdict === 'MARGINAL' || verdict === 'STALE';
}
