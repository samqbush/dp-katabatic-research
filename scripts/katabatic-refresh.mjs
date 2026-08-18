#!/usr/bin/env node
/**
 * Weekly katabatic archive refresh — one command for the whole ritual.
 *
 * This exists because the research archive is a *perishable* asset. Ecowitt keeps 5-minute
 * history for roughly 90 days and downsamples anything older than about a year to 4-hour rows
 * (§4.3a), which are useless for a 30-minute sustained-wind label. Every day this is not run is
 * a day closer to losing resolution that cannot be recovered from any source.
 *
 * Steps: report staleness -> archive missing days -> re-label -> re-score -> summarise what
 * changed. Safe to run as often as you like; the archiver is idempotent.
 *
 * This also runs nightly in CI (`.github/workflows/katabatic-archive.yml`). It once carried a
 * note that it *deliberately* replaced a scheduled workflow, because the research lived on an
 * unpushed branch and a job that commits and pushes would have been actively wrong. Both halves
 * of that reasoning are gone: the research has its own repository with a default branch (which
 * is what GitHub requires to fire a schedule at all), and the archive writes to Neon rather than
 * to files, so nothing needs to be committed. Running it by hand meant the Holfuy window — ~5.9
 * days, no backfill — depended on somebody remembering.
 *
 *   node scripts/katabatic-refresh.mjs
 *   node scripts/katabatic-refresh.mjs --days 30     # wider catch-up after time away
 *   node scripts/katabatic-refresh.mjs --check       # report only, fetch nothing
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { labelDay } from './lib/label.mjs';
import { readDays, listDays, listStations, storeConfigSummary, closePool } from './lib/archive-store.mjs';
import { todayAtStation } from './lib/zone.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Ecowitt serves 5-minute rows for about this long, then coarsens. Past this, a day archived
// late is permanently lower resolution than one archived on time.
const FINE_RESOLUTION_DAYS = 90;

// Holfuy's public feed is a hard rolling window with no backfill and no reachable archive
// endpoint for station 1295, so the tolerance here is days rather than months. This is what
// drives the daily cadence. See scripts/archive-holfuy.mjs.
const HOLFUY_WINDOW_DAYS = 5;

const STATIONS = ['dp-soda-lakes', 'dp-standley-west', 'dp-boulder-res'];

function parseArgs(argv) {
  const args = { days: 14, check: false };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--days' && next) args.days = parseInt(next, 10);
    if (argv[i] === '--check') args.check = true;
  }
  return args;
}

function run(script, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(__dirname, script), ...extraArgs], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      // There is no "degraded" tier any more. It existed only while every fetched day was also
      // written to disk, so a failed database write could be repaired later without going back
      // upstream. Neon is now the only store: a non-zero archiver exit means a day may not have
      // landed anywhere, and the archiver has already spooled what it could. Surface it.
      reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

/** Walk one station's archive and summarise what is there. */
async function surveyStation(slug) {
  const records = await readDays(slug);
  if (!records.length) return { slug, days: 0, latest: null, rideable: 0, usable: 0 };

  let usable = 0;
  let rideable = 0;
  let latest = null;

  for (const rec of records) {
    if (!latest || rec.date > latest) latest = rec.date;
    const l = labelDay(rec);
    if (l.label === null) continue;
    usable++;
    if (l.label) rideable++;
  }
  return { slug, days: records.length, latest, usable, rideable };
}

function daysBetween(isoDate, today) {
  const [y, m, d] = isoDate.split('-').map(Number);
  // Compare calendar days, not elapsed time — otherwise a file archived this morning reads as
  // "1 day behind" purely because the clock has moved past midnight-plus-a-bit. `today` is the
  // *station's* calendar day (see lib/zone.mjs): archived dates are Colorado days, so reading
  // "today" off a travelling laptop reports a phantom extra day of lag from any zone east of
  // Denver, which is exactly the alarm the Holfuy urgency thresholds react to.
  return Math.round((today - new Date(y, m - 1, d)) / 86400000);
}

/** Days held and latest date for a Holfuy station. Nothing labels these yet — pure collection. */
async function surveyHolfuy(slug) {
  const days = await listDays(slug);
  return { slug, days: days.length, latest: days.length ? days[days.length - 1] : null };
}

/**
 * Holfuy stations come from the station registry rather than from whatever directories happen to
 * exist, so a station that is configured but not yet archived still shows up as 0 days behind
 * instead of silently vanishing from the status report.
 */
