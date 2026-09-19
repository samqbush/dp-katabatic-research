---
name: dp-katabatic-archive
description: >
  Maintain the Neon katabatic wind research archive for DP Ecowitt and Holfuy stations, then
  relabel, backtest, and score the prediction rules. Use this skill for archive refreshes,
  backfills, health or freshness checks, database backups, workflow failures, and research
  summaries of rideable mornings or monthly and seasonal patterns. Trigger for requests such as
  "refresh the katabatic archive", "update the wind data", "run the daily archive", "backfill the
  meter history", "how far behind is the archive", "re-run the backtest", "re-score the rule",
  "are we losing data resolution", or catching up after travel. Use it for recent Ecowitt or
  Holfuy history needed for research, not a live go/no-go call. For "should I go to the lake this
  morning", use dp-katabatic-check instead.
---

# Katabatic Archive Refresh

This is the upkeep half of the katabatic research project. `dp-katabatic-check` answers *"do I
drive to the lake right now?"*. This skill answers *"is the dataset that validates that call
still healthy, and what does it say?"*

**The single most important thing to understand:** this archive is *perishable*. Ecowitt serves
5-minute history for only about 90 days and downsamples anything past roughly a year to 4-hour
rows, which are too coarse to detect a 30-minute sustained-wind event. Days not archived in time
are permanently degraded, and Ecowitt is the only source that ever had them.

**The Holfuy half is worse, and it sets the cadence.** The archive also carries ridge-top
stations Ecowitt cannot see — currently Lookout Mtn (Holfuy 1295, run by RMHPA), ~2,000 ft above
Soda and upstream of the drainage. Holfuy publishes a rolling **~5.9-day** window with no
backfill, and station 1295's archive API returns `{"error":"No access"}` because access is a flag
the station owner controls. A Holfuy day missed by a week is not coarsened, it is **gone**. That
is why this runs **daily**, not weekly. Daily also captures the feed's ~1-minute rows for the most
recent day or two before they thin to 15-minute; days are unioned by timestamp, so resolution
only ever improves and no already-captured minute is dropped.

Precisely: observations are **immutable**. The union inserts with `ON CONFLICT DO NOTHING`, so a
timestamp already in the database is never rewritten and a re-fetch of an unchanged day is a no-op
at the database level — no rows change, and the run reports `added 0`. Nothing is skipped ahead of
time on a "did anything change?" guess; the database decides, which is why re-running is always
safe and never costs resolution.

## Where the archive lives

**Neon Postgres, and nowhere else.** The archive used to be committed as JSON files under `data/`;
those were deleted at the cutover and are not coming back. They survive only in git history. Do
not recreate them, and do not treat any JSON on disk as the archive.

Neon needs `NEON_DATABASE_URL` in `.env`. Every run prints `store=neon host=… db=…` up front, so
which database you just wrote to is never a guess.

**A dead database is now a clean no-op, not a lost day.** Both archivers run a liveness probe
*before* the first upstream request. If Neon is unreachable, credentials are expired, or there is
no network, the run stops having fetched nothing — so nothing was lost. Fix the connection and
re-run. Do not work around the probe.

**A write failure is loud and never swallowed.** Neon is the only copy and the upstream sources
will not serve these observations again, so the write path throws rather than returning a soft
"degraded" result. The archivers retry with backoff, then spill the day to a spool.

**The spool (`.archive-spool/`) is a transient outbox, not a second archive.** It is gitignored,
written only after a Neon write has already failed its retries, and drained automatically at the
start of the next archiver run — before any new fetch, so no request is spent twice. It has no
read path and is never a source of truth.

**If a run reports pending spool entries, that is not done.** Fix whatever broke Neon and re-run
until the drain reports `0 still pending`. The deadline printed alongside them is real: a spooled
Holfuy day is unrecoverable once its ~5.9-day window closes. Treat it as the most urgent thing in
the session.

**The two archivers fail in opposite directions on purpose — do not "fix" the inconsistency.**
`archive-ecowitt.mjs` **aborts** the run on a write failure, because it fetches one day per
request inside the loop and continuing would burn more of the Ecowitt rate cap on days it already
knows it cannot store. `archive-holfuy.mjs` **keeps going** and exits non-zero at the end, because
it fetches the whole ~6-day window in a single request up front: when day 3 fails to write, days
4–6 are already in memory and have already cost the irreplaceable fetch, so aborting would throw
them away for nothing.

**Back the database up — it is the only copy.**

```bash
npm run archive:backup     # pg_dump -Fc -> ~/dp-archive-backups/
```

Restore with `pg_restore --clean --if-exists -d "$NEON_DATABASE_URL" <file>`. If the backup fails
with a server-version complaint, that is the known macOS trap — an old Homebrew `pg_dump` first on
`PATH` cannot dump a newer server. The script hunts for a matching keg itself and explains the
fix; do not skip the backup to get past it.

