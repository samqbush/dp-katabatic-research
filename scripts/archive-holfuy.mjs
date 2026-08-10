#!/usr/bin/env node

/**
 * Holfuy archiver — archives the ridge-top stations that Ecowitt cannot see into Neon.
 *
 * WHY THIS EXISTS
 *
 * The Ecowitt meters sit at lake level. The katabatic flow that decides whether Soda fires is a
 * drainage current coming off the foothills, so the interesting sensor is the one *upstream and
 * above* the lake. Lookout Mtn (Holfuy 1295, run by RMHPA) is exactly that station, and the
 * local paragliding community already uses its overnight reading as a go/no-go signal.
 *
 * Measured 2026-07-31, on 12 months of archive, as overnight (00:00-05:00) predictors of the
 * 06:00-08:00 session at Soda — area under ROC, 0.50 being a coin flip:
 *
 *     Soda's own meter                0.729
 *     Golden ridge PWS (KCOGOLDE269)  0.627
 *     Hwy 93 @ 72 RWIS (CO109)        0.587
 *     Rooney Rd RWIS (CO008)          0.551
 *
 * Every accessible *substitute* for Lookout is worse than simply reading our own meter, and
 * combining them made it worse still. Lookout itself is the one candidate that has never been
 * tested at n > 6, because it is the only one that is genuinely ridge-top inside the drainage.
 * That is the entire reason for this script.
 *
 * THE PERISHABILITY PROBLEM — this is worse than Ecowitt's
 *
 * Holfuy's public feed exposes a rolling window of about **5.9 days** and nothing else. There is
 * no backfill, no archive endpoint we can reach, and no third-party mirror (checked: every
 * public Holfuy integration is a live display, not an archive). The `archive/` API *does* support
 * date ranges, but access is a per-station flag the owner controls and 1295 returns
 * `{"error":"No access"}`. Until RMHPA grants a password, **a day not captured within ~5 days is
 * gone permanently.** That makes the weekly cadence that is adequate for Ecowitt actively unsafe
 * here, which is why the workflow runs daily.
 *
 * Running daily buys resolution as well as safety: the feed carries ~1-minute rows for the most
 * recent day or two and thins to 15-minute rows further back. Days are merged rather than
 * overwritten, so a day first seen at 1-minute keeps its 1-minute detail forever.
 *
 * Usage:
 *   node scripts/archive-holfuy.mjs
 *   node scripts/archive-holfuy.mjs --station lookout-mtn
 *   node scripts/archive-holfuy.mjs --dry-run
 */

import { mergeDay, replaceDay, readDay, ping, closePool } from './lib/archive-store.mjs';
import { spoolWrite, spoolCount, spoolReport, spoolDrain, PERISHABLE_WINDOW_DAYS } from './lib/spool.mjs';
import { stationBySlug } from './lib/stations.mjs';

/** Attempts, and pause between them, for a Neon write that failed mid-run.
 *
 * Bounded rather than unlimited: the point is to ride out a dropped connection or a brief Neon
 * suspend, not to hang a scheduled job. Retrying is safe because mergeDay is idempotent —
 * ON CONFLICT DO NOTHING inside a transaction — so a retry after a lost acknowledgement of a
 * write that actually committed stores nothing twice.
 */
const WRITE_ATTEMPTS = 3;
const WRITE_BACKOFF_MS = 750;

/**
 * Stations worth carrying. Keep this list short and justified — every entry is a permanent
 * commitment to a daily fetch, and an unused one is just noise in the diff.
 */
const STATIONS = [
  {
    slug: 'lookout-mtn',
    holfuyId: 1295,
    name: 'Lookout Mtn - RMHPA',
    // Rocky Mountain Hang gliding & Paragliding Assoc. launch, above Golden. ~7,400 ft, roughly
    // 2,000 ft above Soda and upstream of the Bear Creek drainage.
    lat: 39.7392,
    lon: -105.2419,
    timezone: 'America/Denver',
  },
];

