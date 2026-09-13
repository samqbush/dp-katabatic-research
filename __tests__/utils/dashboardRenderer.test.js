import {
  escapeDashboardText,
  renderDashboardHtml,
} from '@/.github/extensions/katabatic-dashboard/lib/renderer.mjs';

describe('Katabatic Research Dashboard renderer', () => {
  it('renders separate provenance/phase columns and shared methodology guides', () => {
    const html = renderDashboardHtml('test-instance');

    expect(html).toContain('<th>Prediction provenance</th><th>Experiment phase</th>');
    expect(html).toContain('<th>Session outcome</th><th>Flow mechanism</th>');
    expect(html).toContain('<th>Minutes ≥${esc(data.parameters.thresholdMph)}</th>');
    expect(html).toContain('<th>Minutes ≥12</th><th>Gust support</th>');
    expect(html).toContain('methodology.fields.map');
    expect(html).toContain('methodology.flowPrerequisites.map');
    expect(html).toContain('methodology.structureScore.map');
    expect(html).toContain('methodology.flowClasses.map');
    expect(html).toContain('<h2>How each field is calculated</h2>');
    expect(html).toContain('<h2>How flow mechanism is classified</h2>');
    expect(html).toContain('day.sessionOutcome');
    expect(html).toContain('day.flowClass');
    expect(html).toContain('day.canoeSustainedMinutes');
    expect(html).not.toContain('<th>Result</th>');
  });

  it('labels non-default threshold results without changing stored predictions or flow', () => {
    const html = renderDashboardHtml('test-instance');

    expect(html).toContain('const hasTargetThreshold = Number.isFinite(Number(targetThreshold))');
    expect(html).toContain('Number(data.parameters.thresholdMph) !== Number(targetThreshold)');
    expect(html).toContain('Threshold-sensitivity view.');
    expect(html).toContain('summary counts, held-out rideable/miss metrics, and call-result');
    expect(html).toContain('Stored calls, stored chances, the frozen');
    expect(html).toContain('and flow mechanisms do not change.');
  });

  it('escapes dashboard text using the renderer function embedded in the page', () => {
    expect(escapeDashboardText('<a href="x">Tom & Sam\'s</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Sam&#039;s&lt;/a&gt;',
    );
    expect(renderDashboardHtml('test-instance')).toContain(
      `const esc = ${escapeDashboardText.toString()};`,
    );
  });
});
