import { computeFeatures, callRule, circularMean, angularDiff, inRange, verdictToBinary } from '@/scripts/lib/call-rule.mjs';
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
