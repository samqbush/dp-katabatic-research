import { jest } from '@jest/globals';
import {
  collectHrrrMorning,
  extractHrrrMorningRows,
  fetchHrrrMorning,
  HRRR_CAPTURE_HOURS,
  nightBeforeGenerationMode,
} from '@/scripts/lib/hrrr-forecast.mjs';
import { MIN_NIGHT_BEFORE_FORECAST_HOURS } from '@/scripts/lib/night-before-call.mjs';

const DATE = '2026-08-18';

function response(values) {
  const hours = [5, 6, 7, 8, 9, 10, 11, 12];
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
  it('extracts available fields without inventing missing wind or lid values', () => {
    const rows = extractHrrrMorningRows(response({
      5: { lid: 100, wind: 7 },
      6: { lid: 120, wind: null },
      7: { lid: 140, wind: 9 },
      8: { lid: 160, wind: 10 },
      9: { lid: 180, wind: 11 },
      10: { lid: 200, wind: 12 },
      11: { lid: 220, wind: 13 },
      12: { lid: 240, wind: 14 },
    }).data, DATE);

    expect(rows).toEqual([
      { hr: 5, lid: 100, wind: 7 },
      { hr: 6, lid: 120, wind: null },
      { hr: 7, lid: 140, wind: 9 },
      { hr: 8, lid: 160, wind: 10 },
      { hr: 9, lid: 180, wind: 11 },
      { hr: 10, lid: 200, wind: 12 },
      { hr: 11, lid: 220, wind: 13 },
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

  it('retains available hours when an expanded capture is incomplete', async () => {
    const request = jest.fn().mockResolvedValue(response({
      5: { lid: 100, wind: 7 },
      6: { lid: 120, wind: 8 },
      7: { lid: 140, wind: 9 },
      8: { lid: 160, wind: 10 },
      9: { lid: 180, wind: 11 },
      10: { lid: 200, wind: 12 },
    }));

    const result = await fetchHrrrMorning(DATE, {
      request,
      minimumUsableHours: 7,
      log: jest.fn(),
    });

    expect(result).toMatchObject({ status: 'incomplete', usableHours: 6 });
    expect(result.rows.map((row) => row.hr)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  it('retains partial hours across retries even if the last request fails', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce(response({ 5: { lid: 100, wind: 7 } }))
      .mockRejectedValueOnce(new Error('network unavailable'));
    const result = await fetchHrrrMorning(DATE, {
      request,
      sleep: jest.fn(),
      log: jest.fn(),
      waitForPublication: true,
      maxAttempts: 2,
      minimumUsableHours: 7,
    });

    expect(result).toMatchObject({ status: 'failed', usableHours: 1 });
    expect(result.rows).toEqual([{ hr: 5, lid: 100, wind: 7 }]);
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

  it('combines complementary stored and fetched fields when counting usable hours', async () => {
    const request = jest.fn().mockResolvedValue(response({
      5: { lid: 100, wind: null },
      6: { lid: 120, wind: 8 },
      7: { lid: 140, wind: 9 },
    }));

    const result = await fetchHrrrMorning(DATE, {
      existingRows: [{ hr: 5, lid: null, wind: 6 }],
      request,
    });

    expect(result.status).toBe('ready');
    expect(result.usableHours).toBe(3);
    expect(result.rows[0]).toEqual({ hr: 5, lid: 100, wind: null });
  });
});

describe('forecast provenance', () => {
  it('distinguishes actual pre-midnight issuance from historical single-date backfills', () => {
    const now = new Date('2026-11-14T05:30:00Z');
    expect(nightBeforeGenerationMode('2026-11-14', null, now)).toBe('forward');
    expect(nightBeforeGenerationMode('2026-09-10', null, now)).toBe('retrospective');
    expect(nightBeforeGenerationMode('2026-11-14', 'retrospective', now)).toBe('retrospective');
    expect(() => nightBeforeGenerationMode('2026-09-10', 'forward', now)).toThrow();
    expect(nightBeforeGenerationMode(
      '2026-11-14', null, new Date('2026-11-14T07:00:00Z'),
    )).toBe('retrospective');
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

  it('issues v1 from a partial capture and repairs missing hours without reissuing v1', async () => {
    const stored = new Map();
    const firstRows = HRRR_CAPTURE_HOURS.slice(0, 6).map((hr) => ({ hr, lid: 100, wind: 8 }));
    const prediction = { model_version: 'wind-lid-logistic-v1', call: 'MAYBE' };
    const loadStoredRows = jest.fn(async () => [...stored.values()]);
    const storeRows = jest.fn(async (rows) => rows.forEach((row) => stored.set(row.hr, row)));
    const persistRows = jest.fn().mockResolvedValue(prediction);

    const partial = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(null),
      loadStoredRows,
      storeRows,
      persistRows,
      fetchMorning: jest.fn().mockResolvedValue({ status: 'incomplete', rows: firstRows }),
      minimumUsableHours: 7,
      requiredCaptureHours: HRRR_CAPTURE_HOURS,
    });
    expect(partial).toMatchObject({ status: 'incomplete', prediction });
    expect(stored.size).toBe(6);
    expect(persistRows).toHaveBeenCalledTimes(1);

    const recovered = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(prediction),
      loadStoredRows,
      storeRows,
      persistRows,
      fetchMorning: jest.fn().mockResolvedValue({
        status: 'ready',
        rows: [{ hr: 11, lid: 120, wind: 9 }],
      }),
      minimumUsableHours: 7,
      requiredCaptureHours: HRRR_CAPTURE_HOURS,
    });
    expect(recovered).toMatchObject({ status: 'captured', prediction });
    expect(stored.size).toBe(7);
    expect(persistRows).toHaveBeenCalledTimes(1);
  });

  it('fills one missing stored field before scoring the forecast', async () => {
    const stored = new Map(HRRR_CAPTURE_HOURS.map((hr) => [
      hr, { hr, lid: hr === 5 ? null : 100, wind: 6 },
    ]));
    const result = await collectHrrrMorning({
      date: DATE,
      generationMode: 'forward',
      findIssuedPrediction: jest.fn().mockResolvedValue(null),
      loadStoredRows: async () => [...stored.values()],
      storeRows: async (rows) => rows.forEach((row) => {
        const old = stored.get(row.hr);
        stored.set(row.hr, {
          hr: row.hr,
          lid: old.lid ?? row.lid,
          wind: old.wind ?? row.wind,
        });
      }),
      persistRows: async () => ({ model_version: 'wind-lid-logistic-v1' }),
      fetchMorning: async () => ({
        status: 'ready',
        rows: [{ hr: 5, lid: 120, wind: null }],
      }),
      minimumUsableHours: 7,
      requiredCaptureHours: HRRR_CAPTURE_HOURS,
    });

    expect(result.status).toBe('captured');
    expect(stored.get(5)).toEqual({ hr: 5, lid: 120, wind: 6 });
  });
});
