import { parseHistoryData } from '@/scripts/lib/ecowitt.mjs';

describe('Ecowitt history pressure parsing', () => {
  it('aligns absolute and relative pressure to canonical wind timestamps', () => {
    const parsed = parseHistoryData({
      wind: {
        wind_speed: { list: { 1000: '10.1', 1300: '11.2' } },
        wind_gust: { list: { 1000: '15.3', 1300: '16.4' } },
        wind_direction: { list: { 1000: '270', 1300: '280' } },
      },
      outdoor: {
        temperature: { list: { 1000: '45.1', 1300: '44.8' } },
        humidity: { list: { 1000: '50', 1300: '52' } },
      },
      pressure: {
        absolute: { list: { 1000: '826.1', 1600: '825.8' } },
        relative: { list: { 1000: '1012.4', 1300: '1012.2' } },
      },
    });

    expect(parsed.points).toEqual([
      {
        ts: 1000,
        speed: 10.1,
        gust: 15.3,
        dir: 270,
        temp: 45.1,
        rh: 50,
        absolute_pressure_hpa: 826.1,
        relative_pressure_hpa: 1012.4,
      },
      {
        ts: 1300,
        speed: 11.2,
        gust: 16.4,
        dir: 280,
        temp: 44.8,
        rh: 52,
        absolute_pressure_hpa: null,
        relative_pressure_hpa: 1012.2,
      },
    ]);
    expect(parsed.pressure).toMatchObject({
      absoluteCount: 2,
      relativeCount: 2,
      matchedCount: 2,
      unmatchedCount: 1,
      cycleType: '5min',
    });
  });

  it('preserves missing pressure as unknown rather than zero', () => {
    const parsed = parseHistoryData({
      wind: {
        wind_speed: { list: { 1000: '0' } },
        wind_gust: { list: { 1000: '0' } },
        wind_direction: { list: { 1000: '0' } },
      },
    });

    expect(parsed.points[0]).toMatchObject({
      speed: 0,
      absolute_pressure_hpa: null,
      relative_pressure_hpa: null,
    });
    expect(parsed.pressure).toEqual({
      absoluteCount: 0,
      relativeCount: 0,
      matchedCount: 0,
      unmatchedCount: 0,
      cycleType: null,
    });
  });
});