## Credentials — this will hard-fail without them

The archive scripts require `ECOWITT_RESEARCH_APPLICATION_KEY` and `ECOWITT_RESEARCH_API_KEY`
in `.env`, and **deliberately refuse to run on the app's `ECOWITT_*` keys.**

Ecowitt rate-limits per account, and the app keys are compiled into the shipped mobile build. A
single backfill is several hundred requests and has tripped that cap before — on the app's
account it could exhaust the shared quota and break wind data on every installed user's phone.

If the user hits that error, **do not work around it** by setting the app keys or editing the
check. Tell them to add a separate Ecowitt research token to `.env`.

Holfuy needs no credentials at all, which is why it runs first and independently.

`NEON_DATABASE_URL` is required too, and fails the same way — loudly, with no silent fallback.
Unlike the Ecowitt keys, a Neon problem stops the run *before* anything is fetched, so it costs a
delay rather than a day.

## The command

One command does everything — status, fetch, re-label, re-score, and a summary of what changed:

```bash
node scripts/katabatic-refresh.mjs
```

Read the tail of the output before declaring success. A run is only clean if it exits zero **and**
reports no pending spool entries. If it reports either a write failure or `still pending`, the
data is not archived yet — fix Neon and re-run, which replays the spool before fetching anything.

A successful fetch produces **no git diff**, because the archive is in the database. Do not go
looking for changed files to confirm it worked; read the run's own summary, and then take a
backup:

```bash
npm run archive:backup
```

Flags:
- `--check` — report archive status and fetch nothing. Use when the user only asks how far
  behind they are.
- `--days 30` — reach back further. The script already widens the window automatically to cover
  whatever gap it finds, so you rarely need this. Use it after a long trip if you want margin.

It is safe to re-run at any time. Already-archived days are skipped, so a repeat run costs
almost nothing.

To pull the ridge stations alone — useful when the user is about to lose the Holfuy window and
you do not want to wait on an Ecowitt backfill:

```bash
node scripts/archive-holfuy.mjs
```

Ecowitt archiving also records absolute and relative pressure in hPa. The one-time Soda history
enrichment is deliberately separate:

```bash
npm run backfill:pressure
```

It fills pressure only on exact timestamps already present in Neon and never replaces archived
wind. Do not substitute `archive-ecowitt.mjs --force`: old Ecowitt responses may be coarser than
the wind rows already preserved. The pressure backfill is resumable, skips completed days, and
must not run concurrently with another Ecowitt archive job because both share the research
account's request-rate budget.

## When to run it

**Daily is the target cadence**, driven by the Holfuy window rather than by Ecowitt — and the
Cloudflare-dispatched workflow now covers that baseline. So the manual run is no longer the routine path; it is
what you reach for when the schedule cannot be trusted or has not caught up yet:

- **Archive status shows real lag** — anything past a day or two means the cron is not doing its
  job. Diagnose *and* fetch; do not just report the number.
