# Copilot instructions

## Build, test, and operational commands

- Requires Node.js 20+; GitHub Actions currently runs Node 24. Install with `npm install` locally or `npm ci` in CI.
- Run the complete validation gate with `npm run check`. It runs the seven-timezone sweep, DST archive checks, all Jest tests, and YAML lint for `.github/workflows/`.
- Run all Jest tests with `npm test`.
- Run one test file with:
  `npm test -- --runTestsByPath __tests__/utils/hrrrForecast.test.js --runInBand`
- Run one named Jest test with:
  `npm test -- --runTestsByPath __tests__/utils/katabaticBacktest.test.js -t "ignores every reading after the call time" --runInBand`
- Run timezone and DST guards separately with `npm run test-timezone:all`, `npm run test-timezone`, and `npm run test-dst`.
- There is no separate source-code linter or build step. Workflow YAML lint is included in `npm run check`.
- Database-backed commands require `NEON_DATABASE_URL`; copy `.env.example` to `.env` and configure the research Ecowitt credentials and station MAC variables as needed.
- Apply the Postgres schema and seed stations with `npm run db:schema`.
- Common data flows are `npm run archive:forecast`, `npm run refresh`, `npm run backtest`, and `npm run publish:discussion:dry-run`. These can fetch external data or write Neon; do not use them as routine unit-test substitutes.

## Architecture

- This repository is an evidence-accrual pipeline, not an application or alarm. `research/katabatic-prediction.md` records the hypotheses, preregistration, findings, and corrections. No current workflow makes an operational wake-up decision.
- Neon Postgres is the only archive source of truth. `scripts/lib/archive-store.mjs` is the data-access boundary over the schema in `scripts/db/schema.sql`; scripts should use that layer rather than issuing ad hoc archive queries.
- Neon archive rows are permanent snapshots: observations do not get downsampled or expire after they are stored. Ecowitt's rolling retention only affects history that has not yet been captured; older uncaptured requests may already return 30-minute or 240-minute buckets. A coarse Neon day was coarse when fetched, not data that later rotted in Neon. Use `fetched_at` and `cycle_type` to describe capture-time resolution accurately, and never claim the archive is currently losing detail.
- Station observations arrive through two pipelines with intentionally different persistence semantics:
  - Ecowitt archiving rebuilds a station-day and uses `replaceDay`.
  - Holfuy archiving accumulates its short rolling feed and uses `mergeDay`.
  The gitignored `.archive-spool` is only a transient failed-write outbox and is never a read backend.
- `scripts/katabatic-refresh.mjs` orchestrates the perishable-data path: drain/capture Holfuy first, capture Ecowitt, relabel/backtest, score, and run the non-decision Lookout analysis. `.github/workflows/katabatic-archive.yml` schedules this daily and creates a verified Postgres dump artifact.
- `scripts/archive-hrrr-forecast.mjs` captures the exact 00Z HRRR run for a morning. `scripts/lib/night-before-call.mjs` contains the frozen experimental rule/model, while `scripts/lib/night-before-prediction-store.mjs` materializes versioned predictions. `.github/workflows/katabatic-forecast.yml` runs the forward collector and a later recovery attempt.
- `scripts/lib/label.mjs` is the canonical definition of a rideable outcome. `scripts/lib/call-rule.mjs` is the deterministic same-morning rule used by backtests; its feature computation owns the no-lookahead barrier.
- Same-morning rules and features are versioned via `scripts/lib/versions.mjs`. V1–v4 are frozen historical/candidate results; v5 is the promoted dual-call rule. Never rewrite a version after it has been scored: add a later module and paired backtest rows. `scripts/backtest-katabatic.mjs` generates paired version rows and `scripts/score-backtest.mjs --rule-version <id>` scores one version at a time. A candidate only replaces the live rule when it clears the promotion bar documented in `research/katabatic-prediction.md` §7.1a; an inconclusive/negative result is recorded there and is not shipped.
- `scripts/lib/prediction-log-store.mjs` is the only writer for `research/prediction-log.csv`. It upserts atomically (temp-file-then-rename, lock/retry) keyed on `(source, date, call_time, station, rule_version)`, so re-running automation or scoring both rule versions never duplicates or corrupts rows. Do not append to the CSV directly.
- `scripts/lib/active-hold.mjs` is a separate, censoring-aware analysis of how long an already-running event holds past 05:45 (distinct population from the go/no-go classifier — only mornings already at/above threshold). `scripts/analyze-active-hold.mjs` regenerates `research/active-hold-calibration.json`, which the live skill script reads for checkpoint hold rates. Right-censored events (still above threshold at the end of the observation window) must never be treated as observed event ends; low-sample groups (`pickGroupOrOverall`, below `MIN_GROUP_SIZE`) fall back to the overall rate rather than shipping an unreliable small-n figure.
- The live skill script (`.github/skills/dp-katabatic-check/scripts/katabatic-check.mjs`) uses the same shared v5 feature/rule functions as the backtest, prints SESSION before KATABATIC STRUCTURE, and logs real calls by default via `prediction-log-store.mjs` (`--no-log` is diagnostic-only). Keep it wired to the shared libs rather than reimplementing feature logic inline.
- `scripts/lib/dashboard-data.mjs` joins stored forecasts, predictions, outcomes, and station health. Both `scripts/publish-discussion.mjs` and `.github/extensions/katabatic-dashboard/` are read-only presentation layers over those stored records; they must not calculate or issue new predictions.
- `.github/skills/dp-katabatic-check/` is the on-demand live-meter Copilot skill. It is separate from the night-before research collector and dashboard. `.github/skills/dp-katabatic-archive/` documents archive operations and recovery.

