import {
  REPORT_THRESHOLD_MPH,
  assertPublishableReport,
  renderDiscussionReport,
  reportWindowStart,
} from '@/scripts/lib/discussion-report.mjs';

function fixture() {
  return {
    research: {
      experimentalRuleStatus: 'UNSAFE: research | display only.',
      morningAutomation: 'No alarm is sent.',
      probabilityModel: {
        modelVersion: 'wind-lid-logistic-v1',
        trainedThrough: '2026-08-10',
        trainingPairs: 130,
      },
    },
    stationHealth: [{
      slug: 'dp-soda-lakes',
      latestDate: '2026-08-17',
      latestFetchedAt: '2026-08-17T20:00:00.000Z',
      lagDays: 0,
    }],
    recent: [{
      date: '2026-08-18',
      forecastCall: 'PACK',
      successChancePercent: 65,
      label: null,
      forecastResult: null,
      observedMorningMaxSpeedMph: null,
      observedMorningMaxGustMph: null,
      observedMorningSustainedMinutes: null,
      sessionOutcome: null,
      flowClass: null,
      sustainedMinutes: null,
      canoeSustainedMinutes: null,
      canoeMeanGustMph: null,
      canoePeakGustMph: null,
      canoePctGustAtLeast18: null,
      avgForecastWindMph: 10.2,
      avgLidM: 80,
      predictionMode: 'forward',
      predictionGeneratedAt: '2026-08-18T01:31:00.000Z',
      forecastPhase: 'held-out',
      hasForecast: true,
    }, {
      date: '2026-08-10',
      forecastCall: 'SLEEP IN',
      successChancePercent: 10,
      label: true,
      forecastResult: { label: 'MISSED SESSION', tone: 'danger' },
      observedMorningMaxSpeedMph: 18.4,
      observedMorningMaxGustMph: 23.1,
      observedMorningSustainedMinutes: 35,
      sessionOutcome: 'gust-driven/canoe',
      flowClass: 'transition-hybrid',
      sustainedMinutes: 20,
      canoeSustainedMinutes: 35,
      canoeMeanGustMph: 20.4,
      canoePeakGustMph: 23.1,
      canoePctGustAtLeast18: 86,
      avgForecastWindMph: 3.1,
      avgLidM: 450,
      predictionMode: 'retrospective',
      predictionGeneratedAt: '2026-08-17T22:00:00.000Z',
      forecastPhase: 'backfill',
      hasForecast: true,
    }],
  };
}

describe('GitHub Discussion report', () => {
  it('renders provenance, warnings, and objective observed wind', () => {
    const report = renderDiscussionReport(fixture());

    expect(report).toContain('Research display only — not a go/no-go recommendation');
    expect(report).toContain('UNSAFE: research \\| display only.');
    expect(report).toContain('2026-08-18<br><sub>forward</sub>');
    expect(report).toContain('2026-08-10<br><sub>retrospective</sub>');
    expect(report).toContain(`| Date / sample | Call | Chance | Session outcome | Flow mechanism | Minutes ≥${REPORT_THRESHOLD_MPH} | Minutes ≥12 | Gust support | HRRR wind | Lid |`);
    expect(report).toContain('gust-driven/canoe');
    expect(report).toContain('transition-hybrid');
    expect(report).toContain('20 min');
    expect(report).toContain('23.1 mph');
    expect(report).toContain('35 min');
    expect(report).not.toContain('| Outcome | Result |');
    expect(report).not.toContain('MISSED SESSION');
    const forecastOnlyRow = report.split('\n').find((line) => line.startsWith('| 2026-08-18'));
    expect(forecastOnlyRow).toContain('— | — | —');
    expect(report).toContain('gate-conditioned through sunrise +3 hours');
    expect(report).toContain('Chance still predicts only the strict sustained target');
    expect(report).toContain('not calm wind');
    expect(report).toContain('wind-lid-logistic-v1');
  });

  it('shows a stale archive warning', () => {
    const data = fixture();
    data.stationHealth[0].lagDays = 3;
    expect(renderDiscussionReport(data)).toContain('Soda archive is stale');
  });

  it('refuses empty data or data without a stored prediction', () => {
    expect(() => assertPublishableReport({ recent: [] })).toThrow('empty');
    const data = fixture();
    data.recent = [{ hasForecast: true, forecastCall: null, predictionMode: null }];
    expect(() => assertPublishableReport(data)).toThrow('stored prediction');
  });

  it('computes the rolling window in Denver rather than UTC', () => {
    expect(reportWindowStart(new Date('2026-08-18T01:00:00Z'), 14)).toBe('2026-08-04');
    expect(reportWindowStart(new Date('2026-08-18T07:00:00Z'), 14)).toBe('2026-08-05');
  });
});
