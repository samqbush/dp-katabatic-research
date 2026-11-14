import { jest } from '@jest/globals';
import * as actualHrrr from '@/scripts/lib/hrrr-forecast.mjs';
import * as actualLabel from '@/scripts/lib/label.mjs';
import { summarizeForecastRows } from '@/scripts/lib/night-before-prediction-store.mjs';
import {
  EXPERIMENTAL_PROBABILITY_MODEL_V1,
  EXPERIMENTAL_PROBABILITY_MODEL_V2,
  experimentalSuccessChance,
  summarizeGateAlignedForecastRows,
} from '@/scripts/lib/night-before-call.mjs';

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.resetModules();
});

it('preserves an issued v1 and marks a newly materialized historical v2 retrospective', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-14T05:30:00Z'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = ['node', 'archive-hrrr-forecast.mjs', '--date', '2026-10-15'];

  const legacy = {
    model_version: EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion,
    generation_mode: 'forward',
    forecast_hours: 3,
    call: 'MAYBE',
    success_chance_percent: 20,
  };
  const forecasts = Array.from({ length: 7 }, (_, index) => ({
    hr: index + 5, wind: 8, lid: 200,
  }));
  const query = jest.fn(async (sql) => {
    if (sql.includes('SELECT valid_hour_local AS hr')) return { rows: forecasts };
    if (sql.includes('SELECT count(*)::int')) return { rows: [{ n: 7, days: 1 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const findNightBeforePrediction = jest.fn(async ({ modelVersion }) => (
    modelVersion === EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion ? legacy : null
  ));
  const persistNightBeforePrediction = jest.fn(async ({ model, generationMode }) => ({
    model_version: model.modelVersion,
    generation_mode: generationMode,
    call: 'MAYBE',
    success_chance_percent: 20,
  }));
  jest.unstable_mockModule('../../scripts/lib/db.mjs', () => ({
    query, closePool: jest.fn(),
  }));
  jest.unstable_mockModule('../../scripts/lib/night-before-prediction-store.mjs', () => ({
    findNightBeforePrediction,
    persistNightBeforePrediction,
    summarizeForecastRows: jest.fn(),
  }));

  await import('../../scripts/archive-hrrr-forecast.mjs');

  expect(persistNightBeforePrediction).toHaveBeenCalledTimes(1);
  expect(persistNightBeforePrediction).toHaveBeenCalledWith(expect.objectContaining({
    model: EXPERIMENTAL_PROBABILITY_MODEL_V2,
    generationMode: 'retrospective',
    forecast: expect.objectContaining({ forecastHours: 4 }),
  }));
});

it('backfills an available hour even when the other added hours were already stored', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = ['node', 'backfill-hrrr-forecast-hours.mjs'];
  const query = jest.fn(async (sql) => {
    if (sql.includes('HAVING count')) {
      return { rows: [{ date: '2026-10-15', complete_hours: [9, 10] }] };
    }
    if (sql.includes('INSERT INTO hrrr_forecasts')) {
      return { rows: [{ valid_hour_local: 11, lid_m: 200, wind_mph: 8 }] };
    }
    if (sql.includes('complete_added_hours')) {
      return { rows: [{ days: 1, complete_added_hours: 3 }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const fetchHrrrMorning = jest.fn().mockResolvedValue({
    status: 'ready',
    rows: [{ hr: 11, wind: null, lid: 200 }],
  });
  jest.unstable_mockModule('../../scripts/lib/db.mjs', () => ({
    query, closePool: jest.fn(),
  }));
  jest.unstable_mockModule('../../scripts/lib/hrrr-forecast.mjs', () => ({
    ...actualHrrr, fetchHrrrMorning,
  }));

  await import('../../scripts/backfill-hrrr-forecast-hours.mjs');

  const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO hrrr_forecasts'));
  expect(insert[1]).toEqual(expect.arrayContaining([11, null, 200]));
  expect(process.exitCode).toBe(originalExitCode);
});

it('evaluates the issued v1 probabilities and frozen v2 rather than a new fit', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const dates = Array.from({ length: 10 }, (_, index) => (
    `2026-04-${String(index + 2).padStart(2, '0')}`
  )).concat('2026-08-15');
  const days = dates.map((date, index) => ({ date, label: index % 2 === 0 }));
  const rows = dates.flatMap((date, index) => (
    Array.from({ length: 7 }, (_, hour) => ({
      date, hr: hour + 5, wind: 4 + index, lid: 100 + index * 10,
      v1_probability: index === 10 ? 0.8 : null,
    }))
  ));
  jest.unstable_mockModule('../../scripts/lib/db.mjs', () => ({
    query: jest.fn().mockResolvedValue({ rows }),
    closePool: jest.fn(),
  }));
  jest.unstable_mockModule('../../scripts/lib/archive-store.mjs', () => ({
    readDays: jest.fn().mockResolvedValue(days),
  }));
  jest.unstable_mockModule('../../scripts/lib/label.mjs', () => ({
    ...actualLabel,
    labelDay: (day) => ({ label: day.label }),
  }));
  jest.unstable_mockModule('../../scripts/lib/night-before-prediction-store.mjs', () => ({
    summarizeForecastRows,
  }));

  await import('../../scripts/DEBUG-gate-aligned-night-before.mjs');

  const report = JSON.parse(log.mock.calls[0][0]);
  const heldoutRows = rows.filter((row) => row.date === '2026-08-15');
  const expectedV2 = experimentalSuccessChance(
    EXPERIMENTAL_PROBABILITY_MODEL_V2,
    summarizeGateAlignedForecastRows(heldoutRows, '2026-08-15'),
  ).probability;
  expect(report.training.refitMatchesFrozenV2).toBe(false);
  expect(report.holdout.v1.brier).toBeCloseTo((1 - 0.8) ** 2);
  expect(report.holdout.v2.brier).toBeCloseTo((1 - expectedV2) ** 2);
});