## Repository-specific conventions

- Treat `research/katabatic-prediction.md` as the owner of documented research thresholds and park/season facts. Gate hours, seasonal shutdown dates, and sunrise-window values are mirrored in `scripts/lib/season.mjs` and `.github/skills/dp-katabatic-check/SKILL.md`; update every mirror together.
- All weather windows and calendar dates are Colorado-local (`America/Denver`). Use helpers from `scripts/lib/zone.mjs`; do not construct station-local instants with machine-local `new Date(y, m, d, hour)`, use `date.getHours()` for station time, add fixed 24-hour day durations, or group timestamps with `ts::date`. Day bounds are half-open and DST-aware.
- Absence is unknown, never calm. Preserve `label: null` for unobserved, no-data, stale, or insufficient-resolution cases. Do not coerce missing observations to zero/false or count them as negative outcomes.
- Keep the label centralized in `labelDay`. If an outcome definition changes, add a new named/versioned label rather than silently changing historical meaning.
- Backtests must not see observations after the call time, including neighbor stations. Keep filtering inside `computeFeatures`; tests in `__tests__/utils/katabaticBacktest.test.js` are leakage guard rails.
- Preserve source-specific archive record shapes. Ecowitt-only and Holfuy-only fields are omitted, not emitted as `null`; Holfuy `solar` is similarly source-specific. Numeric and timestamp round-tripping is part of the archive contract.
- Archive writes fail loudly. Preflight Neon before spending an upstream fetch, distinguish transport failures from legitimate empty responses, and retain the existing retry/spool behavior. Do not add broad fallbacks that make a failed capture look successful.
- Raw observations are immutable on merge conflicts. Do not interchange `replaceDay` and `mergeDay`: the wrong operation either retains ghost Ecowitt points or destroys finer Holfuy resolution.
- Issued night-before predictions are immutable evidence keyed by station, local date, HRRR run, and model version. Changed model logic requires a new `modelVersion`; never rewrite an existing prediction. Preserve `forward` versus `retrospective` provenance.
- Keep forecast inputs pinned to their exact `run_init`; do not replace run-specific retrieval with a generic historical forecast that loses issuance provenance.
- The experimental night-before model is explicitly unsafe and uncalibrated. Keep warnings, rounded 5% display increments, 5-95% caps, and the held-out boundary visible in reports and dashboards.
- Tests use native ESM with no transform and the `@/` alias from `jest.config.cjs`. Production modules are `.mjs`; Jest files are `.test.js` under `__tests__/`.
- `scripts/DEBUG-*.mjs` are one-off research analyses tied to sections of the research log, not reusable production entry points. Preserve preregistered/frozen results rather than overwriting documented numbers to match a later rerun.
- Station metadata belongs in `scripts/lib/stations.mjs` and is seeded by `scripts/db/apply-schema.mjs`. Keep device MACs in environment variables; do not commit them or make station resolution depend on Neon.
