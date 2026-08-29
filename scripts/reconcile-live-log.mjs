#!/usr/bin/env node

/**
 * Reconcile live prediction-log rows with the archive, once the morning is actually over.
 *
 * The live skill (`katabatic-check.mjs`) logs a call at 05:45 with the outcome columns
 * necessarily blank — nobody knows yet whether the morning held. This script is the other half:
 * once that day's archive exists in Neon, compute the SAME label the backtest uses
 * (`scripts/lib/label.mjs`, gate-conditioned, §4.2 null-safe) and fill it in.
 *
 * Previously the refresh claimed to do this and did not: `backtest-katabatic.mjs` only ever wrote
 * `source: 'backtest'` rows, so every `live` row's outcome columns stayed empty forever. That is
 * fixed here, as its own step, rather than folded into the backtest (which has no reason to know
 * about `live` rows at all).
 *
 * Sanity check (§6, plan item 6): for every live row this fills in, if a `backtest` row exists for
 * the same station/date, its `label` must be IDENTICAL — both are `labelDay()` on the same
 * archived day, just reached by two different code paths (the live skill's call vs. the nightly
 * backtest). A mismatch here means one of the two paths has drifted (e.g. a different threshold,
 * a stale label version) and is loud precisely because a silent mismatch is how the live log
 * quietly became unfaithful to the research the first time.
 *
 * Usage:
 *   node scripts/reconcile-live-log.mjs
 *   node scripts/reconcile-live-log.mjs --log research/prediction-log.csv
 */

import { join } from 'path';
import { REPO_ROOT } from './lib/ecowitt.mjs';
import { classifySession, DEFAULT_THRESHOLD_MPH } from './lib/label.mjs';
import { classifyFlow } from './lib/flow-class.mjs';
import { readAllRows, upsertRows } from './lib/prediction-log-store.mjs';
import { SESSION_CLASS_VERSION_V1 } from './lib/versions.mjs';
import { readDays, closePool } from './lib/archive-store.mjs';
import {
  SODA_NEIGHBOR_SLUGS,
  SODA_SLUG,
  stationBySlugOrName,
} from './lib/stations.mjs';

const DEFAULT_LOG = join(REPO_ROOT, 'research', 'prediction-log.csv');

function parseArgs(argv) {
  const args = { log: DEFAULT_LOG };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--log' && next) args.log = next;
  }
  return args;
}

