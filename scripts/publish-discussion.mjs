#!/usr/bin/env node

import { closePool } from './lib/db.mjs';
import { loadDashboardData } from './lib/dashboard-data.mjs';
import {
  DISCUSSION_TITLE,
  REPORT_DAYS,
  REPORT_THRESHOLD_MPH,
  renderDiscussionReport,
  reportWindowStart,
} from './lib/discussion-report.mjs';

const dryRun = process.argv.includes('--dry-run');

function repositoryParts(value) {
  const match = /^([^/]+)\/([^/]+)$/.exec(value ?? '');
  if (!match) throw new Error('GITHUB_REPOSITORY must be in owner/name form.');
  return { owner: match[1], name: match[2] };
}

async function graphql(query, variables) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN.');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dp-katabatic-research-discussion-publisher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((error) => error.message).join('; ')
      ?? `${response.status} ${response.statusText}`;
    throw new Error(`GitHub GraphQL request failed: ${detail}`);
  }
  return payload.data;
}

async function updateDiscussion(body) {
  const { owner, name } = repositoryParts(process.env.GITHUB_REPOSITORY);
  const number = Number(process.env.KATABATIC_DISCUSSION_NUMBER);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('KATABATIC_DISCUSSION_NUMBER must be a positive integer.');
  }

  const current = await graphql(
    `query KatabaticDiscussion($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $number) {
          id
          title
          body
          url
        }
      }
    }`,
    { owner, name, number },
  );
  const discussion = current.repository?.discussion;
  if (!discussion) throw new Error(`Discussion #${number} does not exist.`);
  if (discussion.title !== DISCUSSION_TITLE) {
    throw new Error(
      `Refusing to overwrite Discussion #${number}: expected title "${DISCUSSION_TITLE}", found "${discussion.title}".`,
    );
  }
  if (discussion.body === body) {
    console.log(`Discussion already current: ${discussion.url}`);
    return;
  }

  const updated = await graphql(
    `mutation UpdateKatabaticDiscussion($discussionId: ID!, $body: String!) {
      updateDiscussion(input: { discussionId: $discussionId, body: $body }) {
        discussion {
          url
        }
      }
    }`,
    { discussionId: discussion.id, body },
  );
  console.log(`Updated ${updated.updateDiscussion.discussion.url}`);
}

try {
  const data = await loadDashboardData({
    recentDays: REPORT_DAYS,
    thresholdMph: REPORT_THRESHOLD_MPH,
    archiveFrom: reportWindowStart(),
  });
  const body = renderDiscussionReport(data);
  if (dryRun) process.stdout.write(body);
  else await updateDiscussion(body);
} finally {
  await closePool();
}
