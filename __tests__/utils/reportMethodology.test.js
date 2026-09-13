import { COMPLETE_FORECAST_PAIR_SQL } from '@/scripts/lib/dashboard-data.mjs';
import { buildReportMethodology } from '@/scripts/lib/report-methodology.mjs';

const model = {
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
};

function methodology(thresholdMph = 15) {
  return buildReportMethodology({
    thresholdMph,
    model,
    forwardHoldoutStart: '2026-08-11',
  });
}

describe('report methodology', () => {
  it('keeps a sensitivity threshold separate from the frozen chance target', () => {
    const report = methodology(20);
    const session = report.fields.find((field) => field.name === 'Session outcome');
    const chance = report.fields.find((field) => field.name === 'Chance');

    expect(session.calculation).toContain('sustained means >=20 mph');
    expect(chance.sourceWindow).toContain('Target: >=15 mph for >=30 continuous minutes');
    expect(chance.calculation).toContain('unrounded stored averages');
    expect(chance.calculation).toContain('The table\'s wind/lid cells are rounded display values');
  });

  it('explains why the canoe class cannot occur at thresholds at or below 12 mph', () => {
    const report = methodology(10);
    const session = report.fields.find((field) => field.name === 'Session outcome');

    expect(session.calculation).toContain('this class cannot occur');
    expect(session.calculation).toContain('>=12 mph run also satisfies the selected sustained class');
  });

  it('includes exact call boundaries, chance equation, structure score, and all flow outcomes', () => {
    const report = methodology();
    const call = report.fields.find((field) => field.name === 'Call');
    const chance = report.fields.find((field) => field.name === 'Chance');

    expect(call.calculation).toContain('PACK when wind >=9 mph and lid <250 m');
    expect(call.calculation).toContain('wind <5 mph and lid >=250 m');
    expect(call.calculation).toContain('wind <6 mph and lid >=100 m');
    expect(chance.calculation).toContain('clamp(-1.634963979 + 0.888359615 × wind_z - 0.970464876 × lid_z, -30, 30)');
    expect(report.structureScore).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'Direction' }),
      expect.objectContaining({ component: 'Drying' }),
      expect.objectContaining({ component: 'Neighbor contrast' }),
      expect.objectContaining({ component: 'Broader trend' }),
      expect.objectContaining({ component: 'Status' }),
    ]));
    expect(report.flowClasses.map((item) => item.value)).toEqual([
      'unknown (required evidence)',
      'transition-hybrid',
      'unknown (conflict)',
      'katabatic',
      'synoptic',
      'absent',
      'unknown (unresolved)',
    ]);
  });

  it('documents provenance, phase, missing-state semantics, and paired HRRR aggregation', () => {
    const report = methodology();
    const provenance = report.fields.find((field) => field.name === 'Prediction provenance');
    const phase = report.fields.find((field) => field.name === 'Experiment phase');

    expect(provenance.calculation).toContain('collector mode');
    expect(phase.calculation).toContain('independent of prediction provenance');
    expect(report.missingValues).toContain('literal unknown');
    expect(report.missingValues).toContain('absent is affirmative evidence');
    expect(COMPLETE_FORECAST_PAIR_SQL).toBe(
      'h.lid_m IS NOT NULL AND h.wind_mph IS NOT NULL',
    );
  });
});
