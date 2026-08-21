/**
 * Regression guard for the live skill's `--since` window resolution.
 *
 * THE BUG (observed 2026-08-21): `--since` always stamped the *current* station day, so a value
 * later than the current clock produced a start after the end — `--since 20:00` run at 05:57
 * asked Ecowitt for 20:00 → 05:57 on the same date. Ecowitt answered `code: 0` with an empty
 * payload, and the script could not tell that apart from a dark meter, so it reported "station is
 * likely offline" and wrote a NO_DATA row into research/prediction-log.csv. The meter was fine and
 * averaging 12.3 mph at the time.
 *
 * That is the failure mode this project treats as unacceptable: absence read as fact rather than
 * as unknown. These tests pin the fix.
 */

import { resolveSince } from '@/.github/skills/dp-katabatic-check/scripts/katabatic-check.mjs';
import { fmtStationDateTime, zonedTime } from '@/scripts/lib/zone.mjs';

describe('resolveSince', () => {
  it('keeps a time earlier than now on the current station day', () => {
    const now = zonedTime(2026, 7, 21, 5, 47, 0); // 2026-08-21 05:47 MDT
    expect(fmtStationDateTime(resolveSince('03:00', now))).toBe('2026-08-21 03:00:00');
  });

  it('reads a time later than now as last night, not as a future window', () => {
    const now = zonedTime(2026, 7, 21, 5, 57, 0);
    // The exact call that produced the false "station offline" report.
    expect(fmtStationDateTime(resolveSince('20:00', now))).toBe('2026-08-20 20:00:00');
  });

  it('never returns a start at or after now', () => {
    const now = zonedTime(2026, 7, 21, 5, 57, 0);
    for (const hhmm of ['00:00', '05:00', '05:57', '12:00', '20:00', '23:59']) {
      expect(resolveSince(hhmm, now).getTime()).toBeLessThan(now.getTime());
    }
  });

  it('rolls back across a month boundary', () => {
    const now = zonedTime(2026, 7, 1, 5, 0, 0); // 2026-08-01 05:00
    expect(fmtStationDateTime(resolveSince('20:00', now))).toBe('2026-07-31 20:00:00');
  });

  it('rolls back across spring-forward without drifting an hour', () => {
    // 2026-03-08 is the US DST changeover. Rolling back lands on an MST evening while `now` is
    // MDT, so a naive minus-24h would report 19:00 or 21:00 rather than 20:00.
    const now = zonedTime(2026, 2, 8, 5, 0, 0);
    expect(fmtStationDateTime(resolveSince('20:00', now))).toBe('2026-03-07 20:00:00');
  });

  it('rejects a malformed --since instead of silently defaulting to midnight', () => {
    const now = zonedTime(2026, 7, 21, 5, 47, 0);
    expect(() => resolveSince('abc', now)).toThrow(/not HH:MM/);
    expect(() => resolveSince('25:00', now)).toThrow(/not a real clock time/);
    expect(() => resolveSince('12:99', now)).toThrow(/not a real clock time/);
  });
});
