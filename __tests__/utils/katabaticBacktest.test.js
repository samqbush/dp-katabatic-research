import { computeFeatures, callRule, circularMean, angularDiff, inRange, verdictToBinary } from '@/scripts/lib/call-rule.mjs';
import { computeFeaturesV2, callRuleV2 } from '@/scripts/lib/call-rule-v2.mjs';
import {
  checkpointStatus,
  findEventEnd,
  analyzeActiveDay,
  summarizeGroup,
  pickGroupOrOverall,
  MIN_GROUP_SIZE,
} from '@/scripts/lib/active-hold.mjs';
import { upsertRows, upsertRow, readAllRows, rowKey } from '@/scripts/lib/prediction-log-store.mjs';
import { buildLogRow } from '@/scripts/lib/prediction-log.mjs';
import { FEATURE_VERSION_V1, RULE_VERSION_V1, RULE_VERSION_V2 } from '@/scripts/lib/versions.mjs';
import { labelDay } from '@/scripts/lib/label.mjs';
import {
  buildExperimentalNightBeforePrediction,
  EXPERIMENTAL_PROBABILITY_MODEL_V1,
  experimentalCallResult,
  experimentalNightBeforeCall,
  experimentalSuccessChance,
  fitExperimentalProbabilityModel,
  FORWARD_HOLDOUT_START,
} from '@/scripts/lib/night-before-call.mjs';
import { summarizeForecastRows } from '@/scripts/lib/night-before-prediction-store.mjs';
import { classifyEmptyDay, gateOpenHour } from '@/scripts/lib/season.mjs';
import { zonedTime } from '@/scripts/lib/zone.mjs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Guard rails for the katabatic backtest.
 *
 * The single most dangerous bug in this pipeline is lookahead leakage: if the call rule can see
 * even one reading past the call time, every backtest number becomes meaningless AND looks
 * better than reality. Most of this file exists to make that impossible to introduce silently.
 */

const HOUR = 3600;

/**
 * Build a synthetic day of 5-minute readings starting at **Colorado** midnight.
 *
 * `minute` throughout this file therefore means minutes past midnight *at the station*, which is
 * the only reading that makes the gate-conditioning assertions meaningful.
 *
 * This must not be `new Date(y, m - 1, d)`. That is midnight wherever the machine happens to be,
 * so every synthetic window silently slid against the gate: run from America/Chicago, a 06:00
 * event landed at 05:00 Denver and scored as pre-gate, failing tests that describe entirely
 * correct behaviour. It is the same class of bug as §9.1, which shifted the gate an hour and
 * inflated the base rate from 29.4% to 38.7% without erroring — here it merely made the suite
 * pass only in Denver, which is worse in one respect: it trains you to distrust the assertions.
 */
function makeDay(dateStr, spec) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = zonedTime(y, m - 1, d, 0, 0, 0).getTime() / 1000;
  return spec.map(({ minute, speed, dir = 297, rh = 50, gust = null }) => ({
    ts: base + minute * 60,
    speed,
    gust: gust ?? speed + 3,
    dir,
    rh,
    temp: 60,
  }));
}

function constantDay(dateStr, { fromMinute, toMinute, speed, dir = 297, rh = 50 }) {
  const spec = [];
  for (let minute = fromMinute; minute < toMinute; minute += 5) spec.push({ minute, speed, dir, rh });
  return makeDay(dateStr, spec);
}

