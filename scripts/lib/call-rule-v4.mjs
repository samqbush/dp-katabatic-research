/**
 * v4 keeps v3's hard separation between session readiness and katabatic structure, but preserves
 * near-threshold late builders as MARGINAL. The literal v3 policy classified too many rideable
 * mornings NO_GO (45/99 at 05:45), so v3 remains frozen as a documented failed candidate.
 */

import {
  computeFeaturesV3,
  classifyKatabaticStructure,
  MAX_RECENT_AGE_MIN,
  SEVERE_DROP_MPH,
} from './call-rule-v3.mjs';
import { FEATURE_VERSION_V4, RULE_VERSION_V4 } from './versions.mjs';

export const MARGINAL_THRESHOLD_RATIO = 0.85;

export function computeFeaturesV4(points, callTimeTs, opts = {}) {
  const base = computeFeaturesV3(points, callTimeTs, opts);
  if (!base) return null;

  const visible = points.filter((p) => p.ts <= callTimeTs);
  const last30 = visible.filter((p) => p.ts > callTimeTs - 30 * 60);
  const latest = visible[visible.length - 1] ?? null;
  const recentPeak30 = last30.length
    ? Math.max(...last30.map((p) => p.speed))
    : null;

  return {
    ...base,
    recentPeak30,
    dropFromRecentPeak30:
      latest && recentPeak30 !== null ? latest.speed - recentPeak30 : null,
  };
}

function severeCollapse(f) {
  return (
    f.amplitudeTrend === 'FADING' &&
    f.dropFromRecentPeak30 !== null &&
    f.dropFromRecentPeak30 <= -SEVERE_DROP_MPH
  );
}

export function sessionRuleV4(f, { threshold = 15 } = {}) {
  if (!f) {
    return {
      verdict: 'NO_DATA',
      score: null,
      signals: {},
      reasons: ['no readings available at call time'],
    };
  }

  if (
    f.avg30 === null ||
    f.latestAgeMinutes === null ||
    f.latestAgeMinutes > MAX_RECENT_AGE_MIN
  ) {
    return {
      verdict: 'STALE',
      score: null,
      signals: {},
      reasons: ['no usable reading in the last 30 minutes — conditions are unknown'],
    };
  }

  const reasons = [];
  const signals = {
    thresholdReached: f.avg30 >= threshold,
    amplitudeTrend: f.amplitudeTrend,
  };

  const gateBeyondObservedWindow =
    f.minutesUntilGate > 0 &&
    f.minutesPastSunrise !== null &&
    f.minutesPastSunrise + f.minutesUntilGate > 85;
  if (gateBeyondObservedWindow) {
    return {
      verdict: 'NO_GO',
      score: null,
      signals,
      reasons: [
        `gate opens in ${f.minutesUntilGate} min, beyond the measured sunrise hold window`,
      ],
    };
  }

  if (f.avg30 >= threshold) {
    if (severeCollapse(f)) {
      reasons.push(
        `30-minute sustained wind is above ${threshold}, but the latest reading fell ${Math.abs(f.dropFromRecentPeak30).toFixed(1)} mph from the recent peak`
      );
      return { verdict: 'MARGINAL', score: null, signals, reasons };
    }
    reasons.push(
      `30-minute sustained wind is ${f.avg30.toFixed(1)} mph, at or above the ${threshold} mph threshold`
    );
    return { verdict: 'GO', score: null, signals, reasons };
  }

  reasons.push(
    `30-minute sustained wind is ${f.avg30.toFixed(1)} mph, below the ${threshold} mph threshold`
  );

  if (severeCollapse(f)) {
    reasons.push(
      `the latest reading fell ${Math.abs(f.dropFromRecentPeak30).toFixed(1)} mph from the recent 30-minute peak`
    );
    return { verdict: 'NO_GO', score: null, signals, reasons };
  }

  const nearThreshold = f.avg30 >= threshold * MARGINAL_THRESHOLD_RATIO;
  if (f.amplitudeTrend === 'BUILDING' || nearThreshold) {
    reasons.push(
      f.amplitudeTrend === 'BUILDING'
        ? `the latest 15-minute average is building (${f.amplitudeDelta15 >= 0 ? '+' : ''}${f.amplitudeDelta15.toFixed(1)} mph)`
        : `wind is within ${((1 - MARGINAL_THRESHOLD_RATIO) * 100).toFixed(0)}% of the threshold; re-check before leaving`
    );
    return { verdict: 'MARGINAL', score: null, signals, reasons };
  }

  if (f.amplitudeTrend) {
    reasons.push(
      `the latest 15-minute amplitude is ${f.amplitudeTrend.toLowerCase()} (${f.amplitudeDelta15 >= 0 ? '+' : ''}${f.amplitudeDelta15.toFixed(1)} mph)`
    );
  }
  return { verdict: 'NO_GO', score: null, signals, reasons };
}

export function callRuleV4(f, opts = {}) {
  const session = sessionRuleV4(f, opts);
  const structure = classifyKatabaticStructure(f);
  return { ...session, structure };
}

export const FEATURE_VERSION = FEATURE_VERSION_V4;
export const RULE_VERSION = RULE_VERSION_V4;
