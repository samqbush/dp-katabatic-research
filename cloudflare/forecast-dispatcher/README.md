# Forecast dispatcher

This Cloudflare Worker dispatches the existing `katabatic-forecast.yml` workflow at 9:00 and
9:15 PM in `America/Denver`. Cloudflare schedules in UTC, so both possible UTC hours are
registered and the Worker ignores whichever hour is inactive after the daylight-saving change.
The second dispatch is a safe retry because issued predictions are immutable.

Deployment is automatic after changes under this directory reach `main`. It requires these
GitHub Actions repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `KATABATIC_GITHUB_DISPATCH_TOKEN`

The GitHub token is uploaded to the Worker as the encrypted `GITHUB_DISPATCH_TOKEN` secret. Never
put any of these values in this file or `wrangler.toml`.
