#!/usr/bin/env node

/**
 * Score the backtest against the dumb baselines (§7).
 *
 * §7 exists because the previous attempt at this project most likely failed not because its
 * predictions were wrong, but because there was no way to tell whether they were wrong. The
 * rules it lays down are followed literally here:
 *
 *   rule 2 — establish the base rate first
 *   rule 3 — beat *always yes* and *persistence*, or ship nothing
 *   rule 4 — hold out by time, never randomly (adjacent days leak)
 *   rule 5 — report missed-session rate separately from false-alarm rate; accuracy hides the
 *            failure that actually matters
 *   rule 6 — be willing to conclude it does not work
 *
 * On rule 3, one thing must be said plainly rather than buried: **"always go and look" cannot be
 * beaten on missed sessions.** It never misses one, by construction. So the rule is not competing
 * on recall — it is competing on how many pointless early alarms it removes *while* missing
 * essentially nothing. That, and only that, is the value on offer.
 *
 * Usage:
 *   node scripts/score-backtest.mjs
 *   node scripts/score-backtest.mjs --call-time 05:30
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT } from './lib/ecowitt.mjs';
import { parseCsv } from './lib/prediction-log.mjs';
import { verdictToBinary } from './lib/call-rule.mjs';

const DEFAULT_LOG = join(REPO_ROOT, 'research', 'prediction-log.csv');

function parseArgs(argv) {
  const args = { callTime: '05:30', log: DEFAULT_LOG };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--call-time' && next) args.callTime = next;
    if (argv[i] === '--log' && next) args.log = next;
  }
  return args;
}

/**
 * @param pairs Array of { predicted: boolean, actual: boolean }
 *
 * Note what is deliberately NOT the headline: accuracy. With a ~10% base rate, "no" every
 * morning scores ~90% and misses every session (§4.6). Reporting it as a top-line number would
 * be actively misleading, so it is included only for completeness.
 */
function metrics(pairs) {
  const tp = pairs.filter((p) => p.predicted && p.actual).length;
  const fp = pairs.filter((p) => p.predicted && !p.actual).length;
  const fn = pairs.filter((p) => !p.predicted && p.actual).length;
  const tn = pairs.filter((p) => !p.predicted && !p.actual).length;
  const positives = tp + fn;
  const negatives = fp + tn;

  return {
    n: pairs.length,
    positives,
    tp,
    fp,
    fn,
    tn,
    // THE metric that matters. A miss costs an entire session (§2).
    missedSessionRate: positives ? fn / positives : null,
    // The cheap error: a ~5-minute drive.
    falseAlarmRate: negatives ? fp / negatives : null,
    precision: tp + fp ? tp / (tp + fp) : null,
    accuracy: pairs.length ? (tp + tn) / pairs.length : null,
  };
}

const pct = (v) => (v === null || v === undefined ? '   n/a' : `${(v * 100).toFixed(1)}%`.padStart(6));

