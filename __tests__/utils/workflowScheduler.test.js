import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
  dispatchWorkflow,
  getScheduledDispatch,
  handleScheduled,
  LEGACY_WORKFLOWS,
  SCHEDULER_CRON,
  WORKFLOWS,
} from '@/cloudflare/workflow-scheduler/src/index.js';

const ENV = {
  GITHUB_OWNER: 'samqbush',
  GITHUB_REPO: 'dp-katabatic-research',
  GITHUB_REF: 'main',
  GITHUB_DISPATCH_TOKEN: 'test-token',
};

const WORKFLOW_DIR = path.join(process.cwd(), '.github', 'workflows');

function topLevelName(filename) {
  const source = fs.readFileSync(path.join(WORKFLOW_DIR, filename), 'utf8');
  return source.match(/^name:\s*(.+)$/m)?.[1];
}

describe('Cloudflare workflow scheduler', () => {
  it.each([
    ['MDT archive', '2026-09-04T20:15:00Z', WORKFLOWS.archive],
    ['MST archive', '2026-12-04T21:15:00Z', WORKFLOWS.archive],
    ['MDT archive publish fallback', '2026-09-04T20:45:00Z', WORKFLOWS.publish],
    ['MST archive publish fallback', '2026-12-04T21:45:00Z', WORKFLOWS.publish],
    ['MDT forecast primary', '2026-09-05T03:00:00Z', WORKFLOWS.forecast],
    ['MST forecast primary', '2026-12-05T04:00:00Z', WORKFLOWS.forecast],
    ['MDT forecast retry', '2026-09-05T03:15:00Z', WORKFLOWS.forecast],
    ['MST forecast retry', '2026-12-05T04:15:00Z', WORKFLOWS.forecast],
    ['MDT forecast publish fallback', '2026-09-05T03:45:00Z', WORKFLOWS.publish],
    ['MST forecast publish fallback', '2026-12-05T04:45:00Z', WORKFLOWS.publish],
  ])('routes %s to the expected workflow', (_label, scheduledTime, workflow) => {
    expect(getScheduledDispatch(Date.parse(scheduledTime))).toMatchObject({ workflow });
  });

  it.each([
    '2026-09-04T20:00:00Z',
    '2026-09-04T21:15:00Z',
    '2026-12-05T04:30:00Z',
  ])('ignores inactive Denver-local time %s', (scheduledTime) => {
    expect(getScheduledDispatch(Date.parse(scheduledTime))).toBeNull();
  });

  it('dispatches exactly one workflow for an admitted cron event', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true });

    await handleScheduled({
      cron: SCHEDULER_CRON,
      scheduledTime: Date.parse('2026-09-05T03:00:00Z'),
    }, ENV, request);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      `https://api.github.com/repos/samqbush/dp-katabatic-research/actions/workflows/${WORKFLOWS.forecast}/dispatches`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: ['Bearer', 'test-token'].join(' '),
        }),
        body: '{"ref":"main"}',
      }),
    );
  });

  it('passes the explicit archive lookback as a string input', async () => {
    const request = jest.fn().mockResolvedValue({ ok: true });

    await handleScheduled({
      cron: SCHEDULER_CRON,
      scheduledTime: Date.parse('2026-09-04T20:15:00Z'),
    }, ENV, request);

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining(`/${WORKFLOWS.archive}/dispatches`),
      expect.objectContaining({
        body: '{"ref":"main","inputs":{"days":"14"}}',
      }),
    );
  });

  it('ignores events from an unexpected cron expression', async () => {
    const request = jest.fn();

    await handleScheduled({
      cron: '0 * * * *',
      scheduledTime: Date.parse('2026-09-05T03:00:00Z'),
    }, ENV, request);

    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the legacy workflow path during the rename rollout', async () => {
    const request = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('not found'),
      })
      .mockResolvedValueOnce({ ok: true });

    await handleScheduled({
      cron: SCHEDULER_CRON,
      scheduledTime: Date.parse('2026-09-05T03:00:00Z'),
    }, ENV, request);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toContain(`/${WORKFLOWS.forecast}/dispatches`);
    expect(request.mock.calls[1][0]).toContain(`/${LEGACY_WORKFLOWS.forecast}/dispatches`);
  });

  it.each(Object.values(WORKFLOWS))(
    'supports validation-only dispatch for %s',
    async (workflow) => {
      const request = jest.fn().mockResolvedValue({ ok: true });

      await dispatchWorkflow(ENV, workflow, { validate_only: 'true' }, request);

      expect(request).toHaveBeenCalledWith(
        expect.stringContaining(`/${workflow}/dispatches`),
        expect.objectContaining({
          body: '{"ref":"main","inputs":{"validate_only":"true"}}',
        }),
      );
    },
  );

  it('fails loudly when GitHub rejects a dispatch', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: jest.fn().mockResolvedValue('forbidden'),
    });

    await expect(dispatchWorkflow(
      ENV,
      WORKFLOWS.forecast,
      undefined,
      request,
    )).rejects.toThrow(
      `GitHub workflow dispatch failed for ${WORKFLOWS.forecast}: 403 forbidden`,
    );
  });

  it('targets workflow files that exist', () => {
    for (const workflow of Object.values(WORKFLOWS)) {
      expect(fs.existsSync(path.join(WORKFLOW_DIR, workflow))).toBe(true);
    }
  });

  it('keeps publisher workflow_run names aligned with producer display names', () => {
    const publisher = fs.readFileSync(
      path.join(WORKFLOW_DIR, WORKFLOWS.publish),
      'utf8',
    );

    expect(publisher).toContain(`      - ${topLevelName(WORKFLOWS.forecast)}`);
    expect(publisher).toContain(`      - ${topLevelName(WORKFLOWS.archive)}`);
  });

  it('prevents validation-only producers from cascading into publication', () => {
    const forecast = fs.readFileSync(
      path.join(WORKFLOW_DIR, WORKFLOWS.forecast),
      'utf8',
    );
    const archive = fs.readFileSync(
      path.join(WORKFLOW_DIR, WORKFLOWS.archive),
      'utf8',
    );
    const publisher = fs.readFileSync(
      path.join(WORKFLOW_DIR, WORKFLOWS.publish),
      'utf8',
    );

    expect(forecast).toContain("run-name: ${{ inputs.validate_only && 'Validate ");
    expect(archive).toContain("run-name: ${{ inputs.validate_only && 'Validate ");
    expect(publisher).toContain(
      "!startsWith(github.event.workflow_run.display_title, 'Validate ')",
    );
    expect(publisher).toContain('katabatic-discussion-publisher-validation');
  });
});
