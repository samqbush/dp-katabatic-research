/**
 * v5 preserves sub-threshold opportunity unless amplitude evidence is unambiguously poor.
 *
 * V3 and v4 reduced false alarms by suppressing too many later-rideable mornings. V5 therefore
 * emits NO_GO below threshold only when the wind is materially weak, or when it never crossed the
 * requested threshold and is now suffering a severe short-horizon collapse.
 */

import { classifyKatabaticStructure, MAX_RECENT_AGE_MIN, SEVERE_DROP_MPH } from './call-rule-v3.mjs';
import { computeFeaturesV4 } from './call-rule-v4.mjs';
import { FEATURE_VERSION_V5, RULE_VERSION_V5 } from './versions.mjs';

export const MIN_PLAUSIBLE_THRESHOLD_RATIO = 0.6;

export { computeFeaturesV4 as computeFeaturesV5 };

export function classifyKatabaticStructureV5(f) {
  const structure = classifyKatabaticStructure(f);
  if (
    structure.status !== 'UNKNOWN' &&
    f.minutesPastSunrise !== null &&
    f.minutesPastSunrise > 85 &&
    f.inIdealPct !== null &&
    f.inIdealPct < 50
  ) {
    return {
      status: 'ABSENT',
      score: 0,
      reasons: [
        `direction is outside the drainage window ${f.minutesPastSunrise} minutes after sunrise`,
      ],
    };
  }
  return structure;
}

function severeCollapse(f) {
  return (
    f.amplitudeTrend === 'FADING' &&
    f.dropFromRecentPeak30 !== null &&
    f.dropFromRecentPeak30 <= -SEVERE_DROP_MPH
  );
}

export function sessionRuleV5(f, { threshold = 15 } = {}) {
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

  const neverReachedThreshold = f.pctOverThreshold30 === 0;
  if (neverReachedThreshold && severeCollapse(f)) {
    reasons.push(
      `no recent reading reached ${threshold} mph and the latest fell ${Math.abs(f.dropFromRecentPeak30).toFixed(1)} mph from the recent peak`
    );
    return { verdict: 'NO_GO', score: null, signals, reasons };
  }

  if (
    f.avg30 >= threshold * MIN_PLAUSIBLE_THRESHOLD_RATIO ||
    f.amplitudeTrend === 'BUILDING'
  ) {
    reasons.push(
      f.amplitudeTrend === 'BUILDING'
        ? `the latest 15-minute average is building (${f.amplitudeDelta15 >= 0 ? '+' : ''}${f.amplitudeDelta15.toFixed(1)} mph)`
        : 'amplitude remains plausible but has not earned a GO; re-check before leaving'
    );
    return { verdict: 'MARGINAL', score: null, signals, reasons };
  }

  reasons.push(
    `sustained wind is below ${(MIN_PLAUSIBLE_THRESHOLD_RATIO * 100).toFixed(0)}% of the requested threshold`
  );
  return { verdict: 'NO_GO', score: null, signals, reasons };
}

export function callRuleV5(f, opts = {}) {
  const session = sessionRuleV5(f, opts);
  const structure = classifyKatabaticStructureV5(f);
  return { ...session, structure };
}

export const FEATURE_VERSION = FEATURE_VERSION_V5;
export const RULE_VERSION = RULE_VERSION_V5;
