import { renderDashboardHtml } from '@/.github/extensions/katabatic-dashboard/lib/renderer.mjs';

describe('Katabatic Research Dashboard renderer', () => {
  it('renders orthogonal session and flow outcomes with gate-conditioned evidence', () => {
    const html = renderDashboardHtml('test-instance');

    expect(html).toContain('<th>Session outcome</th><th>Flow mechanism</th>');
    expect(html).toContain('<th>Minutes ≥${esc(data.parameters.thresholdMph)}</th>');
    expect(html).toContain('<th>Minutes ≥12</th><th>Gust support</th>');
    expect(html).toContain('day.sessionOutcome');
    expect(html).toContain('day.flowClass');
    expect(html).toContain('day.canoeSustainedMinutes');
    expect(html).toContain('gate-conditioned through sunrise +3 hours');
    expect(html).not.toContain('<th>Result</th>');
    expect(html).toContain('not calm');
  });
});
