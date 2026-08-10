# dp-katabatic-research

Can you tell, the night before, whether the morning wind at **Soda Lakes, Colorado** will be worth
getting up for?

Right now the honest answer is **no.** This repo is the attempt to change that, and the record of
every attempt that has failed so far.

---

## Why this exists

Katabatic ("drainage") wind is a morning phenomenon: cold air pools overnight, slides downhill, and
blows across the lake for an hour or two after sunrise. When it happens it is excellent. When it
doesn't, you have driven to a park gate at 5:30 a.m. for nothing.

The goal is **not** to predict wind. It is narrower and much more achievable:

> Give me permission to sleep in on mornings that are certainly dead.

That asymmetry drives every decision here. Telling someone to stay in bed on a morning that turns
out good is the one unrecoverable error — it costs a session that cannot be replayed, and it
destroys trust in the tool permanently. Telling them to get up on a dead morning just costs a
snooze button.

## Status: nothing ships

**No part of this drives an alarm, a notification, or an app.** A previous year of katabatic work
was thrown away because it was confidently wrong, so the bar is now explicit: the rule must be
demonstrated on a full season of data it has never seen before it is allowed near a phone.

Until then, this repo only *accrues evidence*.

## What has actually been learned

The full record is in [`research/katabatic-prediction.md`](research/katabatic-prediction.md) —
including the parts that didn't work, which is most of them.

**The strongest real signal** is the depth of the layer of still air sitting over the valley
overnight. Thin lid, wind; thick lid, nothing. Measured after the fact it separates mornings
sharply (~67% rideable under 60 m, ~15% above 400 m).

**But that signal has not survived being turned into a night-before forecast.** Three attempts,
three negative results:

| Attempt | Result |
|---|---|
| Night-before call from the standard forecast API (§13) | Lost 35% of sessions. Does not ship. |
| Pre-registered test of the lid pinned to an exact model run (§14.2) | Lost 17.9% of sessions against a ≤10% bar. **Unsafe.** |
| "The forecast was just issued too early" (§14.3) | **Wrong.** Skill is flat from ~35 h out to ~11 h. Lead time is not the problem. |

One genuine correction came out of it: the lid *can* be retrieved pinned to a specific historical
model run (§14.1), which an earlier section had concluded was impossible. That made the test above
free to run, and it killed an expensive data-pipeline project in an afternoon.

## Method notes

A few rules, learned the hard way:

- **Pre-register.** The same ~95 good mornings have now generated every variable, band and
  threshold in this project. Another free-form pass over them *will* manufacture a result. Test
  criteria go in writing, with numbers, before anything is scored.
- **Absence of data is not absence of wind.** A failed fetch or a winter station shutdown must never
  be stored as a calm morning. Several tables and scripts here exist mainly to enforce that.
- **Small bands are not evidence.** 1 out of 6 mornings has a 95% confidence interval of roughly
  3–56%. Headline ratios built on n=6 are noise wearing a suit.
- **Timezones are a live hazard.** A local-time bug once shifted the park gate by an hour and
  inflated the base rate from 29% to 39% *without erroring*. The test suite runs under seven
  timezones for this reason.

## Layout

```
research/          the log — findings, failures, corrections, and pre-registrations
scripts/           archive jobs, backtest, and the shared libraries they share
scripts/db/        Neon Postgres schema and migrations
scripts/DEBUG-*    one-off analyses; each produced a section of the research log
__tests__/         guard rails, mostly against lookahead leakage
.github/workflows/ the two nightly jobs: forecast capture and archive refresh
```

## Running it

```bash
npm install
cp .env.example .env      # fill in Ecowitt + Neon credentials
npm run db:schema         # create tables
npm run check             # tests, DST, timezone sweep, workflow lint
```

Day to day this is now automated — two nightly jobs, both writing to Neon:

| Workflow | When | What it records |
|---|---|---|
| `katabatic-forecast.yml` | 01:30 UTC | what the model **predicted** for the coming morning |
| `katabatic-archive.yml` | 20:00 UTC | what actually **happened** |

Neither is useful alone. The project accrues value only as matched forecast/outcome pairs.

To run any of it by hand:

```bash
npm run archive:ecowitt   # pull recent station history into the archive
npm run archive:forecast  # capture the 00Z model run for tomorrow morning
npm run refresh           # the full archive ritual: fetch, re-label, re-score
npm run backtest          # re-score the rule against everything on record
```

Requires Node 20+ and a Postgres connection string (`NEON_DATABASE_URL`).

### Why the archive job is scheduled, not manual

The data is perishable. Ecowitt keeps 5-minute rows for about 90 days, then coarsens them to
4-hour rows that cannot resolve a 30-minute wind event. Worse, the Holfuy ridge-top station
publishes a rolling **~5.9-day** window with no backfill at all — a day missed by a week is not
degraded, it is gone, and no source ever had it. That window is why this runs daily.

Re-running is always safe: observations are immutable and inserted `ON CONFLICT DO NOTHING`, so
days are unioned by timestamp. Resolution only improves; nothing already captured is dropped.

## The long game

The nightly job stores one forecast/outcome pair per day. That is the only thing in this project
that cannot be bought with compute — it costs calendar time, one morning at a time. A season from
now there will be data no rule here has ever seen, and the ideas that currently look promising can
be tested honestly for the first time.

Until then: set an alarm.
