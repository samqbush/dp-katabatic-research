# Reliable GitHub Actions scheduling with Cloudflare Workers

This guide explains how to use a Cloudflare Worker Cron Trigger as the reliable
scheduler for an existing GitHub Actions workflow.

The important design choice is:

- **Cloudflare schedules the run.**
- **GitHub Actions still performs the real job.**
- The Worker contains no application logic. It only calls GitHub's
  `workflow_dispatch` REST API endpoint.

This keeps the Worker small, makes manual GitHub runs possible, and avoids
duplicating secrets or job logic outside GitHub Actions.

## Architecture

```text
Cloudflare Cron Trigger
        |
        v
Cloudflare Worker's scheduled() handler
        |
        | POST /repos/OWNER/REPO/actions/workflows/WORKFLOW/dispatches
        v
GitHub Actions workflow_dispatch
        |
        v
Existing GitHub Actions job
```

Use this pattern when GitHub's `schedule` event is too delayed or inconsistent
for a time-sensitive job. GitHub does not guarantee that scheduled workflows
start at the exact cron time, especially during periods of high load.

## What you need

1. A Cloudflare account with Workers enabled.
2. A GitHub repository containing the workflow you want to run.
3. A GitHub credential that may dispatch that workflow.
4. Wrangler, Cloudflare's Worker CLI, or a GitHub Actions deployment workflow.

The target GitHub workflow must be present on the repository's default branch.

## 1. Make the GitHub workflow dispatchable

Add `workflow_dispatch` to the workflow that Cloudflare will trigger:

```yaml
name: Scheduled job

on:
  workflow_dispatch:
    inputs:
      validate_only:
        description: Validate dispatch without doing real work
        type: boolean
        default: false

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: Validate dispatch
        if: inputs.validate_only
        run: echo "Workflow dispatch succeeded."

      - name: Run the real job
        if: ${{ !inputs.validate_only }}
        run: ./run-the-real-job
```

The `validate_only` input is optional but strongly recommended. It gives you a
safe way to test the Worker, GitHub token, repository settings, and workflow
name without running the production job.

You can leave the old GitHub `schedule` trigger in place temporarily while
testing Cloudflare. Remove it after the Cloudflare schedule has been verified
if duplicate runs would be harmful.

## 2. Create the GitHub dispatch credential

For a simple personal automation, create a fine-grained personal access token:

1. Open **GitHub > Settings > Developer settings > Personal access tokens >
   Fine-grained tokens**.
2. Select the owner of the target repository.
3. Limit repository access to only the repository being automated.
4. Grant repository permission **Actions: Read and write**.
5. Give the token an expiration date and a descriptive name such as
   `cloudflare-dispatch-example-repo`.
6. Copy the token when GitHub displays it.

Fine-grained tokens may require organization-owner approval. For a long-lived
organization integration or a dispatcher covering many repositories, use a
GitHub App instead of one person's personal access token.

The Worker credential cannot be the target workflow's built-in `GITHUB_TOKEN`.
That token exists only while a GitHub Actions job is already running. Cloudflare
needs its own credential to start the job.

Official reference:

- [Managing GitHub personal access tokens](https://docs.github.com/en/enterprise-cloud@latest/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Create a workflow dispatch event](https://docs.github.com/en/enterprise-cloud@latest/rest/actions/workflows#create-a-workflow-dispatch-event)

## 3. Create the Worker

A minimal project can contain only two files:

```text
cloudflare/workflow-dispatcher/
├── src/
│   └── index.js
└── wrangler.jsonc
```

### `src/index.js`

```js
const LOCAL_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function isDispatchTime(scheduledTime, env) {
  const parts = Object.fromEntries(
    LOCAL_TIME.formatToParts(new Date(scheduledTime))
      .filter(({ type }) => type === 'hour' || type === 'minute')
      .map(({ type, value }) => [type, Number(value)]),
  );

  const allowedMinutes = env.TARGET_MINUTES.split(',').map(Number);
  return parts.hour === Number(env.TARGET_HOUR)
    && allowedMinutes.includes(parts.minute);
}

async function dispatchWorkflow(env) {
  const url = [
    'https://api.github.com/repos',
    env.GITHUB_OWNER,
    env.GITHUB_REPO,
    'actions/workflows',
    env.GITHUB_WORKFLOW,
    'dispatches',
  ].join('/');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'cloudflare-workflow-dispatcher',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub workflow dispatch failed: ${response.status} ${await response.text()}`,
    );
  }
}

