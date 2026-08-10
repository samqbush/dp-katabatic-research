---
name: dp-katabatic-check
description: >
  Check the live DP Ecowitt wind meters (Soda Lakes, Standley West, Boulder Res) and make a
  go/no-go call on whether a katabatic (morning drainage) wind event is running and whether it
  will hold through the user's session window. Use this skill whenever the user asks about
  morning wind conditions before heading out — including "is it windy at Soda", "check the soda
  meter", "is this morning lining up", "should I go to the lake", "will it hold until 7", "is it
  katabatic this morning", "what's the wind doing", "check dawn patrol conditions", "am I going
  to get skunked", or any question about whether current or near-term wind at a Colorado DP
  station is worth driving for. Also trigger when the user mentions leaving for the lake, a dawn
  patrol session, kiting/windsurfing/foiling plans this morning, or asks whether wind will die
  before a specific time. Prefer this skill over generic weather lookups — it reads the actual
  on-site meters, not a forecast model.
---

# Katabatic Check

You are helping someone decide, in the next few minutes, whether to drive to the lake. They are
often standing in their kitchen with gear in the car. That framing drives everything below:
**be fast, commit to a call, and be honest about what the data can't tell you.** A wishy-washy
"conditions may vary" answer is worse than useless — they can read the numbers themselves.

## What a katabatic event actually is

Cold air pools on the high terrain overnight, gets dense, and drains downslope under gravity.
At Soda Lakes this arrives as a west/northwest jet, typically building after midnight, peaking
in the pre-dawn hours, and dying once the sun starts heating the slopes and destroys the
inversion that was driving it.

Two consequences matter for the call you're making:

1. **It is local.** The flow follows a specific drainage. If every station in the metro is
   blowing, that's a synoptic gradient event, not katabatic — different beast, different
   lifespan.
2. **It has a shelf life tied to sunrise.** Solar heating is what kills it. This is why "will
   it hold until 7am" is answerable at all: you're estimating how long the inversion survives.

Explaining this reasoning to the user is usually worth a sentence or two — it helps them
calibrate their own judgment on future mornings rather than depending on you.

## Step 1: Pull the data

Run the bundled script. It handles the Ecowitt API, unit correctness, station lookup, sunrise,
and neighbor cross-checks:

```bash
node .github/skills/dp-katabatic-check/scripts/katabatic-check.mjs
```

Useful flags:
- `--station "DP Standley West"` — a different meter (default is `DP Soda Lakes`)
- `--threshold 12` — the sustained speed the user actually needs (default 15)
- `--since 20:00` — pull further back, e.g. to see the full overnight build
- `--log` — append this call to `research/prediction-log.csv`. Worth doing on any morning you
  make a real call: it is what keeps the validation dataset honest. The outcome columns are left
  blank and filled in later by the `dp-katabatic-archive` refresh — never fill them yourself.
- `--note "..."` — optional free text for the one thing the meter cannot see: whether it was
  *actually* rideable (chop, ice, launch-relative direction). Use it only when the user tells
  you how it went. Never invent one.

Set `--threshold` to whatever number the user gave you. If they said "at least 15 mph", pass
`--threshold 15` so the `over-N` percentages in the output answer their actual question rather
than a generic one.

**Never fabricate readings.** If the script errors or reports no data, say so plainly and tell
the user the meter is down. A confident guess here can send someone on a wasted 45-minute drive.

## Step 2: Read the five signals

The script prints facts; you supply the judgment. Weigh these together — no single one is
decisive, and the strength of the call comes from whether they agree.

**Direction lock.** The most reliable tell. Sustained readings inside the station's ideal window
(270°–330° at Soda, perfect ~297°) with high consistency means a real drainage jet. Direction
wandering across quadrants means the flow is disorganized or already collapsing, even if the
speed number still looks fine. Treat a direction swing as an early warning that arrives before
the speed drops.

**Build shape.** A genuine event ramps over hours: a few mph late evening, steadily climbing
through the small hours. A speed spike with no build behind it is usually a passing gust front
or an outflow and won't sustain. Check the hourly trend table for the shape, and the
`Trend: BUILDING / HOLDING / DECAYING` line for where it is right now.

**Sustained level vs. the user's threshold.** Use the `Last 30 min` and `Last 60 min` rows. Pay
attention to the *range* and the `over-N` percentage, not just the average — an average of 15
that swings 8–22 is a very different session than a steady 15. If they need 15 and it's
averaging 15, say that it's marginal rather than implying comfort.

