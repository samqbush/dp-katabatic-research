import { renderDashboardHtml } from '@/.github/extensions/katabatic-dashboard/lib/renderer.mjs';

describe('Katabatic Research Dashboard renderer', () => {
  it('renders objective observed-wind columns with a data-derived threshold', () => {
    const html = renderDashboardHtml('test-instance');

    expect(html).toContain('<th>Max wind</th><th>Max gust</th>');
    expect(html).toContain('<th>Minutes ≥${esc(data.parameters.thresholdMph)} mph</th>');
    expect(html).toContain('day.observedMorningMaxSpeedMph');
    expect(html).toContain('day.observedMorningMaxGustMph');
    expect(html).toContain('day.observedMorningSustainedMinutes');
    expect(html).not.toContain('<th>Outcome</th>');
    expect(html).not.toContain('<th>Result</th>');
    expect(html).toContain('not calm');
  });
});