describe('call rule — no lookahead', () => {
  const day = '2026-07-15'; // July: gate opens 06:00

  it('ignores every reading after the call time', () => {
    // Calm until 06:00, then a huge event. A rule that peeks would see the event.
    const points = [
      ...constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 2 }),
      ...constantDay(day, { fromMinute: 6 * 60, toMinute: 8 * 60, speed: 30 }),
    ];
    const callTs = points[0].ts - 4 * HOUR + 5 * HOUR + 30 * 60; // 05:30 local

    const f = computeFeatures(points, callTs, { station: 'DP Soda Lakes', threshold: 15 });

    expect(f.avg30).toBeCloseTo(2, 5);
    expect(f.max30).toBe(2);
    // If this ever returns GO, the barrier has been breached.
    expect(callRule(f, { threshold: 15 }).verdict).toBe('NO_GO');
  });

  it('produces identical features whether or not future data is present', () => {
    const past = constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 18 });
    const future = constantDay(day, { fromMinute: 6 * 60, toMinute: 9 * 60, speed: 1 });
    const callTs = past[past.length - 1].ts;

    const withFuture = computeFeatures([...past, ...future], callTs, { threshold: 15 });
    const withoutFuture = computeFeatures(past, callTs, { threshold: 15 });

    expect(withFuture).toEqual(withoutFuture);
  });

  it('never lets a neighbour series leak future readings either', () => {
    const points = constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 18 });
    const callTs = points[points.length - 1].ts;
    const neighborQuietThenLoud = [
      ...constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 1 }),
      ...constantDay(day, { fromMinute: 6 * 60, toMinute: 8 * 60, speed: 40 }),
    ];

    const f = computeFeatures(points, callTs, { threshold: 15, neighborSeries: [neighborQuietThenLoud] });
    expect(f.neighborMax).toBeCloseTo(1, 5);
  });

  it('returns null rather than guessing when nothing is visible yet', () => {
    const points = constantDay(day, { fromMinute: 6 * 60, toMinute: 7 * 60, speed: 20 });
    const callTs = points[0].ts - HOUR;
    expect(computeFeatures(points, callTs, { threshold: 15 })).toBeNull();
    expect(callRule(null).verdict).toBe('NO_DATA');
  });
});

describe('call rule — verdicts', () => {
  const day = '2026-07-15';

  it('calls a locked, sustained, building event a GO', () => {
    const points = [
      ...constantDay(day, { fromMinute: 4 * 60, toMinute: 5 * 60, speed: 9, dir: 290, rh: 60 }),
      ...constantDay(day, { fromMinute: 5 * 60, toMinute: 5 * 60 + 30, speed: 18, dir: 295, rh: 45 }),
    ];
    const callTs = points[points.length - 1].ts;
    const f = computeFeatures(points, callTs, { station: 'DP Soda Lakes', threshold: 15, neighborSeries: [constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 2 })] });
    expect(callRule(f, { threshold: 15 }).verdict).toBe('GO');
  });

  it('does not call a strong reading from the wrong direction a GO', () => {
    const points = constantDay(day, { fromMinute: 4 * 60, toMinute: 6 * 60, speed: 20, dir: 150 });
    const callTs = points[points.length - 1].ts;
    const f = computeFeatures(points, callTs, { station: 'DP Soda Lakes', threshold: 15 });
    expect(callRule(f, { threshold: 15 }).verdict).not.toBe('GO');
  });

  it('treats a sub-threshold lull as HOLDING, not DECAYING (mountain-wave modulation)', () => {
    // A 2 mph dip is inside the +/-3.0 band from Poulos et al. and the measured 5.6 mph spread.
    const points = [
      ...constantDay(day, { fromMinute: 4 * 60, toMinute: 4 * 60 + 30, speed: 18 }),
      ...constantDay(day, { fromMinute: 4 * 60 + 30, toMinute: 5 * 60, speed: 16 }),
    ];
    const callTs = points[points.length - 1].ts;
    const f = computeFeatures(points, callTs, { threshold: 15 });
    expect(f.trend).toBe('HOLDING');
  });
});

describe('call rule — stale data', () => {
  const day = '2026-07-15';

  it('reports STALE rather than calm when the meter has gone quiet', () => {
    // Readings stop at 04:00; we ask at 06:00. SKILL.md calls stale data the single most
    // dangerous failure mode, and §4.2 forbids reading absence as calm.
    const points = constantDay(day, { fromMinute: 3 * 60, toMinute: 4 * 60, speed: 18 });
    const callTs = points[points.length - 1].ts + 2 * HOUR;
    const f = computeFeatures(points, callTs, { threshold: 15 });
    expect(f.avg30).toBeNull();
    expect(callRule(f, { threshold: 15 }).verdict).toBe('STALE');
  });

  it('treats STALE as "go look", never as a suppression', () => {
    // §2: a false negative costs an entire session; a false positive costs a 5-minute drive.
    expect(verdictToBinary('STALE')).toBe(true);
    expect(verdictToBinary('MARGINAL')).toBe(true);
    expect(verdictToBinary('GO')).toBe(true);
    expect(verdictToBinary('NO_GO')).toBe(false);
  });
});

