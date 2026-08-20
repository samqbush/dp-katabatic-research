import { summarizeMorningWind } from '@/scripts/lib/label.mjs';

const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);

describe('observed physical-morning wind summary', () => {
  it('includes pre-gate wind and reports max speed, max gust, and longest threshold run', () => {
    const result = summarizeMorningWind({
      date: '2026-03-15',
      status: 'ok',
      cycle_type: '5min',
      points: [
        { ts: ts('2026-03-15T05:00:00-06:00'), speed: 16, gust: 21 },
        { ts: ts('2026-03-15T05:05:00-06:00'), speed: 17, gust: 22 },
        { ts: ts('2026-03-15T05:10:00-06:00'), speed: 18, gust: null },
        { ts: ts('2026-03-15T05:15:00-06:00'), speed: 16, gust: 20 },
        { ts: ts('2026-03-15T05:20:00-06:00'), speed: 15, gust: 19 },
        { ts: ts('2026-03-15T05:25:00-06:00'), speed: 14, gust: 18 },
      ],
    }, { threshold: 15 });

    expect(result.maxSpeedMph).toBe(18);
    expect(result.maxGustMph).toBe(22);
    expect(result.sustainedMinutes).toBe(25);
  });

  it('keeps missing gust and insufficient-resolution observations unknown', () => {
    const missingGust = summarizeMorningWind({
      date: '2026-03-15',
      status: 'ok',
      cycle_type: '5min',
      points: [
        { ts: ts('2026-03-15T05:00:00-06:00'), speed: 12, gust: null },
      ],
    });
    expect(missingGust.maxGustMph).toBeNull();

    const coarse = summarizeMorningWind({
      date: '2026-03-15',
      status: 'ok',
      cycle_type: '240min',
      points: [
        { ts: ts('2026-03-15T04:00:00-06:00'), speed: 20, gust: 25 },
      ],
    });
    expect(coarse).toMatchObject({
      maxSpeedMph: null,
      maxGustMph: null,
      sustainedMinutes: null,
    });

    const noMorningSpeed = summarizeMorningWind({
      date: '2026-03-15',
      status: 'ok',
      cycle_type: '5min',
      points: [
        { ts: ts('2026-03-15T15:00:00-06:00'), speed: 20, gust: 25 },
      ],
    });
    expect(noMorningSpeed).toMatchObject({
      maxSpeedMph: null,
      maxGustMph: null,
      sustainedMinutes: null,
    });
  });
});