- **The user is back from travel** and wants the data caught up now rather than at 2:15 PM Denver.
- **Before any question that leans on the data** ("what's the best month", "how often does
  September work"), so the answer is not one silent cron failure out of date.
- **Anything urgent involving Holfuy**, where waiting for the next scheduled run could cross the
  ~5.9-day cliff.

Always check status before assuming the schedule worked. Re-running the same day is harmless but
pointless for Ecowitt. It is *not* pointless for Holfuy if the user has been away — run it
immediately in that case, before anything else.

## Reading the output

**Archive status** — days held and how far behind each station is. React to the lag:

| Lag | What to say |
|---|---|
| 0–7 days | Healthy. Move on. |
| 8–30 days | Fine, but mention it is drifting. |
| 31–90 days | Warn clearly. Still recoverable at full resolution, but not for long. |
| 90+ days | **Lead with this.** Data is being permanently lost to downsampling right now. |

**Scoring** — the rule's performance against the baselines. Two things to keep straight when
reporting it:

- *Missed sessions* matter far more than *false alarms*. A miss costs the user a whole morning;
  a false alarm costs a five-minute drive. Never present them as equivalent, and never lead with
  a combined "accuracy" number — it hides the failure that actually matters.
- "Beats persistence on both axes: NO" is expected and **is not a failure**. The rule is much
  better on missed sessions and slightly worse on false alarms. Say that plainly instead of
  reporting the NO as if the rule lost.

**Observed outcomes now have two independent axes.** Session quality is `sustained` (the frozen
15 mph / 30-minute label), `gust-driven/canoe` (the additive 12 mph / 30-minute tier), `flat`, or
`unknown`. Physical mechanism is exploratory `flow-class-v1`: `katabatic`,
`transition-hybrid`, `synoptic`, `absent`, or `unknown`. Never substitute one for the other, and
never report stamped `unknown` as calm or absent. The night-before model still targets only the
strict sustained label.

**What changed** — new days and new rideable mornings. "No new days" is a perfectly normal
result: the archive was already current, or it is the winter shutdown.

## Things that will bite you

**The meter is off every winter.** Roughly Jan 6 – Feb 28 the station is deliberately powered
down. Those days are recorded as `unobserved`, never as calm, and are excluded from every
statistic. If the user asks why January is nearly empty, that is why — it is not a bug and not a
gap worth chasing. **Never describe a dark day as a day with no wind.**

**Ecowitt rate-limits by request rate, and reports it inside a `200 OK` response** rather than a
normal error. A day that hits the limit is deliberately not written to the archive, so a later
run retries it. If a run reports rate limiting, just wait a minute and run it again — do not
lower `--delay`.

**Never invent data.** If a fetch fails, the day stays missing. Do not fill gaps with zeros,
averages, or estimates. The entire value of this archive is that absence is recorded honestly.

**Holfuy data is now scored, but nothing about it is validated.** `scripts/analyze-lookout.mjs`
runs automatically as part of the refresh and writes `research/lookout-log.csv`. It deliberately
**refuses to print AUC below n=30** — at single-digit n the statistic is noise, and quoting it is
how a hunch becomes a remembered finding. Get the current N by querying the database rather than
quoting a number from here; this file has been stale before:

```bash
node -e "import('./scripts/lib/db.mjs').then(async m=>{
  const r = await m.query(\"SELECT status, count(*) n, min(local_date) mn, max(local_date) mx FROM station_days WHERE station_slug='lookout-mtn' GROUP BY status\");
  console.table(r.rows); process.exit(0);})"
```

Note the schema: `station_days` keys on `station_slug`, and there is no `station_id` column to
join `stations` on.

**There is no shipped Lookout go/no-go rule, and users may believe there is.** The hypothesis is
a specific claim from a local rider — *"20+ mph sustained with 30+ gusts, after midnight, steady
out of West-ish, then it's a GO"* — recorded verbatim in §8.1. When last analysed on 2026-08-02
it had n=8: fires 5 times, right 3, **missed zero sessions** against a 29.4% base rate. That is
promising and it is **not** validation.

**Those §8.1 figures are now behind the data.** The archive holds more Lookout days than the
analysis was run on (17 days as of 2026-08-11), because the daily automation keeps collecting
while §8.1 is written by hand. Quote §8.1 *with its 2026-08-02 date attached*, or re-run the
analysis and report the fresh numbers — never present the old numbers as current, and never
silently edit §8.1 to match a new run without redoing the analysis behind it. If asked what the ridge implies, give the current §8.1 numbers with the n
attached, and do not improvise a threshold or round the sample up into a recommendation.

Three things to keep straight when discussing it:
- **Test the rule as stated.** The 20 mph *sustained* term carries the rule; gusts ≥30 alone fires
  on 7 of 8 days. A gust-only paraphrase does not work.
- **Read the `gust` field for gust claims,** not `speed`. Both exist per point and mixing them up
  understates gusts by 5–10 mph (§9.3).
- **Holfuy days are mixed-cadence** — statistics over them must be time-weighted (§9.2).

Why it is worth collecting at all is measured, not assumed: over 12 months, as overnight
(00:00–05:00) predictors of the 06:00–08:00 session, Soda's own meter scored AUC 0.729 while every
accessible remote substitute was worse (Golden ridge PWS 0.627, Hwy 93 RWIS 0.587, Rooney Rd RWIS
0.551), and combining them helped nothing. Lookout is the one candidate never tested at scale,
because it is the only true ridge-top station inside the drainage.

**Sanity-check the base rate before reporting any scoring run.** It should be ~29–30% and the
pre-gate count ~78–80. If you see ~38% and ~50, the labeller is running on the wrong timezone —
that exact bug shipped once and inflated every headline number (§9.1). The recorded figures in
§7.1 are a regression test: a result that disagrees with them is a bug until proven otherwise.
Never overwrite the documented number to make it agree with a fresh run.

**A day archived mid-morning used to be frozen half-written.** The archiver skipped anything
already on disk, so the day the job ran was stored with only midnight-to-run-time rows and never
completed. Completeness is now judged by whether `fetched_at` is later than the end of that local
day, so partial days are re-fetched once and then settle. A day being re-fetched that looks like
it was already there is this working as intended, not a bug.

**Collection is automated as of 2026-08-10. Verify before you assert either way.** One Cloudflare
Cron Trigger runs every 15 minutes and dispatches GitHub Actions only at explicit Denver-local
times:

| Workflow | Denver time | What it records |
|---|---|---|
| `.github/workflows/archive-weather-observations.yml` | 2:15 PM | What actually **happened** — the same `katabatic-refresh.mjs` this skill runs, over a 14-day window, followed by a verified database dump |
| `.github/workflows/collect-night-before-forecast.yml` | 9:00 and 9:15 PM | What the model **predicted** — the HRRR forecast for the coming morning, with an idempotent recovery attempt |
| `.github/workflows/publish-research-snapshot.yml` | After collectors; 2:45 and 9:45 PM fallbacks | The read-only rolling research Discussion |

The project accrues value only as matched forecast/outcome pairs, so both collectors matter. All
three take `workflow_dispatch`, and the archive job accepts a `days` input to widen the window
after time away. GitHub `workflow_run` is still the primary publisher trigger; its Cloudflare
times are fallbacks.

This became workable because the archive moved to Neon: a runner writes to the database and needs
to commit nothing back. Cloudflare owns the clock, but GitHub's dispatch API still requires each
workflow definition on the **default branch**.

**Automation does not mean unattended.** Check it rather than assuming, because a silently broken
cron is worse than a known-manual one — it produces confident staleness. Confirm with:

```bash
gh run list --workflow archive-weather-observations.yml --limit 5
```

Treat as suspect: any `failure`, a non-`workflow_dispatch` clock-based run, or a gap where a daily
run did not appear. Cloudflare is more reliable than GitHub's scheduler, but its deployment,
token, or dispatch can still fail. The Holfuy window is the thing that punishes you: it is ~5.9
days wide with no backfill, so roughly **five consecutive skipped runs lose ridge data
permanently.** If archive status shows Holfuy more than ~4 days behind, treat it as urgent and run
the fetch by hand before anything else the user asked for — do not wait for the next cron.

Running the command by hand is still always safe and is the right move whenever the schedule is
in doubt, since observations are immutable and re-runs are no-ops.

**A fetch produces no git diff — there is nothing to commit.** The archive is in Neon, not on the
branch. If you go looking for changed files to confirm the run worked, you will find none and
wrongly conclude it failed. Instead, read the run's own summary, and run `npm run archive:backup`:
that `pg_dump` is the only second copy of the data. Code and research changes commit to `main`;
push only when the user asks.

**Every nightly run now attaches its own backup.** The archive workflow dumps Neon after the
refresh and uploads it as a `dp-archive-dump-<run_id>` artifact, kept for 90 days (GitHub's
maximum). Grab one with:

```bash
gh run download <run-id> -n dp-archive-dump-<run-id>
pg_restore --clean --if-exists -d "$NEON_DATABASE_URL" dp-archive-*.dump
```

Two things about those artifacts:

- **They are a rolling 90-day window, not an archive.** Every dump is deleted on its 90th day, so
  corruption nobody notices for a quarter outstrips every copy. Periodic local dumps
  (`npm run archive:backup` → `~/dp-archive-backups/`) are still the long-term copy, and are not
  automated. Offer one if the newest file there is more than a week or two old:

  ```bash
  ls -lt ~/dp-archive-backups/ | head
  ```

- **The CI dump omits `stations` rows on purpose.** This repo is public, so artifact downloads are
  unauthenticated, and `stations.ecowitt_mac` comes from GitHub secrets. The dump carries the
  table's schema but none of its rows; `scripts/db/apply-schema.mjs` rebuilds them from
  `scripts/lib/stations.mjs` plus the MAC env vars. A restore from a CI artifact therefore needs
  that re-seed step, while a local `npm run archive:backup` dump is complete and does not.
  **Never drop `--exclude-table-data stations` from the workflow**, and never extend the flag to
  `observations`, `station_days`, or `hrrr_forecasts` — those are the irreplaceable part.

## Answering questions from the archive

For monthly or seasonal questions, the findings already live in
`research/katabatic-prediction.md` §4.5a and §7.1 — read them rather than recomputing. Key
results worth having in mind:

- Best months are the shoulder months: **Sep ~50%, Mar ~45%, Oct ~42%**.
- **June is the worst month in the entire archive (~3%)** — not because it is calm, but because
  sunrise beats the 6 a.m. gate and the event is dying as you arrive.
- **78 mornings blew hard entirely before the gate opened.** In November that is more than half
  of all events.

**Always attach this caveat when quoting a monthly number: every month has only ONE year of data
behind it.** The station was created 2025-06-09, so no month has been observed twice yet. The
ordering is credible because it matches the sunrise-versus-gate mechanism, but any individual
percentage could move ±10 points. Do not present these as settled climatology.

## Related

- `dp-katabatic-check` — the live morning go/no-go call.
- `research/katabatic-prediction.md` — all findings, constants, and validation rules.
- `docs/developer-setup.md` — the underlying scripts and their gotchas.