function printMetrics(name, m) {
  console.log(
    `${name.padEnd(26)} missed ${pct(m.missedSessionRate)}  false-alarm ${pct(m.falseAlarmRate)}  ` +
      `precision ${pct(m.precision)}  (TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn})`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let text;
  try {
    text = await readFile(args.log, 'utf8');
  } catch {
    console.error(`❌ No prediction log at ${args.log}. Run scripts/backtest-katabatic.mjs first.`);
    process.exit(1);
  }

  const rows = parseCsv(text)
    .filter((r) => r.call_time === args.callTime)
    // An empty label means unobserved. It must never be coerced to false (§4.2).
    .filter((r) => r.label === 'true' || r.label === 'false')
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!rows.length) {
    console.error(`❌ No scorable rows at call time ${args.callTime}.`);
    process.exit(1);
  }

  const days = rows.map((r) => ({
    date: r.date,
    month: r.date.slice(0, 7),
    actual: r.label === 'true',
    verdict: r.verdict,
    predicted: verdictToBinary(r.verdict),
  }));

  const baseRate = days.filter((d) => d.actual).length / days.length;

  console.log('='.repeat(94));
  console.log(`BACKTEST SCORING — call time ${args.callTime}, ${days.length} observed mornings`);
  console.log('='.repeat(94));
  console.log(`\n§7 rule 2 — base rate first: ${(baseRate * 100).toFixed(1)}% of observed mornings were rideable`);
  console.log(`   (gate-conditioned: the qualifying window must fall entirely after the park gate opens)`);

  // --- §7 rule 3: the baselines ---
  const alwaysYes = metrics(days.map((d) => ({ predicted: true, actual: d.actual })));
  const alwaysNo = metrics(days.map((d) => ({ predicted: false, actual: d.actual })));

  // Persistence: yesterday's actual outcome. Only defined where yesterday was observed and
  // genuinely the previous calendar day — a gap is not evidence about today.
  const persistencePairs = [];
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1].date);
    const cur = new Date(days[i].date);
    if ((cur - prev) / 86400000 !== 1) continue;
    persistencePairs.push({ predicted: days[i - 1].actual, actual: days[i].actual });
  }
  const persistence = metrics(persistencePairs);
  const rule = metrics(days.map((d) => ({ predicted: d.predicted, actual: d.actual })));

  console.log(`\n§7 rule 5 — missed sessions and false alarms reported separately:\n`);
  printMetrics('baseline: always go', alwaysYes);
  printMetrics('baseline: never go', alwaysNo);
  printMetrics('baseline: persistence', persistence);
  printMetrics('>> call rule v1', rule);

  // --- §7 rule 4: hold out by time. Monthly leave-one-out rather than a single split, because
  // with a few dozen positives one anomalous month in a fixed test set swings the conclusion. ---
  const months = [...new Set(days.map((d) => d.month))].sort();
  console.log(`\n§7 rule 4 — monthly leave-one-out jackknife (${months.length} months):\n`);
  const jack = [];
  for (const month of months) {
    const held = days.filter((d) => d.month === month);
    const m = metrics(held.map((d) => ({ predicted: d.predicted, actual: d.actual })));
    jack.push({ month, ...m });
    console.log(
      `  ${month}  n ${String(m.n).padStart(3)}  rideable ${String(m.positives).padStart(2)}  ` +
        `missed ${pct(m.missedSessionRate)}  false-alarm ${pct(m.falseAlarmRate)}`
    );
  }

  const withPositives = jack.filter((j) => j.positives > 0);
  if (withPositives.length) {
    const misses = withPositives.map((j) => j.missedSessionRate);
    console.log(
      `\n  Missed-session rate across months with any rideable morning: ` +
        `min ${pct(Math.min(...misses))}  max ${pct(Math.max(...misses))}  (${withPositives.length} months)`
    );
  }

  // --- §7 rule 6: state the verdict, including "it does not work" ---
  console.log(`\n${'='.repeat(94)}`);
  console.log('VERDICT');
  console.log('='.repeat(94));

  const ruleMissed = rule.missedSessionRate ?? 1;
  const ruleFalseAlarm = rule.falseAlarmRate ?? 1;
  const persistenceMissed = persistence.missedSessionRate ?? 1;

  const beatsPersistence = ruleMissed <= persistenceMissed && ruleFalseAlarm <= (persistence.falseAlarmRate ?? 1);
  const savesTrips = alwaysYes.falseAlarmRate !== null ? alwaysYes.falseAlarmRate - ruleFalseAlarm : 0;

  console.log(`Missed sessions:  ${rule.fn} of ${rule.positives} rideable mornings (${pct(ruleMissed).trim()})`);
  console.log(`False alarms:     ${rule.fp} of ${rule.fp + rule.tn} flat mornings (${pct(ruleFalseAlarm).trim()})`);
  console.log(`Wasted trips avoided vs. "always go and look": ${(savesTrips * 100).toFixed(1)} percentage points`);
  console.log(`Beats persistence on both axes: ${beatsPersistence ? 'YES' : 'NO'}`);

  if (rule.fn > 0) {
    console.log(
      `\n⚠️  The rule missed ${rule.fn} rideable morning(s). Per §2 each of those costs an entire\n` +
        `   session, against ~5 minutes for a false alarm. Weigh that far more heavily than the\n` +
        `   false-alarm column before shipping anything that suppresses a morning.`
    );
  }
  if (!beatsPersistence) {
    console.log(
      `\n⚠️  §7 rule 6: not beating the baselines is a legitimate result. Document it and ship\n` +
        `   nothing rather than shipping a number that reads as insight but is not.`
    );
  }
}

main().catch((err) => {
  console.error(`❌ Scoring failed: ${err.stack}`);
  process.exit(1);
});