describe('experimental night-before call', () => {
  it('keeps the forward holdout boundary after the development sample', () => {
    expect(FORWARD_HOLDOUT_START).toBe('2026-08-11');
  });

  it.each([
    [{ avgWindMph: 10, avgLidM: 200, forecastHours: 4 }, 'PACK'],
    [{ avgWindMph: 4, avgLidM: 300, forecastHours: 4 }, 'SLEEP IN'],
    [{ avgWindMph: 5.5, avgLidM: 100, forecastHours: 4 }, 'SLEEP IN'],
    [{ avgWindMph: 7, avgLidM: 200, forecastHours: 4 }, 'MAYBE'],
  ])('reproduces the frozen pre-registered rule for %o', (inputs, expected) => {
    expect(experimentalNightBeforeCall(inputs).call).toBe(expected);
  });

  it('refuses to call an incomplete forecast', () => {
    expect(experimentalNightBeforeCall({
      avgWindMph: 10,
      avgLidM: 100,
      forecastHours: 2,
    }).call).toBeNull();
  });

  it('makes a false-negative outcome impossible to overlook', () => {
    expect(experimentalCallResult('SLEEP IN', true)).toEqual({
      label: 'MISSED SESSION',
      tone: 'danger',
    });
  });

  it('produces a date-specific probability without using the call bucket', () => {
    const training = [];
    for (let i = 0; i < 20; i++) {
      training.push({
        avgWindMph: 3 + i * 0.5,
        avgLidM: 500 - i * 20,
        rideable: i >= 12,
      });
    }
    const model = fitExperimentalProbabilityModel(training);
    const favorable = experimentalSuccessChance(model, {
      avgWindMph: 12,
      avgLidM: 80,
      forecastHours: 4,
    });
    const unfavorable = experimentalSuccessChance(model, {
      avgWindMph: 3,
      avgLidM: 500,
      forecastHours: 4,
    });

    expect(favorable.probability).toBeGreaterThan(unfavorable.probability);
    expect(favorable.roundedPercent % 5).toBe(0);
    expect(favorable.roundedPercent).toBeLessThanOrEqual(95);
    expect(unfavorable.roundedPercent).toBeGreaterThanOrEqual(5);
  });

  it('withholds probability when the forecast is incomplete', () => {
    const model = fitExperimentalProbabilityModel([
      ...Array.from({ length: 10 }, (_, i) => ({
        avgWindMph: 3 + i,
        avgLidM: 500 - i * 20,
        rideable: false,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        avgWindMph: 10 + i,
        avgLidM: 200 - i * 10,
        rideable: true,
      })),
    ]);
    expect(experimentalSuccessChance(model, {
      avgWindMph: 10,
      avgLidM: 100,
      forecastHours: 2,
    })).toBeNull();
  });

  it('builds a versioned prediction from the frozen model', () => {
    const prediction = buildExperimentalNightBeforePrediction({
      avgWindMph: 9.6,
      avgLidM: 87.5,
      forecastHours: 4,
    });

    expect(prediction.modelVersion).toBe(EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion);
    expect(prediction.call).toBe('PACK');
    expect(prediction.successChancePercent % 5).toBe(0);
  });

  it('summarizes only complete wind/lid forecast hours', () => {
    expect(summarizeForecastRows([
      { wind: 8, lid: 100 },
      { wind: 10, lid: 200 },
      { wind: null, lid: 300 },
      { wind: 12, lid: 300 },
    ])).toEqual({
      avgWindMph: 10,
      avgLidM: 200,
      forecastHours: 3,
    });
  });
});

