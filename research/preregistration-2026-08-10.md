# Pre-registration — pinned-lid night-before call (single-runs HRRR)

**Written 2026-08-10, BEFORE any pinned-lid result was computed.** Nothing in this file may be
revised after the first score is printed. If a threshold here turns out to be badly chosen, that
is a finding to report, not a number to edit.

This exists because §10–§13 of `katabatic-prediction.md` already used the same ~95 positive
mornings to discover the variables, the bands, the thresholds and the rule shape. Another
free-form pass over the same outcomes would manufacture a result. The defence is to freeze
everything now.

---

## 1. The question

Can the **HRRR boundary-layer-height forecast, pinned to the 00Z run available at an 8 p.m.
decision**, support a night-before "sleep in" call?

§13.2 concluded this was untestable because `boundary_layer_height_previous_day1` is null across
the archive. That is true of Open-Meteo's **previous-runs** API. It is **not** true of the
**single-runs** API (`single-runs-api.open-meteo.com`, `run=<date>T00:00`), which returns 49
non-null hourly values per HRRR run. This is the first time the lid can be scored as a genuine
forecast rather than a near-analysis.

## 2. Data, fixed in advance

- **Station:** `dp-soda-lakes`.
- **Label:** existing auto-derived `labelDay()` at `DEFAULT_THRESHOLD_MPH`. Not modified.
- **Mornings:** every labelled day from **2026-04-02** (earliest HRRR run the single-runs archive
  serves) to the latest labelled day. Expected **n ≈ 131**, of which ≈ 39 rideable (30% base rate).
- **Forecast:** the **00Z run dated the previous calendar day** — i.e. issued ~6 p.m. MDT the
  evening before, published ~6:50 p.m., and therefore genuinely in hand at an 8 p.m. decision.
- **Exclusions:** a morning is dropped only if the label is null or the forecast returns fewer
  than 3 usable hours in the window. No outcome-dependent exclusions.

## 3. The primary rule — the published §11.4 rule, verbatim

Deliberately **not** re-tuned. Reusing the already-published thresholds means this test adds
**zero new researcher degrees of freedom**; any skill observed is not a product of fitting.

Features, identical to `DEBUG-pack-the-car.mjs`:

- Window: local hours **05, 06, 07, 08** (`timezone=America/Denver`, so DST is handled by the API).
- `wind` = arithmetic mean of `wind_speed_10m` (mph) over that window.
- `lid` = arithmetic mean of `boundary_layer_height` (m) over that window.

Rule:

```
if (wind >= 9 && lid < 250)  -> PACK
if (wind <  5 && lid >= 250) -> SLEEP IN
if (wind <  6 && lid >= 100) -> SLEEP IN
otherwise                    -> MAYBE
```

## 4. Endpoints and success criteria — numeric, fixed now

**Primary endpoint — safety.**
`sessions_lost` = P(called SLEEP IN | morning was rideable).

> **PASS iff `sessions_lost` ≤ 10%** AND the upper bound of its 95% bootstrap CI ≤ 20%.

Reference points: §13.5's fully-pinned rule lost **35%** (verdict: does not ship). §11.4's
near-analysis lost 11%.

**Co-primary endpoint — usefulness.**
`dead_suppressed` = P(called SLEEP IN | morning was not rideable).

> **PASS iff `dead_suppressed` ≥ 30%.**

A rule that never says SLEEP IN is perfectly safe and completely worthless — it buys no extra
sleep, which is the entire point of the project (§1).

**Secondary endpoint — confidence.**
`pack_precision` = P(rideable | called PACK).

> **PASS iff `pack_precision` ≥ 45%**, against a 30% base rate.

Reference: §13.5's fully-pinned PACK was **25%**, i.e. worse than random.

**Overall verdict, decided by the 2×2 and nothing else:**

| | `dead_suppressed` ≥ 30% | < 30% |
|---|---|---|
| **`sessions_lost` ≤ 10%** | **SUCCESS** | SAFE BUT USELESS |
| **> 10%** | UNSAFE | FAILS OUTRIGHT |

Per §7 rule 6, anything other than SUCCESS does not advance to the GRIB pipeline on the strength
of this result alone.

## 5. Metrics reported regardless of outcome

Counts, not just rates, for every cell. Plus Brier score and PR-AUC on the continuous lid, and
2,000-sample bootstrap 95% CIs on all three endpoints. Band tables with n < 15 may be printed for
colour but **may not be used to support a conclusion** (§13's "100% → 17%" compared bands holding
different mornings and should never have been quoted as a paired result).

## 6. Pre-specified secondary analyses

Frozen now so they cannot be presented later as if they had been planned:

1. **Gate-relative window.** Repeat with the window `[gate−1, gate+2]` (§1.1: gate 6:00 May–Sep,
   7:00 Mar/Apr/Oct). For a 6:00 gate this is identical to 05–08, so it changes only Mar/Apr/Oct.
   Reported as a *sensitivity check* on the primary, not as a competing rule.
2. **In-season only** (Mar–Oct, §4.5b).
3. **Lid alone**, ignoring the wind term, to see whether the wind term contributes anything at
   forecast lead.

## 7. Explicitly exploratory — may not feed back into the primary

800 mb rules; the §13.4 inverted cooling sign; run-to-run comparisons; any new threshold. Findings
here are hypothesis-generating only and must be labelled as such in the research doc.

## 8. Power, stated honestly before the fact

With ~39 rideable mornings, `sessions_lost` = 10% is **4 sessions**. The CI will be wide and a
"pass" will not be decisive.

**This pilot is far better powered to kill the idea than to confirm it.** If it reproduces
something like §13.5's 35% loss, that is a strong and cheap negative. If it passes, the correct
conclusion is *"worth the GRIB pipeline and a forward season"*, **not** *"the night-before call
works."*

## 9. The motivating anecdote is not evidence

The 00Z run of 2026-08-09 forecast a 35–55 m lid for the 2026-08-10 morning — the morning the user
was skunked at 5:30. That morning **generated** this hypothesis, so it cannot also test it. It is
included in the sample (excluding it would be its own bias) but is never quoted as support.