export default {
  async scheduled(event, env) {
    if (isDispatchTime(event.scheduledTime, env)) {
      await dispatchWorkflow(env);
    }
  },
};
```

This example uses `America/Denver`. Change the IANA time-zone name if the job
uses a different local time.

### `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "example-workflow-dispatcher",
  "main": "src/index.js",
  "compatibility_date": "2026-09-13",
  "workers_dev": false,
  "vars": {
    "GITHUB_OWNER": "OWNER",
    "GITHUB_REPO": "REPOSITORY",
    "GITHUB_WORKFLOW": "scheduled-job.yml",
    "GITHUB_REF": "main",
    "TARGET_HOUR": "21",
    "TARGET_MINUTES": "0,15"
  },
  "triggers": {
    "crons": [
      "0 3 * * *",
      "15 3 * * *",
      "0 4 * * *",
      "15 4 * * *"
    ]
  }
}
```

Cloudflare recommends JSONC for new Wrangler projects. Existing TOML
configurations remain supported.

Keep ordinary configuration in `vars`. Never put the GitHub token, Cloudflare
token, database credentials, or other secrets in `vars` or commit them to the
repository.

Official reference:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 4. Understand UTC and daylight-saving time

Cloudflare Cron Triggers always use UTC.

If the desired time is a fixed UTC time, configure one cron expression and no
local-time filter is necessary.

If the desired time is a fixed wall-clock time in a zone that observes
daylight-saving time, the UTC time changes during the year. The robust pattern
is:

1. Register both possible UTC hours in `wrangler.jsonc`.
2. In the Worker, convert `event.scheduledTime` to the desired IANA time zone.
3. Dispatch only when the converted local hour and minute match.

For example, 9:00 PM in Denver is:

- 03:00 UTC during Mountain Daylight Time.
- 04:00 UTC during Mountain Standard Time.

Therefore, the configuration registers both `0 3 * * *` and `0 4 * * *`, while
the Worker rejects whichever trigger does not currently represent 9:00 PM in
Denver.

Do not solve this by manually changing the cron twice a year.

Cron changes can take up to 15 minutes to propagate through Cloudflare.

Official reference:

- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## 5. Decide whether to use a retry trigger

For important jobs, consider dispatching at the desired time and again 10-15
minutes later.

Only do this when the target workflow is idempotent. The target must safely
handle two runs for the same logical period by using one or more of:

- A database uniqueness key.
- An upsert instead of an append.
- A "work already complete" check.
- A GitHub Actions `concurrency` group.

A retry trigger improves the chance that a temporary Cloudflare-to-GitHub
request failure does not cause a missed day. It must not create duplicate
emails, payments, destructive operations, or duplicate database rows.

## 6. Initialize the Cloudflare account

Before the first deployment:

1. Open [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages).
2. Select the intended Cloudflare account.
3. If prompted, initialize the account's `workers.dev` subdomain.

A cron-only Worker can set `workers_dev` to `false`, so it has no public HTTP
route. Cloudflare may still require the account-level subdomain to be
initialized before it allows the first Worker or Cron Trigger deployment.

## 7. Deploy manually with Wrangler

Manual deployment is useful for learning the process and does not require a
GitHub Actions deployment workflow.

Install or invoke Wrangler:

```bash
npx wrangler --version
npx wrangler login
```

To avoid deploying an active cron before its GitHub secret exists:

1. Temporarily remove the `triggers` block from `wrangler.jsonc`.
2. Deploy the Worker:

   ```bash
   npx wrangler deploy
   ```

3. Add the encrypted GitHub token. Wrangler prompts for the value without
   requiring it in the command:

   ```bash
   npx wrangler secret put GITHUB_DISPATCH_TOKEN
   ```

4. Restore the `triggers` block.
5. Deploy again:

   ```bash
   npx wrangler deploy
   ```

The second deployment installs the cron configuration. The GitHub token remains
an encrypted Worker secret and is not written to `wrangler.jsonc`.

## 8. Deploy automatically from GitHub Actions

After the manual process is understood, CI deployment makes Worker changes
repeatable and reviewable.

Create a Cloudflare API token:

1. Open **Cloudflare > Manage Account > API Tokens**.
2. Create a token from **Edit Cloudflare Workers**.
3. Restrict it to the one Cloudflare account used for this Worker.
4. Copy the token when Cloudflare displays it. The secret is shown only once.
5. Find and copy the Cloudflare account ID.

Add these repository secrets under **GitHub repository > Settings > Secrets and
variables > Actions**:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Allows Wrangler to deploy the Worker |
| `CLOUDFLARE_ACCOUNT_ID` | Selects the Cloudflare account |
| `GITHUB_WORKFLOW_DISPATCH_TOKEN` | Uploaded as the Worker's encrypted GitHub secret |

Example `.github/workflows/deploy-workflow-dispatcher.yml`:

```yaml
name: Deploy workflow dispatcher