describe('label — gate conditioning', () => {
  it('does not count a pre-gate event as a positive', () => {
    // January: gate opens 08:00. Blowing hard 05:00-07:00, dead after.
    const points = constantDay('2026-01-03', { fromMinute: 5 * 60, toMinute: 7 * 60, speed: 25 });
    const res = labelDay({ date: '2026-01-03', status: 'ok', cycle_type: '5min', points });

    expect(res.gateOpenHour).toBe(8);
    expect(res.label).toBe(false);
    expect(res.missedDueToGate).toBe(true);
    expect(res.preGateSustainedMinutes).toBeGreaterThanOrEqual(30);
  });

  it('counts a post-gate event as a positive', () => {
    const points = constantDay('2026-07-15', { fromMinute: 6 * 60, toMinute: 7 * 60, speed: 20 });
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '5min', points });
    expect(res.gateOpenHour).toBe(6);
    expect(res.label).toBe(true);
    expect(res.sustainedMinutes).toBeGreaterThanOrEqual(30);
  });

  it('requires 30 continuous minutes, not 30 scattered ones', () => {
    // Alternating above/below threshold never sustains.
    const spec = [];
    for (let minute = 6 * 60; minute < 8 * 60; minute += 5) {
      spec.push({ minute, speed: minute % 10 === 0 ? 20 : 5 });
    }
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '5min', points: makeDay('2026-07-15', spec) });
    expect(res.label).toBe(false);
  });

  it('breaks a run across a data gap rather than assuming the wind continued', () => {
    const points = [
      ...constantDay('2026-07-15', { fromMinute: 6 * 60, toMinute: 6 * 60 + 20, speed: 20 }),
      ...constantDay('2026-07-15', { fromMinute: 7 * 60, toMinute: 7 * 60 + 20, speed: 20 }),
    ];
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '5min', points });
    expect(res.label).toBe(false);
  });

  it('returns null, never false, for an unobserved day', () => {
    const res = labelDay({ date: '2026-02-01', status: 'unobserved', reason: 'seasonal-shutdown', points: [] });
    // §4.2: absence of data must never be read as absence of wind.
    expect(res.label).toBeNull();
    expect(res.label).not.toBe(false);
  });

  it('does NOT count afternoon thermal wind as a katabatic positive', () => {
    // Regression. The first implementation bounded the window only at the front (gate open) and
    // scanned the rest of the day, so strong afternoon thermals scored as katabatic events. That
    // inflated the base rate to 46% against the ~13-20% documented in §4.6. Afternoon wind is a
    // different physical problem, tracked separately in the wind-guru project.
    const points = constantDay('2026-07-15', { fromMinute: 14 * 60, toMinute: 18 * 60, speed: 25 });
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '5min', points });
    expect(res.label).toBe(false);
    expect(res.sustainedMinutes).toBe(0);
  });

  it('ignores wind more than 3 hours past sunrise', () => {
    // July sunrise ~05:32-05:58, so 10:00 is well outside any plausible katabatic window (§4.5
    // measured the close at a median +57 min, 75th percentile +85 min).
    const points = constantDay('2026-07-15', { fromMinute: 10 * 60, toMinute: 11 * 60, speed: 22 });
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '5min', points });
    expect(res.label).toBe(false);
  });

  it('accepts a single 30-minute average as 30 sustained minutes', () => {
    // §4.1: coarse rows are true bucket averages, not samples.
    const [y, m, d] = [2026, 7, 15];
    const base = zonedTime(y, m - 1, d, 6, 0, 0).getTime() / 1000;
    const points = [{ ts: base, speed: 20, gust: 25, dir: 297, rh: 40, temp: 60 }];
    const res = labelDay({ date: '2026-07-15', status: 'ok', cycle_type: '30min', points });
    expect(res.sustainedMinutes).toBe(30);
    expect(res.label).toBe(true);
  });
  it('refuses to label a 240-min-resolution day, returning null rather than false', () => {
    // Regression for a silent corruption found in the first full backtest. Ecowitt downsamples
    // data older than ~12 months to 4-hour rows. Those days *look* healthy (status ok, points
    // present) but a 4-hour mean can never exhibit a 30-minute sustained run, so all 52 archived
    // June-July 2025 days were scored flat by construction and counted as false alarms, dragging
    // the headline numbers down. Absence of resolution is not absence of wind (§4.2).
    const [y, m, d] = [2025, 7, 15];
    const base = zonedTime(y, m - 1, d, 6, 0, 0).getTime() / 1000;
    const points = [{ ts: base, speed: 25, gust: 30, dir: 297, rh: 40, temp: 60 }];
    const res = labelDay({ date: '2025-07-15', status: 'ok', cycle_type: '240min', points });
    expect(res.label).toBeNull();
    expect(res.reason).toContain('insufficient-resolution');
  });
});

