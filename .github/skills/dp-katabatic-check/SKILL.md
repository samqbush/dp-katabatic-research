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
- `--since 20:00` — pull further back, e.g. to see the full overnight build. A time later than
  the current station clock is read as **last night**, so this works before dawn. (Prior to
  2026-08-21 it silently requested a future window and the script reported the meter offline.)
- Real calls log automatically to `research/prediction-log.csv`. Distinct checks keep their
  second-resolution call time; an exact retry replaces the same row. Only the outcome columns
  (label, sustained_minutes, ...) remain blank until `scripts/reconcile-live-log.mjs` fills them
  from the archive. Never fill those yourself.
- `--no-log` — diagnostic-only run that must not be persisted.
- `--note "..."` — optional free text for the one thing the meter cannot see: whether it was
  *actually* rideable (chop, ice, launch-relative direction). Use it only when the user tells
  you how it went. Never invent one.

## Read the two versioned calls before anything else

The script prints two deliberately separate deterministic results from `call-rule-v5`:

1. `SESSION: GO / MARGINAL / NO_GO / STALE / NO_DATA` — threshold-specific and shown first.
2. `KATABATIC STRUCTURE: PRESENT / POSSIBLE / ABSENT / UNKNOWN` — the physical drainage setup.

**Never turn structure into permission to drive.** A weak real drainage pulse can be
`STRUCTURE PRESENT / SESSION NO_GO`. The session classifier reads amplitude, trajectory, meter
freshness, gate, and sunrise timing; direction, humidity, and neighbors cannot promote it.

`GO` means the requested sustained threshold is running now. `MARGINAL` means re-check before
leaving; it is not a soft GO. `NO_GO` means do not leave for the requested threshold. Add meter
color and any user-reported rideability context, but do not silently replace the versioned
session verdict.

### The third call: `CANOE CHECK` — do not skip it when SESSION is not GO

Below the structure block the script prints a **third** verdict: the same `call-rule-v5` evaluated
at the **12 mph canoe threshold** — "canoe club", i.e. downwind boards, bigger foils, bigger wings,
riding the gusts. The rider's own words: *"I am able to ride in these conditions as long as the
gusts keep coming, but I don't truly enjoy it."*

So a canoe morning is a **real but materially worse gust-driven riding outcome**. Report it as
`gust-driven/canoe`; never merge it into the primary sustained verdict, but also never flatten it
into "not rideable" or "a bust."

**`SESSION MARGINAL / CANOE GO` is the single most valuable combination the script produces, and
it is the one most easily wasted.** Measured at 05:45 over 333 archived mornings (§16.6):

| current@15 → canoe@12 | n | any rideable outcome |
|---|---:|---:|
| GO → GO | 71 | 90% |
| **MARGINAL → GO** | **33** | **76%** |
| MARGINAL → MARGINAL | 71 | 51% |
| NO_GO → NO_GO | 128 | 27% |

On those 33 mornings the 15 mph answer is "re-check at 06:00" — which for this rider means going
back to bed — while the canoe bar gives a decisive call that paid off three times in four. **If
`CANOE: GO` prints, say so in your first two lines**, along with the fact that it means big-gear
conditions rather than a proper sustained session, so he can decide with his gear in mind.

Corollary: `MARGINAL / MARGINAL` is a genuine coin flip (51%). Say that plainly. Do not dress it
up as leaning either way.

### Why `MARGINAL` alone is close to useless to this rider

§16.5: the research scores `MARGINAL` as an "opportunity-preserving re-check", which assumes he
re-checks. He does not — *"checking again at 6 only works if I'm awake and not tired, and even then
I'm going to leave at 5:55 to make the gate or go back to bed."* His decision is **binary at
05:45**. Under that model the rule misses **47 of 99 rideable mornings (47.5%)**, not the 21.2%
§7.1a reports.

Both numbers are correct about different users. Never quote the 21.2% to him as though it described
his experience.