> ⚠️ **Near threshold, the mean trend is the wrong statistic — read `over-N` instead.** When the
> average sits within ~1.5 mph of the user's threshold, stop trusting the `Trend:` word and read
> the `over-N` percentage across the last few slices. The ±3.0 mph trend band is deliberately
> calibrated for events well above threshold (it exists so routine mountain-wave lulls don't
> report `DECAYING` and talk someone out of a live session). At threshold it hides the decay:
> half the distribution is sitting within a hair of the line, so a sub-band mean drop pushes a
> large share below it. At avg 25 a 1 mph drop moves nothing across the line; at avg 15 against a
> 15 mph threshold it moves a lot.
>
> A monotonic `over-N` slide is decay **regardless of what the trend word says**. Measured on
> 2026-08-01: `Trend: HOLDING (-0.6 mph)` printed while `over-15` ran 83% → 67% → 50% → 33% → 17%
> across the hour around the call. The mean barely moved; the session was over. Name it
> explicitly — *"averaging 15, but the share of readings above 15 has halved in 45 minutes; this
> is fading, not holding."*
>
> **This changes the wording, not the verdict.** Per §2 a missed session costs the whole morning
> against a five-minute look, so never use a declining `over-N` to suppress a go. Use it to
> sharpen the advice: be at the gate on the minute, expect the tail rather than the peak, and
> don't count on the back half of the window.

**Drying air.** Falling humidity overnight indicates the clear-sky radiative cooling that drives
drainage flow. Rising humidity or a cloud deck undercuts the mechanism, and an event running
without it is on borrowed time.

**Neighbor contrast.** If the target station is lit up and the others are calm, that confirms a
local drainage jet. If everything is blowing, reconsider — a synoptic event behaves differently
and often *doesn't* die at sunrise. If everything is calm including the target, there's nothing
to discuss.

> ⚠️ **Use this to characterise the event, not to talk yourself out of one.** Measured over 308
> paired Soda/Standley days (§8, station correlation): Soda-only mornings are indeed the norm —
> 77 of 89 rideable Soda mornings had Standley flat, so the local-jet reading is sound. **But
> the inference does not run backwards.** Standley *also* blowing does not argue against a
> session: Soda was rideable on 75% of those mornings (12 of 16) versus 26% when Standley was
> flat. A blowing neighbour raises the odds; it does not lower them. Let it change the expected
> *decay* (a synoptic event may not die at sunrise) — never the go/no-go.

## Step 3: Judge the session window

### First: is the park even open?

Bear Creek Lake Park gates are seasonal, and no amount of wind matters before they open.
Check this **before** analysing anything, because it can make the whole question moot:

| Months | Gate opens |
|---|---|
| May–Sep | 6:00 a.m. |
| Mar, Apr, Oct | 7:00 a.m. |
| Nov–Feb | 8:00 a.m. |

If the requested session window starts before the gate opens, say so immediately and shift
the analysis to the time they can actually be on the water. If the gate opens after the event
is likely over (see below), lead with that — it is the answer, regardless of the wind.

**If sunrise falls within ~30 min of gate-open, downgrade a marginal event.** The +57 min median
window below is measured from *sunrise*, not from arrival — so when the two nearly coincide, the
decay clock is already running when the user walks in and they get the tail of the event rather
than its peak. This is the May–Aug trap against the 6:00 gate, not just a June one: sunrise is
~5:32 in June and ~6:00 in early August, both inside the margin. A solidly-above-threshold event
survives this fine; one already sitting at threshold usually does not.

### Then: when does the wind end?

Anchor to sunrise, which the script reports. Measured across 14 rideable mornings at this
station, the sustained window **closes a median of ~57 minutes after sunrise** (25th
percentile +3 min, 75th +85 min), as solar heating erodes the nocturnal inversion.

Use sunrise+1hr as the default frame, then adjust with what the data actually shows: a
still-building event with a hard direction lock will run toward the long end; one with
direction starting to wander will not.

Note the interaction — in June sunrise is ~5:32 and the gate opens at 6:00, so the event may
be fading as they arrive. In September sunrise is ~6:43 against the same 6:00 gate, giving a
far longer window. Same gate hour, very different session.

Be explicit about which part of their window is solid and which part is speculative. "Solid
through 6:45, dicey after" is far more useful than a single yes or no, because it tells them
how to spend their time.