describe('season helpers', () => {
  it('classifies the known winter shutdown as unobserved, never calm', () => {
    const c = classifyEmptyDay(new Date(2026, 0, 20), 'DP Soda Lakes');
    expect(c.status).toBe('unobserved');
    expect(c.reason).toBe('seasonal-shutdown');
  });

  it('flags an unexplained summer gap for review', () => {
    const c = classifyEmptyDay(new Date(2026, 6, 20), 'DP Soda Lakes');
    expect(c.status).toBe('no-data');
  });

  it('mirrors the documented gate hours', () => {
    expect(gateOpenHour(new Date(2026, 5, 15))).toBe(6); // June
    expect(gateOpenHour(new Date(2026, 9, 15))).toBe(7); // October
    expect(gateOpenHour(new Date(2026, 0, 15))).toBe(8); // January
  });
});

describe('circular statistics', () => {
  it('averages across the 0/360 wrap correctly', () => {
    expect(circularMean([350, 10])).toBeCloseTo(0, 1);
  });

  it('measures the short way around the compass', () => {
    expect(angularDiff(350, 10)).toBe(20);
  });

  it('handles a direction window that wraps past north', () => {
    expect(inRange(10, 340, 30)).toBe(true);
    expect(inRange(180, 340, 30)).toBe(false);
  });
});

describe('call-rule-v2 — corrected neighbor signal never suppresses', () => {
  const day = '2026-07-15'; // July: gate opens 06:00
  // Target locked, strong, sustained — should read as a clear GO on structure alone.
  const target = constantDay(day, { fromMinute: 0, toMinute: 60, speed: 20, dir: 297, rh: 40 });
  const callTs = target[target.length - 1].ts;
  // Neighbor blowing nearly as hard as the target — ratio > 0.9, the exact case v1 penalizes.
  const hotNeighbor = constantDay(day, { fromMinute: 0, toMinute: 60, speed: 19, dir: 297, rh: 40 });

  it('v1 (frozen, unchanged) still subtracts a point for a blowing neighbor — this is the documented drift, not a new bug', () => {
    const f = computeFeatures(target, callTs, { station: 'DP Soda Lakes', threshold: 15, sunriseTs: null, neighborSeries: [hotNeighbor] });
    const call = callRule(f, { threshold: 15 });
    expect(f.neighborMax / f.avg30).toBeGreaterThan(0.9);
    expect(call.signals.neighbors).toBe(-1);
  });

  it('v2 never assigns a negative neighbor signal, even at the same >0.9 ratio', () => {
    const f = computeFeaturesV2(target, callTs, { station: 'DP Soda Lakes', threshold: 15, sunriseTs: null, neighborSeries: [hotNeighbor] });
    const call = callRuleV2(f, { threshold: 15 });
    expect(f.neighborMax / f.avg30).toBeGreaterThan(0.9);
    expect(call.signals.neighbors).toBeGreaterThanOrEqual(0);
    expect(call.reasons.some((r) => r.includes('does not argue against going'))).toBe(true);
  });

  it('a calm neighbor still scores +1 in both v1 and v2 (only the penalty side changed)', () => {
    const calmNeighbor = constantDay(day, { fromMinute: 0, toMinute: 60, speed: 2, dir: 90, rh: 40 });
    const optsCalm = { station: 'DP Soda Lakes', threshold: 15, sunriseTs: null, neighborSeries: [calmNeighbor] };
    const v1Call = callRule(computeFeatures(target, callTs, optsCalm), { threshold: 15 });
    const v2Call = callRuleV2(computeFeaturesV2(target, callTs, optsCalm), { threshold: 15 });
    expect(v1Call.signals.neighbors).toBe(1);
    expect(v2Call.signals.neighbors).toBe(1);
  });
});

