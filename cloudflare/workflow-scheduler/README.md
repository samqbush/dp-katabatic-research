# Workflow scheduler

This Cloudflare Worker owns every clock-based trigger for the repository. GitHub Actions still
runs the jobs, but its workflows expose `workflow_dispatch` rather than using GitHub `schedule`
events.

One `*/15 * * * *` Cloudflare Cron Trigger invokes the Worker. The handler converts the scheduled
timestamp to `America/Denver` and admits only these local times:

| Denver time | GitHub workflow | Purpose |
|---|---|---|
| 2:15 PM | `archive-weather-observations.yml` | Capture observations and create the verified backup artifact |
| 2:45 PM | `publish-research-snapshot.yml` | Fallback publication after the archive run |
| 9:00 PM | `collect-night-before-forecast.yml` | Capture the night-before forecast |
| 9:15 PM | `collect-night-before-forecast.yml` | Safe retry for delayed forecast ingestion |
| 9:45 PM | `publish-research-snapshot.yml` | Fallback publication after forecast collection |

The Discussion publisher also runs immediately through GitHub `workflow_run` when either producer
completes. Its Cloudflare times are fallbacks, not the primary path.

The single recurring trigger is deliberate: Workers Free allows five Cron Triggers per account,
and Denver-local admission avoids paired MDT/MST expressions. The Worker is cron-only and has no
public `workers.dev` route.

The Wrangler service name remains `dp-katabatic-forecast-dispatcher` so deployment updates the
existing Worker instead of creating a second service with the old cron still active.

The scheduler temporarily retries the legacy workflow filename when a new filename returns `404`.
This makes the production handoff safe in two phases: deploy the generalized Worker while the old
workflow files still exist, then merge the workflow renames and GitHub schedule removal. Remove
the legacy fallback only after the renamed workflows have produced successful Cloudflare-triggered
runs.

Deployment is automatic after changes under this directory reach `main`. It requires these GitHub
Actions repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `KATABATIC_GITHUB_DISPATCH_TOKEN`

The GitHub token is uploaded to the Worker as the encrypted `GITHUB_DISPATCH_TOKEN` secret. Never
put any secret value in this file or `wrangler.toml`.

To verify a new or rotated GitHub token without touching weather data, Neon backups, artifacts, or
the Discussion, manually run **Deploy Cloudflare workflow scheduler** with
**Test dispatches** enabled. It invokes every target workflow with `validate_only: true`.
