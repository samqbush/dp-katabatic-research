/**
 * v3 separates two questions that v1/v2 incorrectly combined:
 *
 * 1. Is a katabatic drainage structure present?
 * 2. Is there a rideable session at the requested threshold?
 *
 * Structural evidence is deliberately excluded from `sessionRuleV3`. It can describe a real weak
 * drainage pulse, but it cannot promote a below-threshold session to GO.
 */

import { computeFeaturesV2 } from './call-rule-v2.mjs';
import { FEATURE_VERSION_V3, RULE_VERSION_V3 } from './versions.mjs';

export const SHORT_TREND_BAND_MPH = 1.5;
export const SEVERE_DROP_MPH = 3;
export const MAX_RECENT_AGE_MIN = 30;

const mean = (nums) => (nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null);

function pointsBetween(points, startExclusive, endInclusive) {
  return points.filter((p) => p.ts > startExclusive && p.ts <= endInclusive);
}

export function computeFeaturesV3(points, callTimeTs, opts = {}) {
  const base = computeFeaturesV2(points, callTimeTs, opts);
  if (!base) return null;

  const visible = points.filter((p) => p.ts <= callTimeTs);
  const last15 = pointsBetween(visible, callTimeTs - 15 * 60, callTimeTs);
  const prev15 = pointsBetween(visible, callTimeTs - 30 * 60, callTimeTs - 15 * 60);
  const avg15 = mean(last15.map((p) => p.speed));
  const avgPrev15 = mean(prev15.map((p) => p.speed));
  const amplitudeDelta15 = avg15 !== null && avgPrev15 !== null ? avg15 - avgPrev15 : null;
  const latest = visible[visible.length - 1] ?? null;
  const recentPeak15 = last15.length ? Math.max(...last15.map((p) => p.speed)) : null;
  const dropFromRecentPeak15 =
    latest && recentPeak15 !== null ? latest.speed - recentPeak15 : null;

  const amplitudeTrend =
    amplitudeDelta15 === null
      ? null
      : amplitudeDelta15 >= SHORT_TREND_BAND_MPH
        ? 'BUILDING'
        : amplitudeDelta15 <= -SHORT_TREND_BAND_MPH
          ? 'FADING'
          : 'FLAT';

  return {
    ...base,
    avg15,
    avgPrev15,
    amplitudeDelta15,
    amplitudeTrend,
    latestSpeed: latest?.speed ?? null,
    latestAgeMinutes: latest ? (callTimeTs - latest.ts) / 60 : null,
    recentPeak15,
    dropFromRecentPeak15,
  };
}

export function classifyKatabaticStructure(f) {
  if (!f) {
    return { status: 'UNKNOWN', score: null, reasons: ['no readings available'] };
  }
  if (
    f.avg30 === null ||
    f.latestAgeMinutes === null ||
    f.latestAgeMinutes > MAX_RECENT_AGE_MIN
  ) {
    return { status: 'UNKNOWN', score: null, reasons: ['recent meter data is stale'] };
  }

  let score = 0;
  const reasons = [];

  if (f.inIdealPct !== null) {
    if (f.inIdealPct >= 80) {
      score += 2;
      reasons.push(`direction locked in the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    } else if (f.inIdealPct >= 50) {
      score += 1;
      reasons.push(`direction partly in the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    } else {
      reasons.push(`direction mostly outside the ideal window (${f.inIdealPct.toFixed(0)}%)`);
    }
  }

  if (f.rhDelta !== null && f.rhDelta <= -5) {
    score += 1;
    reasons.push(`overnight humidity fell ${Math.abs(f.rhDelta).toFixed(0)} points`);
  }

  if (f.neighborMax !== null && f.avg30 > 0 && f.neighborMax / f.avg30 < 0.5) {
    score += 1;
    reasons.push('neighbor stations are comparatively calm');
  }

  if (f.trend === 'BUILDING') {
    score += 1;
    reasons.push('the broader overnight wind profile is building');
  }

  const status = score >= 3 ? 'PRESENT' : score >= 1 ? 'POSSIBLE' : 'ABSENT';
  return { status, score, reasons };
}

export function sessionRuleV3(f, { threshold = 15 } = {}) {
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

  const sunriseToGateMinutes =
    f.minutesPastSunrise === null
      ? null
      : f.minutesPastSunrise + f.minutesUntilGate;
  const sunriseNearGate =
    sunriseToGateMinutes !== null && Math.abs(sunriseToGateMinutes) <= 30;

  if (f.avg30 < threshold) {
    reasons.push(
      `30-minute sustained wind is ${f.avg30.toFixed(1)} mph, below the ${threshold} mph threshold`
    );

    if (f.amplitudeTrend === 'BUILDING' && !sunriseNearGate) {
      reasons.push(
        `the latest 15-minute average is building (${f.amplitudeDelta15 >= 0 ? '+' : ''}${f.amplitudeDelta15.toFixed(1)} mph)`
      );
      return { verdict: 'MARGINAL', score: null, signals, reasons };
    }

    if (f.amplitudeTrend) {
      reasons.push(
        `the latest 15-minute amplitude is ${f.amplitudeTrend.toLowerCase()} (${f.amplitudeDelta15 >= 0 ? '+' : ''}${f.amplitudeDelta15.toFixed(1)} mph)`
      );
    }
    if (sunriseNearGate) {
      reasons.push('sunrise is within 30 minutes of gate-open, shortening a marginal build');
    }
    return { verdict: 'NO_GO', score: null, signals, reasons };
  }

  const severeCollapse =
    f.amplitudeTrend === 'FADING' &&
    f.dropFromRecentPeak15 !== null &&
    f.dropFromRecentPeak15 <= -SEVERE_DROP_MPH;

  if (severeCollapse) {
    reasons.push(
      `30-minute sustained wind is above ${threshold}, but the latest reading fell ${Math.abs(f.dropFromRecentPeak15).toFixed(1)} mph from the recent peak`
    );
    return { verdict: 'MARGINAL', score: null, signals, reasons };
  }

  reasons.push(
    `30-minute sustained wind is ${f.avg30.toFixed(1)} mph, at or above the ${threshold} mph threshold`
  );
  return { verdict: 'GO', score: null, signals, reasons };
}

export function callRuleV3(f, opts = {}) {
  const session = sessionRuleV3(f, opts);
  const structure = classifyKatabaticStructure(f);
  return { ...session, structure };
}

export const FEATURE_VERSION = FEATURE_VERSION_V3;
export const RULE_VERSION = RULE_VERSION_V3;