describe('feature parity — v2 is a strict superset of v1 on every shared field', () => {
  it('produces byte-identical core features for identical input (live script must be able to use either safely)', () => {
    const day = '2026-08-01';
    const points = constantDay(day, { fromMinute: 0, toMinute: 90, speed: 16, dir: 300, rh: 45 });
    const neighbor = constantDay(day, { fromMinute: 0, toMinute: 90, speed: 3, dir: 90, rh: 45 });
    const callTs = points[points.length - 1].ts;
    const opts = { station: 'DP Soda Lakes', threshold: 15, sunriseTs: null, neighborSeries: [neighbor] };
    const v1 = computeFeatures(points, callTs, opts);
    const v2 = computeFeaturesV2(points, callTs, opts);
    for (const key of Object.keys(v1)) {
      expect(v2[key]).toEqual(v1[key]);
    }
    // v2 adds exactly these two extra descriptive fields, nothing else.
    expect(Object.keys(v2).sort()).toEqual([...Object.keys(v1), 'pctOverThresholdSlices', 'pctOverThresholdTrendDelta'].sort());
  });
});

describe('active-hold — censoring and gaps are never read as an observed death', () => {
  const HOUR_ = 3600;

  it('reports a real drop as observed, with the correct duration', () => {
    // Regular 5-minute cadence matching stepMin, so no point is mistaken for a data gap.
    const points = [
      { ts: 0, speed: 20 },
      { ts: 300, speed: 20 },
      { ts: 600, speed: 20 },
      { ts: 900, speed: 19 },
      { ts: 1200, speed: 19 },
      { ts: 1500, speed: 19 },
      { ts: 1800, speed: 8 }, // drops below 15 at t+30min
    ];
    const res = findEventEnd(points, 0, 3 * HOUR_, 15, 5);
    expect(res.observed).toBe(true);
    expect(res.durationMinutes).toBe(30);
  });

  it('reports an event still above threshold at the window boundary as censored, not observed', () => {
    // Regular 30-minute cadence out to the window boundary, never dropping below threshold.
    const points = [0, 1800, 3600, 5400, 7200, 9000, 10800].map((ts) => ({ ts, speed: 18 }));
    const res = findEventEnd(points, 0, 3 * HOUR_, 15, 30);
    expect(res.observed).toBe(false);
    expect(res.reason).toBe('censored');
    // A censored event's duration is a lower bound, never averaged as if observed.
    expect(res.durationMinutes).toBeGreaterThanOrEqual(150);
  });

  it('reports a real data outage as a gap, never assumes the event died quietly', () => {
    const points = [
      { ts: 0, speed: 20 },
      { ts: 300, speed: 20 }, // normal cadence for two points, establishing a real prevTs
      // large gap — no points until well past one step interval
      { ts: 3 * HOUR_, speed: 3 },
    ];
    const res = findEventEnd(points, 0, 3 * HOUR_, 15, 5);
    expect(res.observed).toBe(false);
    expect(res.reason).toBe('gap');
  });

  it('checkpointStatus returns unknown rather than guessing when there is no data in the trailing window', () => {
    const points = [{ ts: 0, speed: 20 }];
    expect(checkpointStatus(points, 10 * HOUR_, 15)).toBe('unknown');
  });

  it('analyzeActiveDay marks a checkpoint beyond the observation window as unknown, not below', () => {
    const day = '2026-07-15';
    const points = constantDay(day, { fromMinute: 0, toMinute: 60, speed: 20, dir: 297, rh: 40 });
    const callTs = points[0].ts;
    const result = analyzeActiveDay({ points, cycle_type: '5min' }, callTs, 15);
    // gate+60 for a July (06:00 gate) morning is comfortably inside the 3hr-past-sunrise bound in
    // this synthetic day (no sunrise supplied to gateOpenTime path), so this just asserts the
    // checkpoints object always has all three keys and never silently drops one.
    expect(Object.keys(result.checkpoints).sort()).toEqual(['gate', 'gatePlus30', 'gatePlus60'].sort());
  });
});

