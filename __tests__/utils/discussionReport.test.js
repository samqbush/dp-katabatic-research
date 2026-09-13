import {
  REPORT_THRESHOLD_MPH,
  assertPublishableReport,
  escapeDiscussionCell,
  renderDiscussionReport,
  reportWindowStart,
} from '@/scripts/lib/discussion-report.mjs';
import { buildReportMethodology } from '@/scripts/lib/report-methodology.mjs';

function fixture() {
  const data = {
    parameters: {
      thresholdMph: REPORT_THRESHOLD_MPH,
    },
    research: {
      experimentalRuleStatus: 'UNSAFE: research | display only.',
      morningAutomation: 'No alarm is sent.',
      probabilityModel: {
        modelVersion: 'wind-lid-logistic-v1',
        trainedThrough: '2026-08-10',
        trainingPairs: 130,
        targetThresholdMph: 15,
        targetSustainedMinutes: 30,
        parameters: {
          windMean: 6.6325,
          windSd: 3.5682516323177755,
          lidMean: 297.6826923076923,
          lidSd: 237.9577123640264,
          weights: [
            -1.634963978772643,
            0.8883596150515636,
            -0.9704648759371536,
          ],
          displayRoundingPercent: 5,
          displayCapPercent: [5, 95],
        },
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
  data.methodology = buildReportMethodology({
    thresholdMph: data.parameters.thresholdMph,
    model: data.research.probabilityModel,
    forwardHoldoutStart: '2026-08-11',
  });
  return data;
}

describe('GitHub Discussion report', () => {
  it('renders separate provenance/phase fields and objective observed wind', () => {
    const report = renderDiscussionReport(fixture());

    expect(report).toContain('Research display only — not a go/no-go recommendation');
    expect(report).toContain('UNSAFE: research \\| display only.');
    expect(report).toContain('Prediction provenance: **forward** · Experiment phase: **held-out**');
    expect(report).toContain(`| Date | Prediction provenance | Experiment phase | Call | Chance | Session outcome | Flow mechanism | Minutes ≥${REPORT_THRESHOLD_MPH} | Minutes ≥12 | Gust support | HRRR wind | Lid |`);
    expect(report).toContain('| 2026-08-18 | forward | held-out | PACK | 65% |');
    expect(report).toContain('| 2026-08-10 | retrospective | backfill | SLEEP IN | 10% |');
    expect(report).toContain('gust-driven/canoe');
    expect(report).toContain('transition-hybrid');
    expect(report).toContain('20 min');
    expect(report).toContain('23.1 mph');
    expect(report).toContain('35 min');
    expect(report).not.toContain('| Outcome | Result |');
    expect(report).not.toContain('MISSED SESSION');
    const forecastOnlyRow = report.split('\n').find((line) => line.startsWith('| 2026-08-18'));
    expect(forecastOnlyRow).toContain('| — | — | — | — | — |');
    expect(report).toContain('wind-lid-logistic-v1');
  });

  it('documents every field, exact chance math, and flow-class-v1 precedence', () => {
    const report = renderDiscussionReport(fixture());

    expect(report).toContain('## How each field is calculated');
    for (const field of [
      'Date',
      'Prediction provenance',
      'Experiment phase',
      'Call',
      'Chance',
      'Session outcome',
      'Flow mechanism',
      `Minutes >=${REPORT_THRESHOLD_MPH}`,
      'Minutes >=12',
      'Gust support',
      'Average HRRR wind',
      'Average lid',
    ]) {
      expect(report).toContain(`| ${field} |`);
    }
    expect(report).toContain('wind_z = (wind - 6.6325) / 3.568252');
    expect(report).toContain('linear score = clamp(-1.634963979 + 0.888359615 × wind_z - 0.970464876 × lid_z, -30, 30)');
    expect(report).toContain('Round to the nearest 5% and cap the displayed result at 5%-95%.');
    expect(report).toContain('PACK when wind >=9 mph and lid <250 m');
    expect(report).toContain('## How flow mechanism is classified');
    expect(report).toContain('PRESENT at score >=3; POSSIBLE at score >=1; otherwise ABSENT');
    expect(report).toContain('The implemented v1 rule does not prove that earlier pulse was pre-sunrise drainage');
    expect(report).toContain('| katabatic |');
    expect(report).toContain('| synoptic |');
    expect(report).toContain('| absent |');
    expect(report).toContain('A literal unknown means flow-class-v1 ran');
  });

  it('keeps unavailable, stamped unknown, and affirmative absent distinct', () => {
    const data = fixture();
    data.recent.push(
      {
        ...data.recent[1],
        date: '2026-08-09',
        flowClass: 'unknown',
      },
      {
        ...data.recent[1],
        date: '2026-08-08',
        flowClass: 'absent',
      },
    );
    const report = renderDiscussionReport(data);

    expect(report.split('\n').find((line) => line.startsWith('| 2026-08-18'))).toContain('| — |');
    expect(report.split('\n').find((line) => line.startsWith('| 2026-08-09'))).toContain('| unknown |');
    expect(report.split('\n').find((line) => line.startsWith('| 2026-08-08'))).toContain('| absent |');
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

    const withoutMethodology = fixture();
    withoutMethodology.methodology = null;
    expect(() => assertPublishableReport(withoutMethodology)).toThrow('methodology');
  });

  it('computes the rolling window in Denver rather than UTC', () => {
    expect(reportWindowStart(new Date('2026-08-18T01:00:00Z'), 14)).toBe('2026-08-04');
    expect(reportWindowStart(new Date('2026-08-18T07:00:00Z'), 14)).toBe('2026-08-05');
  });

  it('escapes Markdown table cells', () => {
    expect(escapeDiscussionCell('a | b\\c\nnext')).toBe('a \\| b\\\\c<br>next');
  });
});
