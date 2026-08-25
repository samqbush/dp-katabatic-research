/**
 * Guard rails for the canoe tier (`session-class-v1`).
 *
 * Two things are being protected here:
 *
 *   1. That the canoe class is genuinely ADDITIVE — `labelDay` must keep answering exactly what
 *      it answered before, because 99 archived `label-v1` positives and five frozen rule versions
 *      depend on it (§7 rule 1).
 *   2. That the canoe class inherits the two properties the primary label fought hardest for:
 *      gate-conditioning (a pre-gate-only event is unreachable, not a session) and §4.2
 *      null-safety (an unobserved morning is unknown, never `flat`).
 */

import { labelDay, classifySession, CANOE_THRESHOLD_MPH } from '@/scripts/lib/label.mjs';
import { zonedTimeFrom } from '@/scripts/lib/zone.mjs';

/** Build 5-min points for a July morning, speed given per (hour, minute) slot. */
function makeMorning(date, spans) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const points = [];
  for (const { fromMin, toMin, speed } of spans) {
    for (let t = fromMin; t < toMin; t += 5) {
      const at = zonedTimeFrom(day, Math.floor(t / 60), t % 60, 0);
      points.push({ ts: Math.floor(at.getTime() / 1000), speed, gust: speed * 1.5, dir: 285, rh: 45 });
    }
  }
  return { date, station: 'DP Soda Lakes', status: 'ok', cycle_type: '5min', points };
}

// July → 6:00 gate. 06:30–07:30 is comfortably post-gate and pre-sunrise+3h.
const POST_GATE = { fromMin: 6 * 60 + 30, toMin: 7 * 60 + 30 };

describe('classifySession — canoe tier', () => {
  it('classifies a solid 15+ morning as rideable, not canoe', () => {
    const res = classifySession(makeMorning('2026-07-15', [{ ...POST_GATE, speed: 18 }]));
    expect(res.sessionClass).toBe('rideable');
    expect(res.label).toBe(true);
  });

  it('classifies a 12-15 morning as canoe', () => {
    const res = classifySession(makeMorning('2026-07-15', [{ ...POST_GATE, speed: 13 }]));
    expect(res.sessionClass).toBe('canoe');
    expect(res.label).toBe(false);
    expect(res.canoeSustainedMinutes).toBeGreaterThanOrEqual(30);
  });

  it('classifies a sub-12 morning as flat', () => {
    const res = classifySession(makeMorning('2026-07-15', [{ ...POST_GATE, speed: 9 }]));
    expect(res.sessionClass).toBe('flat');
    expect(res.canoeSustainedMinutes).toBe(0);
  });

  it('treats the canoe threshold as inclusive at exactly 12 mph', () => {
    const res = classifySession(makeMorning('2026-07-15', [{ ...POST_GATE, speed: CANOE_THRESHOLD_MPH }]));
    expect(res.sessionClass).toBe('canoe');
  });

  it('needs 30 continuous minutes — a 20-minute canoe pulse is flat', () => {
    const res = classifySession(
      makeMorning('2026-07-15', [{ fromMin: 6 * 60 + 30, toMin: 6 * 60 + 50, speed: 13 }])
    );
    expect(res.sessionClass).toBe('flat');
    expect(res.canoeSustainedMinutes).toBeLessThan(30);
  });

  it('gate-conditions the canoe run: 12+ before the gate does not count', () => {
    // 04:00-05:30 is a real canoe-strength event, but July's gate does not open until 06:00.
    const res = classifySession(
      makeMorning('2026-07-15', [{ fromMin: 4 * 60, toMin: 5 * 60 + 30, speed: 13 }])
    );
    expect(res.sessionClass).toBe('flat');
    expect(res.canoeSustainedMinutes).toBe(0);
    expect(res.canoePreGateSustainedMinutes).toBeGreaterThanOrEqual(30);
    expect(res.canoeMissedDueToGate).toBe(true);
  });

  it('returns null — never flat — for an unobserved morning (§4.2)', () => {
    const res = classifySession({
      date: '2026-02-01',
      status: 'unobserved',
      reason: 'seasonal-shutdown',
      points: [],
    });
    expect(res.sessionClass).toBeNull();
    expect(res.label).toBeNull();
    expect(res.canoeSustainedMinutes).toBeNull();
  });

  it('returns null for insufficient resolution, so a 240-min day is not a fabricated flat', () => {
    const day = makeMorning('2025-07-15', [{ ...POST_GATE, speed: 13 }]);
    const res = classifySession({ ...day, cycle_type: '240min' });
    expect(res.sessionClass).toBeNull();
    expect(res.canoeSustainedMinutes).toBeNull();
  });
});

describe('label-v1 is untouched by the canoe tier', () => {
  // The regression that matters: if classifySession ever leaks its lower threshold back into the
  // primary label, every frozen backtest result silently changes meaning.
  const cases = [
    ['2026-07-15', 18, true],
    ['2026-07-15', 13, false],
    ['2026-07-15', 9, false],
  ];

  it.each(cases)('%s at %i mph → label %s, matching labelDay exactly', (date, speed, expected) => {
    const day = makeMorning(date, [{ ...POST_GATE, speed }]);
    const direct = labelDay(day);
    const viaClass = classifySession(day);

    expect(direct.label).toBe(expected);
    expect(viaClass.label).toBe(direct.label);
    expect(viaClass.sustainedMinutes).toBe(direct.sustainedMinutes);
    expect(viaClass.threshold).toBe(direct.threshold);
    expect(viaClass.missedDueToGate).toBe(direct.missedDueToGate);
  });
});