If the event is **already running** (30-min average at/above threshold now), the script also
prints `## ACTIVE-EVENT HOLD HISTORY`: real measured hold rates at gate-open, gate+30, and
gate+60 for mornings that looked like this one, pulled from `research/active-hold-calibration.json`
(regenerated by `scripts/analyze-active-hold.mjs`). Use those numbers instead of re-deriving your
own estimate — they already account for events that died before the gate and events still running
when the archive's observation window closed (censored, not silently treated as "ended there").
If the file is missing or unreadable the script says so plainly instead of guessing; relay that
rather than inventing a probability.

Set `--threshold` to whatever number the user gave you. If they said "at least 15 mph", pass
`--threshold 15` so the `over-N` percentages in the output answer their actual question rather
than a generic one.

**Never fabricate readings.** If the script errors or reports no data, say so plainly and tell
the user the meter is down. A confident guess here can send someone on a wasted 45-minute drive.

## Step 2: Read the five signals

Use these signals to explain the structure status and session window. Do not recombine them into
a replacement session score; amplitude and access drive the versioned session verdict.

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
> `call-rule-v5` evaluates short-horizon amplitude directly. A setup that never reached the
> requested threshold and then suffers a severe collapse is `NO_GO`; plausible sub-threshold
> wind remains `MARGINAL` so late builders are not discarded.

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

> This sunrise-anchored figure is a small, old sample (14 mornings) and explains the *mechanism*
> well, but if the event is already running at call time, prefer the script's own
> `ACTIVE-EVENT HOLD HISTORY` block (76 pre-registered active mornings, gate-anchored, and
> explicit about events still running when the observation window closed rather than assuming
> they ended there — see Step 1 above). Use this paragraph for the "why", that one for the
> number.

Use sunrise+1hr as the default frame, then adjust with what the data actually shows: a
still-building event with a hard direction lock will run toward the long end; one with
direction starting to wander will not.

Note the interaction — in June sunrise is ~5:32 and the gate opens at 6:00, so the event may
be fading as they arrive. In September sunrise is ~6:43 against the same 6:00 gate, giving a
far longer window. Same gate hour, very different session.

### The post-sunrise second pulse — real, and almost never rideable

Some mornings do not end cleanly. The drainage collapses at sunrise, then a **second W/NW pulse**
rebuilds 30–60 min later and runs until the daytime upslope regime takes over, roughly two hours
past sunrise. Observed 2026-08-21: drainage peaked 16.2 at 05:30, collapsed to 2.1 by 06:20
(direction scattering across SW/SSE/S/NNW), then rebuilt to a tight 273–289° and peaked **15.9 at
07:30** before dying at 08:20 with the direction swinging ESE.

It looks convincing while it is happening — tight direction lock, steady build, falling humidity.
**Do not read it as the event restarting.** The inversion that drives drainage is gone by then;
this is the residual westerly gradient briefly reaching the surface as the boundary layer mixes,
and it is on a solar clock.

Do **not** expect the usual direction-wander early warning here. On 2026-08-21 the speed collapsed
first (12.1 → 9.2 at 08:20, still locked at 269–285°) and the swing to ESE upslope did not arrive
until 08:35, *trailing* the collapse by ~15 min. The humidity turn is the better tell: RH fell
steadily 43% → 30% through the pulse and ticked back up as it died.

Measured over 111 May–Sep mornings (5-min resolution, Soda), asking how often the gate hour busts
but 07:00–09:00 then delivers a 30-minute sustained run:

| Threshold | Mornings where the late window rescues the session |
|---|---|
| **15 mph** | **0 of 111 (0.0%)** |
| 12 mph | 2 of 112 (~1.8%, incl. 2026-08-21) |

So at a 15 mph threshold, **never advise waiting around for a strict sustained session from the
second pulse** — it has not once met that label in the archive. This does not mean useful
gust-driven riding is impossible. At 12 mph (bigger kite, foil) it is a real but
~2%-of-mornings pattern, and worth one re-check around 07:00 only if they are already at the lake.