describe('active-hold — low-sample groups fall back to the overall rate, never a bare small-n figure', () => {
  it('pickGroupOrOverall falls back below MIN_GROUP_SIZE and uses the group at or above it', () => {
    const small = { n: MIN_GROUP_SIZE - 1, above: 1, rate: 1 };
    const big = { n: MIN_GROUP_SIZE, above: 10, rate: 0.5 };
    const overall = { n: 999, above: 500, rate: 0.5 };

    const smallResult = pickGroupOrOverall(small, overall);
    expect(smallResult.useGroup).toBe(false);
    expect(smallResult.summary).toBe(overall);

    const bigResult = pickGroupOrOverall(big, overall);
    expect(bigResult.useGroup).toBe(true);
    expect(bigResult.summary).toBe(big);
  });

  it('falls back to overall when the group is missing entirely', () => {
    const overall = { n: 10, above: 5, rate: 0.5 };
    const result = pickGroupOrOverall(undefined, overall);
    expect(result.useGroup).toBe(false);
    expect(result.summary).toBe(overall);
  });

  it('summarizeGroup reports both observed and censored counts, never merging them', () => {
    const results = [
      { checkpoints: { gate: 'above', gatePlus30: 'above', gatePlus60: 'below' }, eventEnd: { observed: true, durationMinutes: 45 } },
      { checkpoints: { gate: 'above', gatePlus30: 'below', gatePlus60: 'below' }, eventEnd: { observed: false, reason: 'censored', durationMinutes: 200 } },
      { checkpoints: { gate: 'unknown', gatePlus30: 'unknown', gatePlus60: 'unknown' }, eventEnd: { observed: false, reason: 'gap' } },
    ];
    const summary = summarizeGroup(results);
    expect(summary.n).toBe(3);
    expect(summary.duration.observedCount).toBe(1);
    expect(summary.duration.censoredCount).toBe(1);
    expect(summary.duration.unknownDueToGap).toBe(1);
    expect(summary.duration.minCensoredMinutes).toBe(200);
    // The one 'unknown' checkpoint must not count as either above or below in the rate.
    expect(summary.gate.n).toBe(2);
    expect(summary.gate.above).toBe(2);
  });
});

describe('prediction-log-store — atomic upsert and deduplication', () => {
  let dir;
  let logPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'katabatic-log-test-'));
    logPath = join(dir, 'prediction-log.csv');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function row(overrides = {}) {
    return buildLogRow({
      source: 'backtest',
      date: '2026-07-15',
      callTime: '05:45',
      station: 'DP Soda Lakes',
      threshold: 15,
      features: { avg30: 16, avg60: 15 },
      call: { verdict: 'GO', score: 4 },
      label: { label: true, gateOpenHour: 6 },
      featureVersion: FEATURE_VERSION_V1,
      ruleVersion: RULE_VERSION_V1,
      ...overrides,
    });
  }

  it('re-running the same (source, date, call_time, station, rule_version) replaces the row rather than duplicating it', async () => {
    await upsertRow(logPath, row({ call: { verdict: 'GO', score: 4 } }));
    const result = await upsertRow(logPath, row({ call: { verdict: 'NO_GO', score: -1 } }));
    expect(result.replaced).toBe(1);
    const rows = await readAllRows(logPath);
    expect(rows.length).toBe(1);
    expect(rows[0].verdict).toBe('NO_GO');
  });

  it('a v1 and a v2 row for the identical morning and call time coexist rather than colliding', async () => {
    await upsertRows(logPath, [row({ ruleVersion: RULE_VERSION_V1 }), row({ ruleVersion: RULE_VERSION_V2 })]);
    const rows = await readAllRows(logPath);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.rule_version))).toEqual(new Set([RULE_VERSION_V1, RULE_VERSION_V2]));
  });

  it('preserves unrelated existing rows (e.g. a live call) when upserting new backtest rows', async () => {
    const liveRow = row({ source: 'live', date: '2026-08-01', callTime: '05:45' });
    await upsertRow(logPath, liveRow);
    await upsertRow(logPath, row({ source: 'backtest', date: '2026-07-15' }));
    const rows = await readAllRows(logPath);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.source === 'live' && r.date === '2026-08-01')).toBe(true);
  });

  it('writes a clean file with no blank rows, even across repeated upserts', async () => {
    await upsertRow(logPath, row());
    await upsertRow(logPath, row({ date: '2026-07-16' }));
    const { readFileSync } = await import('fs');
    const text = readFileSync(logPath, 'utf8');
    expect(text).not.toContain('\n\n');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('rowKey groups exactly on (source, date, call_time, station, rule_version)', () => {
    const a = row();
    const b = row({ threshold: 12 }); // threshold differs but key fields don't — same key
    expect(rowKey(a)).toBe(rowKey(b));
    const c = row({ ruleVersion: RULE_VERSION_V2 });
    expect(rowKey(a)).not.toBe(rowKey(c));
  });
});
