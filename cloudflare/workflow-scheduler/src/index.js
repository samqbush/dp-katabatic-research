export const SCHEDULER_CRON = '*/15 * * * *';

export const WORKFLOWS = Object.freeze({
  forecast: 'collect-night-before-forecast.yml',
  archive: 'archive-weather-observations.yml',
  publish: 'publish-research-snapshot.yml',
});

export const LEGACY_WORKFLOWS = Object.freeze({
  forecast: 'katabatic-forecast.yml',
  archive: 'katabatic-archive.yml',
  publish: 'katabatic-publish.yml',
});

const DENVER_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const SCHEDULES = new Map([
  ['14:15', {
    workflow: WORKFLOWS.archive,
    legacyWorkflow: LEGACY_WORKFLOWS.archive,
    inputs: { days: '14' },
  }],
  ['14:45', {
    workflow: WORKFLOWS.publish,
    legacyWorkflow: LEGACY_WORKFLOWS.publish,
  }],
  ['21:00', {
    workflow: WORKFLOWS.forecast,
    legacyWorkflow: LEGACY_WORKFLOWS.forecast,
  }],
  ['21:15', {
    workflow: WORKFLOWS.forecast,
    legacyWorkflow: LEGACY_WORKFLOWS.forecast,
  }],
  ['21:45', {
    workflow: WORKFLOWS.publish,
    legacyWorkflow: LEGACY_WORKFLOWS.publish,
  }],
]);

function denverTime(scheduledTime) {
  const parts = Object.fromEntries(
    DENVER_TIME.formatToParts(new Date(scheduledTime))
      .filter(({ type }) => type === 'hour' || type === 'minute')
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.hour}:${parts.minute}`;
}

export function getScheduledDispatch(scheduledTime) {
  return SCHEDULES.get(denverTime(scheduledTime)) ?? null;
}

export async function dispatchWorkflow(
  env,
  workflow,
  inputs,
  request = fetch,
  legacyWorkflow,
) {
  const body = { ref: env.GITHUB_REF };
  if (inputs && Object.keys(inputs).length > 0) {
    body.inputs = inputs;
  }

  const response = await request(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: ['Bearer', env.GITHUB_DISPATCH_TOKEN].join(' '),
        'Content-Type': 'application/json',
        'User-Agent': 'dp-katabatic-workflow-scheduler',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    },
  );

  if (response.ok) {
    return;
  }

  const responseText = await response.text();
  if (response.status === 404 && legacyWorkflow) {
    return dispatchWorkflow(env, legacyWorkflow, inputs, request);
  }

  throw new Error(
    `GitHub workflow dispatch failed for ${workflow}: ${response.status} ${responseText}`,
  );
}

export async function handleScheduled(event, env, request = fetch) {
  if (event.cron !== SCHEDULER_CRON) {
    return;
  }

  const dispatch = getScheduledDispatch(event.scheduledTime);
  if (dispatch) {
    await dispatchWorkflow(
      env,
      dispatch.workflow,
      dispatch.inputs,
      request,
      dispatch.legacyWorkflow,
    );
  }
}

export default {
  async scheduled(event, env) {
    await handleScheduled(event, env);
  },
};