// Holfuy serves the raw feed in metric regardless of the display units on the website; the
// browser converts client-side (holfuy.com/js/main.js, speedToUnit). The Ecowitt archive is
// stored imperial, so convert here and keep the two archives directly comparable.
const KMH_TO_MPH = 1 / 1.609;
const cToF = (c) => (c * 9) / 5 + 32;

function parseArgs(argv) {
  const args = { station: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--station' && next) args.station = next;
    if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Date by which the ~5.9-day rolling window will have scrolled a given day out of reach. */
function deadlineFor(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return 'unknown';
  return new Date(ms + PERISHABLE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

/** UTC offset in seconds that `zone` was observing at `epochSeconds`. */
function zoneOffsetSeconds(epochSeconds, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(epochSeconds * 1000));
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

/**
 * Holfuy timestamps are station-local wall clock ("2026/07/26 04:15:00") with no offset, so they
 * must be resolved against the station's zone or every DST-season day lands an hour out. Iterate
 * because the offset depends on the very instant being solved for.
 */
function localToEpoch(stamp, zone) {
  const [datePart, timePart] = stamp.trim().split(' ');
  if (!datePart || !timePart) return null;
  const [Y, Mo, D] = datePart.split('/').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  if ([Y, Mo, D, h, mi].some(Number.isNaN)) return null;

  const asUtc = Date.UTC(Y, Mo - 1, D, h, mi, s || 0) / 1000;
  let ts = asUtc;
  for (let i = 0; i < 3; i++) ts = asUtc - zoneOffsetSeconds(ts, zone);
  return ts;
}

/** Calendar day, in the station's own timezone, that an instant belongs to. */
function localDay(epochSeconds, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${g.year}-${g.month}-${g.day}`;
}

/** Pull one `var name = [...]` array out of the feed. */
function extractArray(source, name) {
  const m = source.match(new RegExp(`var\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return null;
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

const num = (v) => {
  if (v === undefined || v === null || v === '' || v === 'null') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Fetch and parse the rolling public feed.
 *
 * Deliberately throws rather than returning an empty set on failure. A network error must never
 * be recorded as "the wind was calm" — same rule as the Ecowitt archiver (§4.2).
 */
async function fetchStation(station) {
  const url = `https://holfuy.com/dynamic/graphs/tdarr${station.holfuyId}.js`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dp-soda-research/1.0 (katabatic archive)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const body = await res.text();
  const times = extractArray(body, 'unt');
  if (!times || !times.length) throw new Error(`No timestamps in feed for station ${station.holfuyId}`);

  const speed = extractArray(body, 'gd_speed') ?? [];
  const gust = extractArray(body, 'gd_gust') ?? [];
  const dir = extractArray(body, 'gd_direction') ?? [];
  const temp = extractArray(body, 'gd_temp') ?? [];
  const rh = extractArray(body, 'gd_humidity') ?? [];
  const solar = extractArray(body, 'gd_solar') ?? [];

  const points = [];
  for (let i = 0; i < times.length; i++) {
    const ts = localToEpoch(times[i], station.timezone);
    if (ts === null) continue;
    const s = num(speed[i]);
    // A row with no wind reading is not a calm row — it is an absent row. Drop it.
    if (s === null) continue;
    const g = num(gust[i]);
    const t = num(temp[i]);
    points.push({
      ts,
      speed: Math.round(s * KMH_TO_MPH * 10) / 10,
      gust: g === null ? null : Math.round(g * KMH_TO_MPH * 10) / 10,
      dir: num(dir[i]),
      temp: t === null ? null : Math.round(cToF(t) * 10) / 10,
      rh: num(rh[i]),
      // Solar is not decoration: katabatic flow dies when the sun loads the slopes, so this is
      // the direct observable behind the sunrise-versus-gate mechanism (§4.5a).
      solar: num(solar[i]),
    });
  }
  return points;
}

/** Median sample spacing, reported the same way the Ecowitt archive reports `cycle_type`. */
function inferCycle(points) {
  if (points.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].ts - points[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median <= 90) return '1min';
  if (median <= 400) return '5min';
  if (median <= 1200) return '15min';
  return `${Math.round(median / 60)}min`;
}

/**
 * Merge new points into whatever is already archived for the day, keyed by timestamp.
 *
 * This is what makes a coarse re-read harmless. The feed thins from ~1-minute to 15-minute rows
 * as a day ages, so a day captured today at full detail would be silently degraded by a naive
 * overwrite three days later. Union-by-timestamp means resolution only ever improves.
 */
function mergePoints(existing, fresh) {
  const byTs = new Map();
  for (const p of existing) byTs.set(p.ts, p);
  for (const p of fresh) byTs.set(p.ts, p);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stations = args.station
    ? STATIONS.filter((s) => s.slug === args.station || String(s.holfuyId) === args.station)
    : STATIONS;

  if (!stations.length) {
    console.error(`❌ No Holfuy station matching "${args.station}".`);
    process.exit(1);
  }

  // Fail before fetching, not after. The archive store resolves station metadata locally and
  // throws on an unknown slug, and that throw would land *between* the successful fetch and the
  // database write — turning a one-line registry omission into a lost Holfuy day that the
  // ~5.9-day window may not give back.
  //
  // ping() belongs in the same block for the same reason, and covers the far more common
  // systemic failures: dead database, expired credential, no network. Neon is the only store,
  // so discovering any of those *after* the fetch would mean the perishable window had been
  // spent on data with nowhere to go. Probing first turns all of that into a clean no-op.
  for (const s of stations) {
    stationBySlug(s.slug);
  }
  try {
    await ping();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(
      '\n   Nothing was fetched, so NO data was lost — the Holfuy window still holds these days.\n' +
        '   Fix the database connection (NEON_DATABASE_URL, pooled host, project not suspended)\n' +
        '   and re-run well within the ~5.9-day window.'
    );
    process.exitCode = 1;
    return;
  }

  // Drain before fetching. The spool only ever holds days whose write already failed once, and a
  // spool that quietly never drains is the same data loss with better hiding — so it is drained
  // early and reported loudly whether or not this run's own writes succeed.
  const pending = await spoolCount();
  if (pending > 0) {
    const report = await spoolReport();
    console.error(report.message);
    // replaceDay is supplied as well as mergeDay: dispatch is on the mode persisted in the entry,
    // so an Ecowitt day spooled by the other archiver would be stranded here forever otherwise.
    const drain = await spoolDrain({ replace: replaceDay, merge: mergeDay });
    console.log(
      `\nSpool drain: attempted ${drain.attempted}, drained ${drain.drained.length}, ` +
        `failed ${drain.failed.length}, corrupt ${drain.corrupt.length}, remaining ${drain.remaining}`
    );
    for (const f of drain.failed) {
      console.error(
        `   still spooled: ${f.slug} ${f.date} (${f.mode}) — ${f.error}; ` +
          `re-fetchable upstream only until ~${f.deadline}`
      );
    }
    if (drain.remaining > 0) process.exitCode = 1;
  }

  let failed = 0;
  const writeFailures = [];

  for (const station of stations) {
    let points;
    try {
      points = await fetchStation(station);
    } catch (err) {
      // Loud, and non-zero exit. A silent failure here costs days that cannot be re-fetched.
      console.error(`❌ ${station.slug}: ${err.message}`);
      failed++;
      continue;
    }

    const byDay = new Map();
    for (const p of points) {
      const day = localDay(p.ts, station.timezone);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(p);
    }

    const tally = { new: 0, updated: 0, unchanged: 0 };
    const days = [...byDay.keys()].sort();

    for (const day of days) {
      const existing = await readDay(station.slug, day);
      const had = existing !== null;
      const existingPoints = existing?.points ?? [];

      // Do NOT "simplify" this to passing only the fresh points to mergeDay. inferCycle must see
      // the merged series: a 15-minute re-read of a day originally captured at 1-minute would
      // otherwise stamp cycle_type '15min' onto a day whose stored observations are 1-minute,
      // silently mislabelling the resolution the statistics depend on (research §9.2).
      const merged = mergePoints(existingPoints, byDay.get(day));

      const record = {
        station: station.name,
        holfuy_id: station.holfuyId,
        slug: station.slug,
        lat: station.lat,
        lon: station.lon,
        date: day,
        fetched_at: new Date().toISOString(),
        status: 'ok',
        cycle_type: inferCycle(merged),
        point_count: merged.length,
        points: merged,
      };

      if (args.dryRun) {
        tally[had ? 'unchanged' : 'new']++;
        continue;
      }

      // A fetch that brings no new timestamps is written anyway. The old code skipped it purely
      // to keep Neon byte-identical to the JSON file it no longer writes; the skip never
      // protected any observation, because mergePoints' fresh-wins collisions were already being
      // discarded downstream by insertObservations' ON CONFLICT DO NOTHING.
      //
      // The one real side effect: upsertDayRow now runs unconditionally, so a quiet fetch
      // rewrites fetched_at on day rows that used to be left untouched. Nothing reads Holfuy
      // fetched_at, so this is benign — but it does mean "when did this day's data last actually
      // change" is no longer recoverable from the row, so nothing should start depending on it.
      let res = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
        try {
          // mergeDay, not replaceDay: Holfuy days are unioned by timestamp so resolution only
          // ever improves as 1-minute rows thin to 15-minute ones. Existing observations are
          // immutable.
          res = await mergeDay(station.slug, record);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < WRITE_ATTEMPTS) await sleep(WRITE_BACKOFF_MS * attempt);
        }
      }

      if (lastErr) {
        // CONTINUE, deliberately the opposite of the Ecowitt archiver. Holfuy is fetched ONCE up
        // front for the whole ~6-day window, so every remaining day's points are already in
        // memory and already cost the irreplaceable fetch. Aborting on day 3 would throw days
        // 4-6 away for nothing. Spill this day to the spool, keep going, exit non-zero at the end.
        await spoolWrite(station.slug, 'merge', record);
        writeFailures.push({ day, message: lastErr.message, deadline: deadlineFor(day) });
        continue;
      }

      if (!had) tally.new++;
      else if (res.added > 0) tally.updated++;
      else tally.unchanged++;
    }

    const span = days.length ? `${days[0]} → ${days[days.length - 1]}` : 'none';
    console.log(
      `${station.slug.padEnd(16)} ${String(points.length).padStart(5)} pts  ${span}  ` +
        `new ${tally.new}  updated ${tally.updated}  unchanged ${tally.unchanged}`
    );
  }

  if (writeFailures.length) {
    console.error(
      `\n❌ ${writeFailures.length} day(s) could not be written to Neon after ${WRITE_ATTEMPTS} attempts.`
    );
    console.error(
      '   Neon is the only store, so these observations are NOT archived. Each was spilled to\n' +
        '   .archive-spool/ and will replay automatically on the next successful run.'
    );
    for (const f of writeFailures) {
      console.error(
        `   ${f.day}: ${f.message}\n` +
          `      Re-run before ~${f.deadline} — after that Holfuy's rolling window has scrolled\n` +
          `      past ${f.day} and it is gone permanently (no backfill).`
      );
    }
    process.exitCode = 1;
  }

  if (failed) {
    console.error(
      `\n❌ ${failed} station(s) failed. Nothing was written for them — days are NOT recorded as calm.\n` +
        '   Re-run soon: the public Holfuy window is only ~5.9 days and does not backfill.'
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(`❌ Holfuy archive failed: ${err.stack}`);
      process.exitCode = 1;
    })
    // katabatic-refresh.mjs spawns this and waits on it; a leaked pool would stall the refresh.
    .finally(closePool);
}

export { STATIONS, localToEpoch, mergePoints, inferCycle };