async function holfuyStations() {
  return (await listStations('holfuy')).map((s) => s.slug);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = todayAtStation();

  console.log('='.repeat(72));
  console.log('KATABATIC ARCHIVE REFRESH');
  console.log(`store: ${storeConfigSummary()}`);
  console.log('='.repeat(72));

  const before = await Promise.all(STATIONS.map(surveyStation));
  const holfuyBefore = await Promise.all((await holfuyStations()).map(surveyHolfuy));

  console.log('\n## ARCHIVE STATUS\n');
  let worstLag = 0;
  for (const s of before) {
    if (!s.days) {
      console.log(`${s.slug.padEnd(20)} empty`);
      continue;
    }
    const lag = daysBetween(s.latest, today);
    worstLag = Math.max(worstLag, lag);
    console.log(
      `${s.slug.padEnd(20)} ${String(s.days).padStart(4)} days   latest ${s.latest} (${lag}d ago)`
    );
  }

  // The whole reason for the weekly cadence. Say it in terms of what is at stake, not as a
  // generic "data may be stale" warning.
  if (worstLag > FINE_RESOLUTION_DAYS) {
    console.log(
      `\n🚨 ${worstLag} days behind. Anything older than ~${FINE_RESOLUTION_DAYS} days is past the\n` +
        `   5-minute retention window, so those days can now only ever be archived at coarser\n` +
        `   resolution. That loss is permanent — Ecowitt is the only source.`
    );
  } else if (worstLag > 30) {
    console.log(
      `\n⚠️  ${worstLag} days behind. Still inside the ~${FINE_RESOLUTION_DAYS}-day fine-resolution\n` +
        `   window, but don't let it drift much further.`
    );
  } else if (worstLag > 0) {
    console.log(`\n✅ ${worstLag} day(s) behind — comfortably inside the fine-resolution window.`);
  }

  for (const h of holfuyBefore) {
    if (!h.days) {
      console.log(`${h.slug.padEnd(20)} empty  [holfuy]`);
      continue;
    }
    const lag = daysBetween(h.latest, today);
    console.log(
      `${h.slug.padEnd(20)} ${String(h.days).padStart(4)} days   latest ${h.latest} (${lag}d ago)  [holfuy]`
    );
    // Not a "getting stale" warning. Past the window those days are simply gone — Holfuy serves
    // a rolling ~5.9 days and offers no backfill on this station.
    if (lag > HOLFUY_WINDOW_DAYS) {
      console.log(
        `\n🚨 ${h.slug} is ${lag} days behind and Holfuy only serves ~${HOLFUY_WINDOW_DAYS + 1} days.\n` +
          `   The days in between are permanently unrecoverable. This needs a daily cadence.`
      );
    }
  }

  if (args.check) {
    console.log('\n(--check: nothing fetched.)');
    return;
  }

  // Holfuy first, and deliberately so. Its window is ~5.9 days with no backfill, while Ecowitt
  // tolerates months. If the Ecowitt credentials are missing or its API is rate limiting, that
  // must not be allowed to cost a ridge-top day that can never be recovered.
  console.log('\n## FETCHING RIDGE STATIONS (Holfuy)\n');
  try {
    await run('archive-holfuy.mjs');
  } catch (err) {
    console.log(`⚠️  Holfuy archive failed: ${err.message}`);
    console.log('   Re-run within ~5 days or those days are lost for good.');
  }

  // Reach back further than the gap so a partially-archived day gets completed rather than left
  // half-written. Re-fetching an already-complete day is free: the archiver skips it.
  const days = Math.max(args.days, worstLag + 3);
  console.log(`\n## FETCHING (last ${days} days)\n`);
  await run('archive-ecowitt.mjs', ['--days', String(days), '--delay', '1200']);

  console.log('\n## RE-LABELLING AND SCORING\n');
  await run('backtest-katabatic.mjs', ['--out', join(REPO_ROOT, 'research', 'prediction-log.csv')]);
  // 05:45 is the actual automated call time (the user's local automation runs the live skill
  // then, every riding morning) — not 06:30, which was a disconnected number nothing else in the
  // pipeline calls at.
  await run('score-backtest.mjs', ['--call-time', '05:45', '--rule-version', 'call-rule-v1']);
  await run('score-backtest.mjs', ['--call-time', '05:45', '--rule-version', 'call-rule-v2']);

  console.log('\n## RECONCILING LIVE PREDICTION LOG\n');
  try {
    await run('reconcile-live-log.mjs');
  } catch (err) {
    console.log(`⚠️  Live log reconciliation failed: ${err.message}`);
    console.log('   Archive is unaffected; outcomes will fill in on the next successful refresh.');
  }

  // Ridge-flow accumulation. This is an OPEN QUESTION (§8.1) and feeds nothing — it exists so the
  // Lookout hypothesis is settled by data rather than by how convincing it sounds. Runs quiet
  // here; use `node scripts/analyze-lookout.mjs` for the per-day detail. A failure must not break
  // the refresh, since the archive itself is the thing that matters.
  console.log('\n## RIDGE FLOW (collection only — decides nothing)\n');
  try {
    await run('analyze-lookout.mjs', ['--quiet']);
  } catch (err) {
    console.log(`⚠️  Lookout analysis failed: ${err.message}`);
    console.log('   Archive is unaffected; this step is pure analysis.');
  }

  const after = await Promise.all(STATIONS.map(surveyStation));
  const holfuyAfter = await Promise.all((await holfuyStations()).map(surveyHolfuy));

  console.log('\n' + '='.repeat(72));
  console.log('WHAT CHANGED');
  console.log('='.repeat(72));
  let anyNew = false;
  for (let i = 0; i < after.length; i++) {
    const newDays = after[i].days - before[i].days;
    const newRideable = after[i].rideable - before[i].rideable;
    if (!newDays && !newRideable) continue;
    anyNew = true;
    console.log(
      `${after[i].slug.padEnd(20)} +${newDays} day(s)` +
        (newRideable ? `, +${newRideable} rideable morning(s)` : '')
    );
  }
  if (!anyNew) {
    // Expected outcome most weeks in winter, and not a failure. §4.2: the meter is deliberately
    // switched off roughly Jan 6 - Feb 28, and those days are recorded as unobserved, never calm.
    console.log('No new days. Normal if already current, or during the winter shutdown (§4.2).');
  }

  for (const h of holfuyAfter) {
    const prev = holfuyBefore.find((p) => p.slug === h.slug);
    const newDays = h.days - (prev?.days ?? 0);
    if (newDays) console.log(`${h.slug.padEnd(20)} +${newDays} day(s)  [holfuy]`);
  }

  const soda = after[0];
  console.log(
    `\nSoda: ${soda.usable} usable mornings, ${soda.rideable} rideable ` +
      `(${soda.usable ? ((100 * soda.rideable) / soda.usable).toFixed(1) : '0'}%).`
  );
  console.log('\nArchive lives in Neon — run `npm run archive:backup` when you want a checkpoint.');
}

main()
  .catch((err) => {
    console.error(`\n❌ Refresh failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
