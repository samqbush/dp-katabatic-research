import { jest } from '@jest/globals';
import {
  dispatchForecast,
  isDispatchTime,
} from '@/cloudflare/forecast-dispatcher/src/index.js';

describe('Cloudflare forecast dispatcher', () => {
  it.each([
    ['MDT primary', '2026-09-04T03:00:00Z'],
    ['MDT retry', '2026-09-04T03:15:00Z'],
    ['MST primary', '2026-12-04T04:00:00Z'],
    ['MST retry', '2026-12-04T04:15:00Z'],
  ])('dispatches at 9 PM Denver time for %s', (_label, scheduledTime) => {
    expect(isDispatchTime(Date.parse(scheduledTime))).toBe(true);
  });

  it.each([
    ['2026-09-04T04:00:00Z'],
    ['2026-12-04T03:00:00Z'],
    ['2026-09-04T03:30:00Z'],
  ])('ignores the inactive UTC trigger or minute at %s', (scheduledTime) => {
    expect(isDispatchTime(Date.parse(scheduledTime))).toBe(false);
  });

  it('dispatches the existing workflow on main', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true });
    const env = {
      GITHUB_OWNER: 'samqbush',
      GITHUB_REPO: 'dp-katabatic-research',
      GITHUB_WORKFLOW: 'katabatic-forecast.yml',
      GITHUB_DISPATCH_TOKEN: 'test-token',
    };

    await dispatchForecast(env, request);

    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/repos/samqbush/dp-katabatic-research/actions/workflows/katabatic-forecast.yml/dispatches',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: '******' }),
        body: '{"ref":"main"}',
      }),
    );
  });

  it('fails loudly when GitHub rejects the dispatch', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: jest.fn().mockResolvedValue('forbidden'),
    });

    await expect(dispatchForecast({
      GITHUB_OWNER: 'owner',
      GITHUB_REPO: 'repo',
      GITHUB_WORKFLOW: 'workflow.yml',
      GITHUB_DISPATCH_TOKEN: 'test-token',
    }, request)).rejects.toThrow('GitHub workflow dispatch failed: 403 forbidden');
  });
});