on:
  push:
    branches:
      - main
    paths:
      - cloudflare/workflow-dispatcher/**
      - .github/workflows/deploy-workflow-dispatcher.yml
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-workflow-dispatcher
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Deploy Cloudflare Worker
        uses: cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0 # v4.0.0
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: cloudflare/workflow-dispatcher
          command: deploy
          secrets: |
            GITHUB_DISPATCH_TOKEN
        env:
          GITHUB_DISPATCH_TOKEN: ${{ secrets.GITHUB_WORKFLOW_DISPATCH_TOKEN }}
```

Pin third-party actions to a full commit SHA. Dependabot can be configured to
propose updates when a new action version is available.

Official reference:

- [Deploy Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Create a Cloudflare API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Using secrets in GitHub Actions](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

## 9. Verify the complete path

Verify each boundary separately instead of waiting for the first scheduled run.

### Verify the GitHub token

Trigger the validation-only workflow directly:

```bash
read -s GITHUB_DISPATCH_TOKEN
export GITHUB_DISPATCH_TOKEN

curl --fail-with-body \
  --request POST \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GITHUB_DISPATCH_TOKEN" \
  --header "Content-Type: application/json" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --data '{"ref":"main","inputs":{"validate_only":"true"}}' \
  "https://api.github.com/repos/OWNER/REPOSITORY/actions/workflows/scheduled-job.yml/dispatches"

unset GITHUB_DISPATCH_TOKEN
```

Then confirm that a validation-only run appears in the repository's **Actions**
tab.

### Verify the Worker deployment

In Cloudflare:

1. Open **Workers & Pages**.
2. Select the Worker.
3. Confirm the expected Cron Triggers under **Settings > Triggers**.
4. Check **Cron Events** after a scheduled time.
5. Check Worker logs for a thrown GitHub API error.

In GitHub:

1. Open the target workflow in **Actions**.
2. Confirm the event is `workflow_dispatch`.
3. Confirm the expected branch and inputs.
4. Confirm that any retry is a safe no-op or idempotent rerun.

## 10. Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| GitHub returns `401` | Missing, expired, or incorrect GitHub token | Rotate the Worker secret and retest |
| GitHub returns `403` | Token lacks Actions write access, requires approval, or owner lacks repository access | Correct token permissions or approve it |
| GitHub returns `404` | Wrong owner, repository, workflow file name, or inaccessible private repository | Check Wrangler vars and token repository selection |
| GitHub returns `422` | Wrong branch, missing required input, or invalid input value | Check the JSON body and workflow inputs |
| Wrangler cannot create the cron | Cloudflare Workers account/subdomain is not initialized | Open Workers & Pages once and complete setup |
| Worker deploys but no workflow appears | Local-time filter rejected the UTC trigger | Check time zone, UTC hours, target hour, and target minutes |
| Job runs twice | Both old GitHub schedule and Cloudflare trigger are active, or retry is not idempotent | Remove the old schedule or add duplicate protection |
| Deployment cannot find `wrangler.jsonc` | Wrong `workingDirectory` | Point the action to the directory containing the Wrangler config |
| Cron change seems ignored | Cloudflare propagation delay | Wait up to 15 minutes and recheck |

## How this repository implements the pattern

The katabatic repository uses these files:

- `cloudflare/workflow-scheduler/src/index.js` contains the Denver-local
  schedule table and GitHub REST request.
- `cloudflare/workflow-scheduler/wrangler.toml` contains the existing deployed
  Worker service name, repository/ref variables, and one Cron Trigger.
- `.github/workflows/deploy-cloudflare-scheduler.yml` deploys the Worker and
  installs its encrypted GitHub token.
- `.github/workflows/collect-night-before-forecast.yml`,
  `.github/workflows/archive-weather-observations.yml`, and
  `.github/workflows/publish-research-snapshot.yml` accept `workflow_dispatch`
  and a safe `validate_only` input.
- `__tests__/utils/workflowScheduler.test.js` verifies MDT/MST admission,
  target/name contracts, API payloads, and explicit failure when GitHub rejects
  a request.

The production Worker has one `*/15 * * * *` trigger and admits only 2:15,
2:45, 9:00, 9:15, and 9:45 PM in `America/Denver`. This stays below the Workers
Free limit of five Cron Triggers per account and follows daylight-saving changes
without paired UTC expressions. The 9:15 forecast call is safe because issued
predictions are immutable and duplicate issuance is a no-op.

The Worker has `workers_dev = false`, so it is cron-only and does not expose a
public Worker URL.

## Sam's checklist: repeat this manually in another repository

This section assumes the Cloudflare account is already initialized and you want
to reuse the approach from `dp-katabatic-research`.

### 1. Write down the new repository's values

Before editing anything, decide:

| Value | Example |
|---|---|
| GitHub owner | `samqbush` |
| GitHub repository | `another-repo` |
| Target workflow file | `nightly-job.yml` |
| Default branch | `main` |
| Unique Cloudflare Worker name | `another-repo-nightly-dispatcher` |
| Desired local time | `21:00 America/Denver` |
| Optional retry time | `21:15 America/Denver` |

Cloudflare Worker names must be unique within your Cloudflare account. Do not
reuse `dp-katabatic-forecast-dispatcher`.

### 2. Prepare the target workflow

In the new repository:

1. Open `.github/workflows/nightly-job.yml`.
2. Add `workflow_dispatch`.
3. Add a `validate_only` input and make it skip all real writes.
4. Make sure the workflow file is committed to the default branch.
5. Manually run it once from GitHub to prove the workflow itself works before
   involving Cloudflare.

### 3. Create a repository-specific GitHub token

Create a new fine-grained token limited to the new repository with
**Actions: Read and write**.

Using a separate token per repository is easier to revoke and limits the effect
of a leak. You may expand an existing fine-grained token's repository selection,
but that couples unrelated automations.

GitHub and Cloudflare do not let you recover an existing secret's value:

- If you still have the existing Cloudflare API token value in a password
  manager, it can be reused because the new Worker is in the same account and
  the token permits Worker edits there.
- If the Cloudflare token exists only as a masked GitHub secret, create a new
  Cloudflare API token.
- Create a new GitHub dispatch token for the new repository unless the existing
  token was deliberately authorized for both repositories.

### 4. Copy and customize the Worker

Copy this repository's `cloudflare/workflow-scheduler` directory into the new
repository, then change:

1. The Worker `name`.
2. `GITHUB_OWNER`.
3. `GITHUB_REPO`.
4. `GITHUB_REF`, if the default branch is not `main`.
5. The workflow filenames in `src/index.js`.
6. The UTC cron expression.
7. The time zone and local-time admission table in `src/index.js`.

For a new project, converting `wrangler.toml` to `wrangler.jsonc` is optional
but follows Cloudflare's current recommendation.

### 5. Deploy it yourself from your Mac

From the copied Worker directory:

```bash
npx wrangler login
```

Then use the safe first-deployment sequence:

1. Temporarily remove the cron `triggers`.
2. Run `npx wrangler deploy`.
3. Run `npx wrangler secret put GITHUB_DISPATCH_TOKEN` and paste the new
   repository-specific GitHub token at the prompt.
4. Restore the cron `triggers`.
5. Run `npx wrangler deploy` again.

At this point the Worker is live without any GitHub deployment YAML.

### 6. Test before waiting for cron

First use the curl command from **Verify the GitHub token** with the new owner,
repository, workflow, and token.

Then temporarily set a Cron Trigger for five or more minutes in the future,
deploy, and watch:

1. Cloudflare **Cron Events**.
2. Cloudflare Worker logs.
3. The new repository's **Actions** tab.

Restore the production cron only after the validation-only dispatch succeeds.
Allow up to 15 minutes for each Cron Trigger change to propagate.

### 7. Add automatic deployment only if you want it

Manual Wrangler deployment is sufficient. If you want future Worker code and
cron changes to deploy when merged:

1. Copy `.github/workflows/deploy-cloudflare-scheduler.yml` into the new
   repository.
2. Change its path filters, `workingDirectory`, workflow name, concurrency
   group, and GitHub dispatch secret name.
3. Add the three Actions secrets:

   ```bash
   gh secret set CLOUDFLARE_ACCOUNT_ID
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set GITHUB_WORKFLOW_DISPATCH_TOKEN
   ```

4. Commit the Worker and deployment workflow.
5. Manually run the deployment workflow once.
6. Use its validation-only option or the direct curl test.

The Cloudflare account ID is not secret in the same way a token is, but storing
it as a GitHub Actions secret keeps the deployment workflow portable and
consistent. Never commit either token.

### 8. Retire the old GitHub cron

After several successful Cloudflare-triggered runs:

1. Remove the GitHub `schedule` block from the target workflow, or keep it only
   as a deliberately timed fallback.
2. Confirm that target-side idempotency and concurrency still protect retries.
3. Record the Worker name, local schedule, UTC trigger hours, token expiration,
   and owner in the repository's operational documentation.
4. Add a reminder to rotate the GitHub dispatch token before it expires.