> Exploratory, not preregistered: these windows were chosen after observing 2026-08-21, and 111
> mornings is a modest sample for a ~1% pattern. The 15 mph zero is a genuine zero in this
> archive, but treat it as "very rare", not "impossible".

Be explicit about which part of their window is solid and which part is speculative. "Solid
through 6:45, dicey after" is far more useful than a single yes or no, because it tells them
how to spend their time.

## Step 4: Deliver the call

Lead with the versioned **SESSION** verdict from the script, then report the structure status.
They may only read the first line.

### Know the limit of what you are doing — measured, not guessed, at the ACTUAL call time

Earlier versions of this doc measured "how often a call misses a rideable morning" as a single
0–60-minute-ahead aggregate. That was never the automation's real question — the automation runs
at a fixed 05:45, and how far ahead of gate-open that sits varies by season (§4.5). The current
numbers instead score the rule at exactly 05:45, split by that actual lead time
(`research/katabatic-prediction.md` §7, 325 archived mornings):

| Lead time from 05:45 to gate-open | Season | Missed rideable mornings |
|---|---|---|
| 15 min (6:00 gate, May–Sep) | in-season | **4.4%** (n=172, 45 rideable) |
| 75 min (7:00 gate, Mar/Apr/Oct) | in-season | **36.1%** (n=91, 36 rideable) |
| 135 min (8:00 gate, Nov–Feb) | out-of-season | 33.3% (n=62, 18 rideable) |

Overall at 05:45, v5's `GO + MARGINAL` opportunity layer misses 21.2% (21/99 rideable mornings).
Strict `GO` covered 52 rideable mornings with 19 false alarms (73.2% precision). `MARGINAL`
occurred 102 times and later converted to rideable on 26; it means re-check, not drive.

**This is a strong measurement and a weak forecast, and the shape is now visible instead of
assumed.** May–Sep is the easy case — 05:45 is only 15 minutes before the gate, so the call is
nearly a live read and rarely misses. Mar/Apr/Oct is the hard case — 75 minutes ahead of a 7:00
gate is a real projection, and it misses four times more often. Let that govern how the call is
worded:

- **May–Sep (6:00 gate)** → make a real call. The opportunity layer retains 96% of rideable
  mornings.
- **Mar/Apr/Oct (7:00 gate) or Nov–Feb (8:00 gate)** → **do not talk them out of going.** Say
  plainly the call is less certain at this lead time, give the current readings, and recommend
  re-checking near gate-open. A miss here costs a real session while a wasted look costs five
  minutes (§2).

Never present a long-lead call with the same confidence as a short-lead one. Overstating
certainty here is the single most costly failure mode this skill has.

Structure that works well:

1. **Session verdict up front** — GO / MARGINAL (re-check, do not leave) / NO_GO.
2. **Canoe verdict** — whenever SESSION is not GO. `CANOE: GO` is actionable and belongs high;
   say it means downwind board and bigger gear, not a proper session.
3. **Katabatic structure** — present, possible, absent, or unknown; never a substitute verdict.
4. **Current numbers** — a small table of the most recent readings (time, avg, gust, direction).
   Concrete numbers let them sanity-check you.
5. **Why you think it's real (or not)** — walk the signals that support the call. This is where
   direction lock, build shape, humidity, and neighbor contrast go.
6. **The window assessment** — what happens across their specific session block, and when you
   expect it to fade.
7. **Actionable advice** — anything time-sensitive. If the back half of their window is at risk,
   tell them not to dawdle at the truck.

Keep it tight. Tables beat paragraphs for numbers. Skip preamble entirely — no "I checked the
meter and here's what I found", just lead with the answer.

For retrospective questions, keep two axes explicit: the observed session outcome is
`sustained`, `gust-driven/canoe`, `flat`, or `unknown`; the full-morning physical mechanism is
`katabatic`, `transition-hybrid`, `synoptic`, `absent`, or `unknown`. The live
`KATABATIC STRUCTURE` line is only the structure visible at call time, not that completed-morning
mechanism classification.

