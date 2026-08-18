import { jest } from '@jest/globals';
import {
  collectHrrrMorning,
  extractHrrrMorningRows,
  fetchHrrrMorning,
} from '@/scripts/lib/hrrr-forecast.mjs';
import { MIN_NIGHT_BEFORE_FORECAST_HOURS } from '@/scripts/lib/night-before-call.mjs';

const DATE = '2026-08-18';

function response(values) {
  const hours = [5, 6, 7, 8];
  return {
    data: {
      hourly: {
        time: hours.map((hour) => `${DATE}T${String(hour).padStart(2, '0')}:00`),
        boundary_layer_height: hours.map((hour) => values[hour]?.lid ?? null),
        wind_speed_10m: hours.map((hour) => values[hour]?.wind ?? null),
      },
    },
  };
}

function unavailable() {
  const error = new Error('request failed');
  error.response = { data: { reason: 'The requested model run is not available' } };
  return error;
}

describe('HRRR forecast publication handling', () => {
  it('extracts only complete wind/lid pairs from the requested morning', () => {
    const rows = extractHrrrMorningRows(response({
      5: { lid: 100, wind: 7 },
      6: { lid: 120, wind: null },
      7: { lid: 140, wind: 9 },
      8: { lid: 160, wind: 10 },
    }).data, DATE);

    expect(rows).toEqual([
      { hr: 5, lid: 100, wind: 7 },
      { hr: 7, lid: 140, wind: 9 },
      { hr: 8, lid: 160, wind: 10 },
    ]);
  });

  it('shares the three-hour usability threshold with prediction generation', async () => {
    const request = jest.fn().mockResolvedValue(response({
      5: { lid: 100, wind: 7 },
      6: { lid: 120, wind: 8 },
      7: { lid: 140, wind: 9 },
    }));

    const result = await fetchHrrrMorning(DATE, { request });

    expect(MIN_NIGHT_BEFORE_FORECAST_HOURS).toBe(3);
    expect(result.status).toBe('ready');
    expect(result.rows).toHaveLength(3);
  });

  it('retries all-null forward responses before failing without rows', async () => {
    const request = jest.fn().mockResolvedValue(response({}));
    const sleep = jest.fn().mockResolvedValue();
    const log = jest.fn();

    const result = await fetchHrrrMorning(DATE, {
      request,
      sleep,
      log,
      waitForPublication: true,
      retryBaseMs: 10,
    });

    expect(result).toMatchObject({ status: 'incomplete', rows: null, attempts: 4 });
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 30]);
  });

  it('retries a forward unavailable run and captures it when publication completes', async () => {
    const request = jest.fn()
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(response({
        5: { lid: 100, wind: 7 },
        6: { lid: 120, wind: 8 },
        7: { lid: 140, wind: 9 },
      }));
    const sleep = jest.fn().mockResolvedValue();

    const result = await fetchHrrrMorning(DATE, {
      request,
      sleep,
      log: jest.fn(),
      waitForPublication: true,
      retryBaseMs: 10,
    });

    expect(result.status).toBe('ready');
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('fast-skips incomplete retrospective responses', async () => {
    const request = jest.fn().mockResolvedValue(response({}));
    const sleep = jest.fn().mockResolvedValue();

    const result = await fetchHrrrMorning(DATE, {
      request,
      sleep,
      log: jest.fn(),
      waitForPublication: false,
    });

    expect(result).toMatchObject({ status: 'incomplete', rows: null, attempts: 1 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('counts stored and newly available distinct hours together', async () => {
    const request = jest.fn().mockResolvedValue(response({
      6: { lid: 120, wind: 8 },
      7: { lid: 140, wind: 9 },
    }));

    const result = await fetchHrrrMorning(DATE, {
      existingRows: [{ hr: 5, lid: 90, wind: 6 }],
      request,
    });

    expect(result.status).toBe('ready');
    expect(result.usableHours).toBe(3);
  });
});

describe('HRRR forecast recovery immutability', () => {
  it('is a green no-op when the prediction was already issued', async () => {
    const prediction = { model_version: 'wind-lid-logistic-v1', call: 'PACK' };
    const loadStoredRows = jest.fn();
    const storeRows = jest.fn();
    const persistRows = jest.fn();
    const fetchMorning = jest.fn();

    const result = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(prediction),
      loadStoredRows,
      storeRows,
      persistRows,
      fetchMorning,
    });

    expect(result).toEqual({ status: 'already-issued', prediction, rows: null });
    expect(loadStoredRows).not.toHaveBeenCalled();
    expect(fetchMorning).not.toHaveBeenCalled();
    expect(storeRows).not.toHaveBeenCalled();
    expect(persistRows).not.toHaveBeenCalled();
  });

  it('issues from already-stored usable rows without refetching', async () => {
    const rows = [
      { hr: 5, lid: 90, wind: 6 },
      { hr: 6, lid: 120, wind: 8 },
      { hr: 7, lid: 140, wind: 9 },
    ];
    const fetchMorning = jest.fn();
    const persistRows = jest.fn().mockResolvedValue({
      model_version: 'wind-lid-logistic-v1',
      call: 'MAYBE',
    });

    const result = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(null),
      loadStoredRows: jest.fn().mockResolvedValue(rows),
      storeRows: jest.fn(),
      persistRows,
      fetchMorning,
    });

    expect(result).toMatchObject({ status: 'captured', source: 'stored', rows });
    expect(fetchMorning).not.toHaveBeenCalled();
    expect(persistRows).toHaveBeenCalledWith(rows);
  });

  it('preserves early raw rows while filling enough missing hours for recovery', async () => {
    const stored = new Map([[5, { hr: 5, lid: 90, wind: 6 }]]);
    const loadStoredRows = jest.fn(async () => [...stored.values()].sort((a, b) => a.hr - b.hr));
    const storeRows = jest.fn(async (rows) => {
      for (const row of rows) {
        if (!stored.has(row.hr)) stored.set(row.hr, row);
      }
    });
    const persistRows = jest.fn(async (rows) => ({
      model_version: 'wind-lid-logistic-v1',
      call: 'MAYBE',
      rows,
    }));
    const fetchMorning = jest.fn().mockResolvedValue({
      status: 'ready',
      rows: [
        { hr: 5, lid: 999, wind: 30 },
        { hr: 6, lid: 120, wind: 8 },
        { hr: 7, lid: 140, wind: 9 },
      ],
    });

    const result = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(null),
      loadStoredRows,
      storeRows,
      persistRows,
      fetchMorning,
    });

    expect(result.status).toBe('captured');
    expect(result.rows).toEqual([
      { hr: 5, lid: 90, wind: 6 },
      { hr: 6, lid: 120, wind: 8 },
      { hr: 7, lid: 140, wind: 9 },
    ]);
    expect(persistRows).toHaveBeenCalledWith(result.rows);
  });
});