## Step 4: Deliver the call

Lead with the verdict. They may only read the first line.

### Know the limit of what you are doing — measured, not guessed

A backtest over 311 archived mornings (`research/katabatic-prediction.md` §7.1) measured how
often these signals miss a genuinely rideable morning, bucketed by how far ahead of gate-open
the call is made:

| Lead time from now to gate open | Missed rideable mornings |
|---|---|
| Gate already open | **0%** (n=37) |
| 0–60 min ahead | 28% (n=36) |
| 90+ min ahead | **50%** (n=18) |

**This is a strong measurement and a weak forecast.** Reading a window you can already see is
reliable; projecting 90 minutes forward is a coin flip. Let that govern how the call is worded:

- **Gate open, or under ~60 min out** → make a real call. It is well supported.
- **90+ minutes before gate open** (mostly Nov–Feb, 8:00 gate) → **do not talk them out of
  going.** Say plainly it is too early to tell, give the current readings, and recommend
  re-checking near gate-open. Half the sessions suppressed at that range are real ones, and per
  §2 a missed session costs the whole morning while a wasted look costs five minutes.

Never present a long-lead call with the same confidence as a short-lead one. Overstating
certainty here is the single most costly failure mode this skill has.

Structure that works well:

1. **Verdict up front** — go / don't go / go now and hurry / too early to tell, in plain
   language.
2. **Current numbers** — a small table of the most recent readings (time, avg, gust, direction).
   Concrete numbers let them sanity-check you.
3. **Why you think it's real (or not)** — walk the signals that support the call. This is where
   direction lock, build shape, humidity, and neighbor contrast go.
4. **The window assessment** — what happens across their specific session block, and when you
   expect it to fade.
5. **Actionable advice** — anything time-sensitive. If the back half of their window is at risk,
   tell them not to dawdle at the truck.

Keep it tight. Tables beat paragraphs for numbers. Skip preamble entirely — no "I checked the
meter and here's what I found", just lead with the answer.

## Calibration examples

Two real runs. **Read both** — they are near-identical at call time and resolve in opposite
directions, which is the point.

### Case 1 — marginal call that paid off

At 5:49am the user asked whether Soda would hold above 15 mph for a 6–7am session:

- Direction locked 262°–288° for 100+ minutes — inside the ideal window, not wandering.
- Clean build: ~3 mph at 3:50 → 10 by 4:15 → 14–16 sustained from 4:25 on.
- Humidity fell 63% → 44% overnight.
- Standley (1.8 mph) and Boulder Res (4.7 mph) were dead — clean local-jet confirmation.
- Sunrise 5:57.

The call was "go now, rig immediately, solid 6:00–6:45, don't burn 20 minutes at the truck,"
with the honest caveat that 14–16 mph sat *at* the 15 mph threshold rather than safely above it.

Outcome: the 6am hour averaged 16.0 mph, the 7am hour fell to 11.3, and by 8am it was 4.9 with
the direction swung to SSE. The window call was right and the caveat was warranted — worth
noting that hedging on a marginal threshold is not weakness, it's accuracy.

### Case 2 — the same fingerprint, and it did not pay off (2026-08-01)

Every structural signal matched Case 1, and the morning was still a bust:

- Direction locked 263°–285°, 100% consistency, 100% in-ideal — textbook.
- Clean overnight build: 13.2 at midnight → 16.8 peak at 3am.
- Both neighbours dead — Standley 1.2 mph, Boulder Res 3.7 mph. Clean local-jet confirmation.
- Humidity flat-low 53–55% all night.
- Sunrise 5:58 against the 6:00 gate.
- `Trend: HOLDING (-0.6 mph)`, 30-min avg 14.7.

The call was "go now, solid 6:00–6:45," with the at-threshold caveat. Outcome: the post-gate
hours averaged **12.8 / 13.4 / 13.7**, with only 10 sustained minutes over 15 all morning — and
every one of those minutes fell *before* the gate opened. Labeled not rideable. The user's report
back was "light session."

**What separated the two cases was visible at call time, and it was not direction, build shape,
humidity, or neighbour contrast — all four were textbook on both mornings.** It was amplitude
trajectory: the 30-min average had already slid 15.7 → 14.7 and `over-15` from 83% to 50% before
the call went out, while the trend word still read `HOLDING` because -0.6 mph sits inside the
±3.0 band. Case 1 was genuinely holding at 14–16; Case 2 was two-thirds of the way through its
decay and looked the same on every other axis.