async function loadStation(slug) {
  const byDate = new Map();
  for (const rec of await readDays(slug)) byDate.set(rec.date, rec);
  return byDate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rows = await readAllRows(args.log);
  if (!rows.length) {
    console.log(`No prediction log at ${args.log} yet — nothing to reconcile.`);
    return;
  }

  // Anything already labeled — true, false, or explicitly recorded as unobserved — is left alone.
  // Only a genuinely blank label means "the morning hadn't happened yet, or the archive hadn't
  // caught up, last time this ran."
  const pending = rows.filter((r) => {
    if (r.source !== 'live') return false;
    const station = stationBySlugOrName(r.station);
    const needsLabel = r.label === null || r.label === '';
    const needsFlow = station.slug === SODA_SLUG && !r.flow_class_version;
    return needsLabel || needsFlow;
  });
  if (!pending.length) {
    console.log('No pending live rows to reconcile.');
    return;
  }

  const stationRefs = [...new Set(pending.map((r) => r.station).filter(Boolean))];
  const archives = new Map();
  for (const stationRef of stationRefs) {
    const station = stationBySlugOrName(stationRef);
    archives.set(stationRef, await loadStation(station.slug));
  }
  const neighborArchives = new Map();
  for (const slug of SODA_NEIGHBOR_SLUGS) {
    neighborArchives.set(slug, await loadStation(slug));
  }

  // Independent cross-check population: every backtest label already computed for a given
  // (station, date), keyed the same way, so a mismatch is a genuine one-line lookup.
  const backtestOutcomeByKey = new Map();
  for (const r of rows) {
    if (r.source !== 'backtest') continue;
    if (r.label !== 'true' && r.label !== 'false') continue;
    backtestOutcomeByKey.set(`${r.station}|${r.date}`, {
      label: r.label === 'true',
      flowClass: r.flow_class ?? null,
    });
  }

  const updates = [];
  let stillPending = 0;
  let mismatches = 0;

  for (const row of pending) {
    const byDate = archives.get(row.station);
    const rec = byDate?.get(row.date);
    if (!rec) {
      stillPending++;
      continue;
    }

    const threshold = row.threshold_mph ? parseFloat(row.threshold_mph) : DEFAULT_THRESHOLD_MPH;
    // `classifySession` is `labelDay` plus the additive canoe tier — the primary `label` it
    // returns is bit-identical to what `labelDay` alone would give, so the backtest cross-check
    // below still compares like with like.
    const label = classifySession(rec, { threshold });
    const station = stationBySlugOrName(row.station);
    const flow = station.slug === SODA_SLUG
      ? classifyFlow(
        rec,
        SODA_NEIGHBOR_SLUGS.map((slug) => ({
          slug,
          record: neighborArchives.get(slug)?.get(row.date),
        })),
      )
      : null;

    // §4.2: still unobserved (outage, insufficient resolution) — leave blank, try again next run.
    if (label.label === null) {
      stillPending++;
      continue;
    }
    const fetchedAtTs = rec.fetched_at ? Math.floor(new Date(rec.fetched_at).getTime() / 1000) : null;
    if (
      label.sessionWindowEndTs &&
      (fetchedAtTs === null || fetchedAtTs <= label.sessionWindowEndTs)
    ) {
      stillPending++;
      continue;
    }

    const key = `${row.station}|${row.date}`;
    const backtestOutcome = backtestOutcomeByKey.get(key);
    if (backtestOutcome && backtestOutcome.label !== label.label) {
      mismatches++;
      console.error(
        `❌ LABEL MISMATCH ${key}: live-reconciled label=${label.label} but backtest label=` +
          `${backtestOutcome.label}. Same day, same station, two different answers — ` +
          `investigate before trusting either the live log or the backtest for this date.`
      );
      // Still record the outcome (it's the ground truth per THIS row's own computation), but the
      // mismatch is surfaced loudly rather than silently reconciled away.
    }
    if (
      flow &&
      backtestOutcome?.flowClass &&
      backtestOutcome.flowClass !== flow.flowClass
    ) {
      mismatches++;
      console.error(
        `❌ FLOW MISMATCH ${key}: live-reconciled flow=${flow.flowClass} but backtest flow=` +
          `${backtestOutcome.flowClass}.`
      );
    }

    updates.push({
      ...row,
      gate_open_hour: label.gateOpenHour ?? null,
      label: String(label.label),
      sustained_minutes: label.sustainedMinutes ?? null,
      pre_gate_sustained_minutes: label.preGateSustainedMinutes ?? null,
      missed_due_to_gate: label.missedDueToGate === undefined ? null : String(label.missedDueToGate),
      cycle_type: label.cycleType ?? null,
      session_class_version: SESSION_CLASS_VERSION_V1,
      session_class: label.sessionClass ?? null,
      canoe_threshold_mph: label.canoeThreshold ?? null,
      canoe_sustained_minutes: label.canoeSustainedMinutes ?? null,
      canoe_mean_gust_mph: label.canoeMeanGustMph ?? null,
      canoe_peak_gust_mph: label.canoePeakGustMph ?? null,
      canoe_pct_gust_at_least_18: label.canoePctGustAtLeast18 ?? null,
      flow_class_version: flow?.flowClassVersion ?? null,
      flow_class: flow?.flowClass ?? null,
      flow_evidence: flow
        ? JSON.stringify({ reasons: flow.reasons, ...flow.evidence })
        : null,
    });
  }

  if (updates.length) {
    const result = await upsertRows(args.log, updates);
    console.log(`Reconciled ${updates.length} live row(s) (${result.replaced} replaced in place).`);
  }
  if (stillPending) console.log(`${stillPending} live row(s) still pending — archive not caught up yet.`);
  if (mismatches) {
    console.error(`\n⚠️  ${mismatches} label mismatch(es) found — see above. Not treated as fatal, but needs investigation.`);
  } else if (updates.length) {
    console.log('All reconciled labels agree with the independently computed backtest label for the same day.');
  }
}

main()
  .catch((err) => {
    console.error(`❌ Reconciliation failed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(closePool);