## Calibration examples

Three real runs. **Read all three** — the first two are near-identical at call time and resolve in opposite
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

The lesson is not "be more pessimistic." It is that structural evidence answers a different
question from rideability. Under v5 this setup is never promoted to GO by direction, humidity,
or neighbors; it remains MARGINAL unless the amplitude state earns a threshold-specific call.

**Retrospective note (2026-08-23):** under the canoe tier this morning classifies as **canoe** —
10 sustained minutes over 15, but **55** over 12. The user's unprompted words at the time were
*"light session"*, which is the canoe class described in plain English before the class existed.
The right call here was never a flat bust: it was `SESSION NO_GO / CANOE GO`.

### Case 3 — real structure, session NO_GO (2026-08-19)

At 05:45 the direction, drying air, and quiet neighbors described a real local drainage pulse.
But no reading in the prior 30, 60, or 120 minutes reached 15 mph, and the last three readings
fell 14.9 → 14.3 → 10.9 mph. The 6am hour then averaged 6.0 mph.

The correct dual call is `SESSION NO_GO / KATABATIC STRUCTURE PRESENT`: useful physical
information without sending the rider to a sub-threshold session.

This one is genuinely `flat` on the canoe tier too — 0 sustained minutes at 12 mph. Not every
sub-threshold morning is a canoe morning, and saying so is the point of having the class.

### Case 4 — the late build nobody can call (2026-08-23)

At 05:45: 30-min avg 7.6, `over-15` 0%, but the last three readings ran 4.7 → 8.2 → **12.6** at a
tight 274–285°, with both neighbours calm. `SESSION MARGINAL / STRUCTURE PRESENT`. The rider went
back to bed. The morning then averaged **13.5 with 21.5 mph gusts** through the 6am hour — a
textbook canoe session, and the group that went out called it "canoe club".

**Do not read this as a missed call.** At 15 mph the morning never happened: the longest sustained
run at or above 15 was one 5-minute reading. And the canoe bar did not save it either — replayed
at 05:45 the canoe check *also* returns `MARGINAL`, because `avg30` was 9.8 and a 30-minute
trailing mean physically cannot resolve a build that is ten minutes old.

This is the `MARGINAL / MARGINAL` cell: **71 archived mornings, 51% delivered any session.** A coin
flip. Say exactly that. The temptation after a morning like this is to start reading late builds as
promising — resist it: `MARGINAL / BUILDING` at 15 mph converted on just **2 of 21** archived
mornings (9.5%). A late build at 05:45 is a trap at the 15 mph bar; its value is at the canoe bar,
and only once `avg30` catches up.

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

### When the automation actually runs: fixed 05:45, variable lead time

**The scheduled check runs every morning at 05:45 Colorado time** — not 30 minutes before the
gate, a fixed clock time regardless of season. Because the gate hour itself changes by season
(§4.5), that means the lead time to gate-open is NOT constant: 15 minutes in May–Sep (6:00 gate),
75 minutes in Mar/Apr/Oct (7:00 gate), 135 minutes in Nov–Feb (8:00 gate). Treat "he is dressed,
gear in the car, and the gate opens soon" as true for May–Sep, but not for the other two windows
— there he has a real wait, and the call is correspondingly less certain (see the lead-time table
in Step 4).

Do not tell him a call is unreliable just because it's before gate-open — in the 15-minute case
(most of his season) it never is. But do not paper over the other two cases either: the research
measures a **6.7% missed-session rate at 15 min lead, versus 38–42% at 75/135 min lead** — nothing
close to a flat number across the season. If the meter is ambiguous the honest move is *"check
again in 15 minutes"*, not a hedge: on 2026-08-10 the meter was dead at 05:30 and averaging
17.4 mph by 06:00 (§10 of the research).

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