The lesson is not "be more pessimistic." It is that on a marginal morning the `over-N` trajectory
is the only signal that discriminates, so read it deliberately rather than leaning on the four
structural signals that agree on almost every real event. The right Case 2 call was still *go* —
but worded as "the tail of a fading event, be at the gate on the minute, don't expect the back
half," not "solid 6:00–6:45."

## Notes on the data source

### Every time this prints is Colorado time, wherever you are

The script pins `America/Denver` via `scripts/lib/zone.mjs`, so `--since 03:00` means 3am at the
lake and the hourly rows are Colorado hours even when the laptop is in another timezone. The
report header says "(Colorado time)" to make that explicit — if it does not, the script is stale.

This was **not** true before 2026-08-02: run from a trip, every reported hour was shifted by the
UTC offset, silently and convincingly. The same bug in the research labeller inflated the base
rate from 29.4% to 38.7% (§9.1). Never reconcile a suspicious-looking hour by mentally
re-shifting it — run `npm run test-timezone`.


> Maintainer note (not needed to make a call): the gate-hours table, the sunrise+57min window
> close, the season note below, and the winter-shutdown dates are **mirrored from
> `research/katabatic-prediction.md`**, which owns them. Change them there too, or the two will
> drift.

### When he is actually standing there: gate−30

**He wakes 30 minutes before the park gate opens**, every riding day — 5:30 when the gate is 6:00
(May–Sep), 6:30 when it is 7:00 (Mar/Apr/Oct). He is not up at 5:30 year-round, and he is not
checking casually hours ahead.

So assume, unless told otherwise: **the gate opens in about half an hour, he is dressed, and the
gear is in the car.** That is the deadline the answer has to serve. Lead with the call.

Do not tell him a call is unreliable because it is "too far ahead" — at gate−30 it never is. The
research measures this exact lead time at ~28% missed sessions, the same in every month of his
season. If the meter is ambiguous the honest move is *"check again in 15 minutes"*, not a hedge:
on 2026-08-10 the meter was dead at 05:30 and averaging 17.4 mph by 06:00 (§10 of the research).

### The season: March–October

The rider's season is **the months the park gate opens at 6 or 7 a.m. — March through October.**
Nov–Feb is out for two independent reasons that happen to coincide: the gate does not open until
8 a.m. (by which time the event is usually over), and it is cold enough that a session stops being
fun even in a thick wetsuit — frozen hands, not wind, are the limiting factor.

Practical effect on a call: **Nov–Feb wind is real but not actionable.** The archive shows Nov at
28% and Dec at 32% rideable — genuinely windy months. Do not use that to talk someone into a
December dawn patrol. If asked about a winter morning, report the wind honestly and say plainly
that this is outside the season he rides.

Wind readings come from Ecowitt via `services/ecowittService.ts`, which the app also uses. One
sharp edge worth knowing if you ever write your own query: the Ecowitt API silently ignores
`wind_unit`, `temp_unit`, and `pressure_unit`. The real parameter names are `wind_speed_unitid`,
`temp_unitid`, and `pressure_unitid`. Passing the wrong name doesn't error — it just falls back
to defaults, which previously caused a debug script to report 33 mph when actual wind was 15.
The bundled script uses the correct names; prefer it over ad-hoc API calls.

Credentials load from the repo's `.env` (`ECOWITT_APPLICATION_KEY`, `ECOWITT_API_KEY`). If they
are missing the script exits with a clear message — relay that rather than working around it.

### Where the Soda meter physically sits

It is mounted on the **northwest point of Big Soda, between Big Soda and Little Soda**. That
placement is why the direction reading is trustworthy for this call: drainage flow arriving
from the W–NW reaches the meter before crossing the lake, so a clean 270–330° lock there
really is the canyon flow rather than a lake-surface artifact.

### The meter goes dark every winter — by design

The station runs on the **ski shop's wifi**, and the shop shuts down once Little Soda freezes.
Observed dark **2026-01-06 → 2026-02-28**, resuming 2026-03-01, and this repeats annually.

If you get no data in January or February, that is expected, not a fault. Say so plainly and
do not substitute a forecast — there is no way to know conditions remotely until it returns.
Never read missing data as calm conditions. The bundled script already detects this case and
prints the seasonal explanation.
