---
name: dp-katabatic-archive
description: >
  Refresh and maintain the local katabatic wind research archive for the DP Ecowitt stations,
  then re-score the prediction rule against it. Use this skill whenever the user wants to update,
  refresh, backfill, or check the state of the wind data archive — including "refresh the
  katabatic archive", "update the wind data", "run the daily archive", "run the weekly archive",
  "backfill the meter history", "how far behind is the archive", "re-run the backtest", "re-score
  the katabatic
  rule", "how is the wind research looking", "did we get any new rideable mornings", or any
  request to pull down recent Ecowitt history for research rather than for a go/no-go call. Also
  trigger when the user returns from travel and wants to catch the data up, asks whether they
  are losing data resolution, or asks what the archive currently says about monthly or seasonal
  wind patterns. Do NOT use this for "should I go to the lake this morning" — that is
  dp-katabatic-check.
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

## When to run it

**Daily is the target cadence**, driven by the Holfuy window rather than by Ecowitt. Also run it
whenever the user gets back from travel, or before any question that leans on the data ("what's
the best month", "how often does September work").

Re-running the same day is harmless but pointless for Ecowitt. It is *not* pointless for Holfuy
if the user has been away — run it immediately in that case, before anything else.

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
how a hunch becomes a remembered finding. Get the current N by querying the database — e.g.
`SELECT count(*) FROM station_days d JOIN stations s ON s.id = d.station_id WHERE s.slug =
'lookout-mtn'` — rather than quoting a number from here; this file has been stale before.

**There is no shipped Lookout go/no-go rule, and users may believe there is.** The hypothesis is
a specific claim from a local rider — *"20+ mph sustained with 30+ gusts, after midnight, steady
out of West-ish, then it's a GO"* — recorded verbatim in §8.1. As of 2026-08-02 it has n=8: fires
5 times, right 3, **missed zero sessions** against a 29.4% base rate. That is promising and it is
**not** validation. If asked what the ridge implies, give the current §8.1 numbers with the n
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

**This archive is maintained by hand, through this skill. There is no automation.** A scheduled
workflow was built and then deliberately removed: GitHub only fires `schedule` events on the
**default branch**, and this research lives on the `katabatic-research` branch. That made the
original branch-local cron unworkable.

**Do not repeat the stronger claim that automation is impossible — it is not.** A workflow living
on `main` can `actions/checkout` with `ref: katabatic-research` and run the same command, and the
archive now lives in Neon, so a runner would not need to commit anything back to the branch at
all. Automation was **descoped, not ruled out** — and the user keeps collection manual as a
standing preference, not because of a technical blocker. Respect that, and do not push to
automate it.

**Say this plainly if the user assumes it is running automatically.** And weigh it against the
Holfuy window above: every day nobody runs the command is a Holfuy day permanently lost. If the
archive status shows the Holfuy station more than ~4 days behind, treat that as urgent and run
the fetch before doing anything else the user asked for.

**A fetch produces no git diff — there is nothing to commit.** The archive is in Neon, not on the
branch. If you go looking for changed files to confirm the run worked, you will find none and
wrongly conclude it failed. Instead, run `npm run archive:backup` after a successful fetch: that
`pg_dump` is the only second copy of the data. Offer it as the checkpoint. Any code or research
changes still commit to `katabatic-research`; do not push or merge to `main` unless the user
explicitly asks.

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
