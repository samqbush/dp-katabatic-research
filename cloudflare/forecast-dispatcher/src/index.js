const DENVER_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function isDispatchTime(scheduledTime) {
  const parts = Object.fromEntries(
    DENVER_TIME.formatToParts(new Date(scheduledTime))
      .filter(({ type }) => type === 'hour' || type === 'minute')
      .map(({ type, value }) => [type, Number(value)]),
  );
  return parts.hour === 21 && (parts.minute === 0 || parts.minute === 15);
}

export async function dispatchForecast(env, request = fetch) {
  const response = await request(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: ['Bearer', env.GITHUB_DISPATCH_TOKEN].join(' '),
        'Content-Type': 'application/json',
        'User-Agent': 'dp-katabatic-forecast-dispatcher',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main' }),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${await response.text()}`);
  }
}

export default {
  async scheduled(event, env) {
    if (isDispatchTime(event.scheduledTime)) {
      await dispatchForecast(env);
    }
  },
};
