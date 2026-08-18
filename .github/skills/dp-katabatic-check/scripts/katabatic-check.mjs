#!/usr/bin/env node

/**
 * Katabatic check — pulls the overnight wind record for a DP station and prints
 * the raw signals needed to judge whether a katabatic (drainage) event is running.
 *
 * This script only reports facts. All interpretation and the go/no-go call live in
 * SKILL.md, because the judgment depends on the user's session window and threshold.
 *
 * Usage:
 *   node .github/skills/dp-katabatic-check/scripts/katabatic-check.mjs
 *   node .github/skills/dp-katabatic-check/scripts/katabatic-check.mjs --station "DP Standley West" --threshold 12
 *
 * Flags:
 *   --station <name>    Station to analyze (default "DP Soda Lakes"), case-insensitive substring match
 *   --threshold <mph>   Sustained speed the user cares about (default 15)
 *   --since <HH:MM>     Start of the overnight window to pull (default 00:00 local)
 */

import axios from 'axios';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { buildLogRow } from '../../../../scripts/lib/prediction-log.mjs';
import { upsertRow } from '../../../../scripts/lib/prediction-log-store.mjs';
import { gateOpenHour } from '../../../../scripts/lib/season.mjs';
import { computeFeatures, callRule } from '../../../../scripts/lib/call-rule.mjs';
import { computeFeaturesV2 } from '../../../../scripts/lib/call-rule-v2.mjs';
import { pickGroupOrOverall } from '../../../../scripts/lib/active-hold.mjs';
import { FEATURE_VERSION_V1, RULE_VERSION_V1 } from '../../../../scripts/lib/versions.mjs';
import {
  zonedTime,
  zonedParts,
  zonedHour,
  todayAtStation,
  fmtStationDateTime,
  fmtStationTime,
  fmtStationDateTimeHuman,
} from '../../../../scripts/lib/zone.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
config({ path: join(REPO_ROOT, '.env') });

const BASE_URL = 'https://api.ecowitt.net/api/v3';

// Morrison, CO — the drainage basin all the DP stations sit in.
const SUNRISE_COORDS = { lat: 39.6547, lng: -105.1956 };

// Ecowitt unit ids. The parameter names matter: `wind_unit` / `temp_unit` are silently
// ignored by the API, which is what caused an old 2.237x over-reporting bug in the
// debug scripts. Always use the *_unitid names.
const UNITS = {
  wind_speed_unitid: '9', // mph (6 = m/s, 7 = km/h, 8 = knots, 9 = mph)
  temp_unitid: '2', // Fahrenheit (1 = Celsius, 2 = Fahrenheit)
  pressure_unitid: '3', // hPa
};

// Soda Lakes is the only station with a configured ideal (katabatic) direction window.
// Mirrors `app/(tabs)/index.tsx`. Keep in sync if that config changes.
const IDEAL_DIRECTION = {
  'DP Soda Lakes': { min: 270, max: 330, perfect: 297 },
};

// Ecowitt's history endpoint is unreliable for short windows: a 60-minute request returns zero
// rows even when data only ~10 minutes old exists, while a wider window returns it fine. So
// neighbours are read over the same wide window as the target rather than a short trailing one.
// This bound then rejects a genuinely offline station, and sits well above the ~10 min the feed
// normally trails real time.
const NEIGHBOR_MAX_AGE_MIN = 90;

/**
 * Prefer the dedicated research token when one is configured, falling back to the app keys.
 *
 * This script is light (a handful of requests per run), so the app keys are not dangerous here
 * the way they are for the bulk archiver. But Ecowitt rate-limits per account and those keys
 * ship inside the mobile app, so there is no reason to spend that quota when a research token
 * is sitting right there.
 */
function ecowittCreds() {
  const appKey = process.env.ECOWITT_RESEARCH_APPLICATION_KEY || process.env.ECOWITT_APPLICATION_KEY;
  const apiKey = process.env.ECOWITT_RESEARCH_API_KEY || process.env.ECOWITT_API_KEY;
  return { application_key: appKey, api_key: apiKey };
}

function parseArgs(argv) {
  const args = { station: 'DP Soda Lakes', threshold: 15, since: '00:00', log: false, note: null };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--station' && next) args.station = next;
    if (argv[i] === '--threshold' && next) args.threshold = parseFloat(next);
    if (argv[i] === '--since' && next) args.since = next;
    // Appends this morning's call to research/prediction-log.csv in exactly the shape the
    // backtest writes, so live calls and replayed ones stay directly comparable. The outcome
    // columns are left blank on purpose — the weekly refresh fills them from the meter later.
    if (argv[i] === '--log') args.log = true;
    // The one thing the meter genuinely cannot see: whether it was actually rideable (chop,
    // ice, launch-relative direction). Always optional; nothing in the pipeline blocks on it.
    if (argv[i] === '--note' && next) args.note = next;
  }
  return args;
}

// Ecowitt wants STATION wall-clock time, and every hour printed below is a Colorado hour.
// Both must be pinned to the station zone, not the laptop's — see scripts/lib/zone.mjs and
// research/katabatic-prediction.md §9.1. Running this from another timezone used to shift every
// reported hour, the ideal-direction test and the logged call time.
const fmtEcowittDate = (d) => fmtStationDateTime(d);
const fmtTime = (d) => fmtStationTime(d);

/* ---------- circular (compass) statistics ---------- */

function circularMean(degrees) {
  if (!degrees.length) return null;
  let x = 0;
  let y = 0;
  for (const deg of degrees) {
    const r = (deg * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  return ((Math.atan2(y / degrees.length, x / degrees.length) * 180) / Math.PI + 360) % 360;
}

function angularDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function inRange(deg, min, max) {
  return min <= max ? deg >= min && deg <= max : deg >= min || deg <= max;
}

function compassLabel(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(deg / 22.5) % 16];
}

const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);

/* ---------- data fetching ---------- */

async function getDevices() {
  const res = await axios.get(`${BASE_URL}/device/list`, {
    params: {
      ...ecowittCreds(),
    },
    timeout: 15000,
  });
  if (res.data.code !== 0) throw new Error(`Ecowitt device list error: ${res.data.msg}`);
  return res.data.data?.list || [];
}

async function getHistory(mac, start, end) {
  const res = await axios.get(`${BASE_URL}/device/history`, {
    params: {
      ...ecowittCreds(),
      mac,
      start_date: fmtEcowittDate(start),
      end_date: fmtEcowittDate(end),
      cycle_type: '5min',
      call_back: 'wind,outdoor',
      ...UNITS,
    },
    timeout: 20000,
  });
  if (res.data.code !== 0) throw new Error(`Ecowitt history error: ${res.data.msg}`);

  const d = res.data.data || {};
  const speed = d.wind?.wind_speed?.list || {};
  const gust = d.wind?.wind_gust?.list || {};
  const dir = d.wind?.wind_direction?.list || {};
  const temp = d.outdoor?.temperature?.list || {};
  const rh = d.outdoor?.humidity?.list || {};

  return Object.keys(speed)
    .map((ts) => ({
      ts: parseInt(ts, 10),
      date: new Date(parseInt(ts, 10) * 1000),
      speed: parseFloat(speed[ts]),
      gust: parseFloat(gust[ts] ?? speed[ts]),
      dir: parseFloat(dir[ts]),
      temp: temp[ts] !== undefined ? parseFloat(temp[ts]) : null,
      rh: rh[ts] !== undefined ? parseFloat(rh[ts]) : null,
    }))
    .filter((p) => Number.isFinite(p.speed))
    .sort((a, b) => a.ts - b.ts);
}

async function getSunrise() {
  try {
    const res = await axios.get('https://api.sunrise-sunset.org/json', {
      params: { lat: SUNRISE_COORDS.lat, lng: SUNRISE_COORDS.lng, formatted: 0 },
      timeout: 8000,
    });
    return res.data?.status === 'OK' ? new Date(res.data.results.sunrise) : null;
  } catch {
    return null; // Non-fatal: sunrise is context, not a gate.
  }
}

/* ---------- reporting ---------- */

function hourlyRollup(points) {
  const buckets = new Map();
  for (const p of points) {
    const h = zonedHour(p.date);
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h).push(p);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, pts]) => ({
      hour,
      avg: mean(pts.map((p) => p.speed)),
      peakGust: Math.max(...pts.map((p) => p.gust)),
      dir: circularMean(pts.map((p) => p.dir)),
      rh: mean(pts.map((p) => p.rh).filter(Number.isFinite)),
      temp: mean(pts.map((p) => p.temp).filter(Number.isFinite)),
    }));
}

function windowStats(points, threshold, ideal) {
  if (!points.length) return null;
  const speeds = points.map((p) => p.speed);
  const dirs = points.map((p) => p.dir).filter(Number.isFinite);
  const meanDir = circularMean(dirs);
  return {
    n: points.length,
    avg: mean(speeds),
    min: Math.min(...speeds),
    max: Math.max(...speeds),
    peakGust: Math.max(...points.map((p) => p.gust)),
    meanDir,
    // Consistency = share of readings pointing within 45° of the mean. A real drainage
    // jet holds a tight bearing; a swinging direction means the flow is falling apart.
    consistency: dirs.length ? (dirs.filter((d) => angularDiff(d, meanDir) <= 45).length / dirs.length) * 100 : null,
    inIdealPct: ideal && dirs.length ? (dirs.filter((d) => inRange(d, ideal.min, ideal.max)).length / dirs.length) * 100 : null,
    pctOverThreshold: (speeds.filter((s) => s >= threshold).length / speeds.length) * 100,
  };
}

function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(0)}%`;
}
function mph(v) {
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(1)}`;
}
function dirStr(v) {
  return v === null || v === undefined ? 'n/a' : `${v.toFixed(0)}° ${compassLabel(v)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const { application_key: ak, api_key: pk } = ecowittCreds();
  if (!ak || !pk) {
    console.error('❌ Missing Ecowitt credentials (ECOWITT_RESEARCH_* or ECOWITT_*).');
    console.error(`   Expected them in ${join(REPO_ROOT, '.env')} (see .env.example).`);
    process.exit(1);
  }

  const now = new Date();
  const [sinceH, sinceM] = args.since.split(':').map(Number);
  // `--since 03:00` means 3am in Colorado, on Colorado's current day, wherever the laptop is.
  const stationNow = zonedParts(now);
  const start = zonedTime(stationNow.year, stationNow.month, stationNow.day, sinceH || 0, sinceM || 0, 0);

  const devices = await getDevices();
  const dpDevices = devices.filter((d) => /^DP /i.test(d.name));
  const target = devices.find((d) => d.name.toLowerCase().includes(args.station.toLowerCase()));

  if (!target) {
    console.error(`❌ No station matching "${args.station}". Available: ${devices.map((d) => d.name).join(', ')}`);
    process.exit(1);
  }

  const ideal = IDEAL_DIRECTION[target.name];
  const points = await getHistory(target.mac, start, now);

  console.log('='.repeat(72));
  console.log(`KATABATIC CHECK — ${target.name}`);
  console.log(`Report generated ${fmtStationDateTimeHuman(now)} (Colorado time)`);
  console.log('='.repeat(72));

  if (!points.length) {
    // The Soda meter runs on the ski shop's wifi, which is switched off for the winter
    // once Little Soda freezes. Observed dark 2026-01-06 through 2026-02-28. This is
    // expected and recurring, so it should not be reported as a fault — and it coincides
    // with the months the park gate (8am) opens after the event is over anyway.
    const m = todayAtStation().getMonth(); // 0 = Jan, at the station
    if (target.name.includes('Soda') && (m === 0 || m === 1)) {
      console.log(
        '\n❄️  NO DATA — this is the expected winter shutdown, not a fault.\n' +
          '   The Soda meter runs on the ski shop wifi, which goes off once Little Soda\n' +
          '   freezes (observed dark Jan 6 – Feb 28). There is no way to check conditions\n' +
          '   remotely until it comes back, typically around the start of March.\n' +
          '   Note the park gate is 8:00am in Nov–Feb, by which point a katabatic event is\n' +
          '   normally over, so these mornings are usually not sessionable regardless.'
      );
    } else {
      console.log('\n❌ NO DATA returned for today. Station is likely offline — do not guess at conditions.');
    }
    process.exit(0);
  }

  /* --- freshness: stale data is the single most dangerous failure mode --- */
  const latest = points[points.length - 1];
  const ageMin = Math.round((now - latest.date) / 60000);
  console.log(`\n## DATA FRESHNESS`);
  console.log(`Latest reading: ${fmtTime(latest.date)} (${ageMin} min ago) — ${points.length} points since ${fmtTime(start)}`);
  if (ageMin > 30) console.log(`⚠️  STALE (${ageMin} min old). Treat every number below as unreliable and say so.`);

  /* --- sunrise: katabatic flow decays once the slopes start heating --- */
  const sunrise = await getSunrise();
  if (sunrise) {
    const rel = Math.round((now - sunrise) / 60000);
    console.log(`Sunrise: ${fmtTime(sunrise)} (${rel >= 0 ? `${rel} min ago` : `in ${-rel} min`})`);
  }

  /* --- overnight shape: a real event builds, it doesn't just appear --- */
  console.log(`\n## HOURLY TREND (avg mph / peak gust / mean dir)`);
  for (const h of hourlyRollup(points)) {
    const label = `${String(h.hour).padStart(2, '0')}:00`;
    console.log(
      `${label}  avg ${mph(h.avg).padStart(5)}  gust ${mph(h.peakGust).padStart(5)}  ${dirStr(h.dir).padEnd(10)}` +
        `  ${h.temp !== null ? `${h.temp.toFixed(0)}°F` : ''}  ${h.rh !== null ? `RH ${h.rh.toFixed(0)}%` : ''}`
    );
  }

  /* --- recent detail: what it is doing right now --- */
  console.log(`\n## LAST 12 READINGS (5-min)`);
  for (const p of points.slice(-12)) {
    console.log(
      `${fmtTime(p.date).padStart(8)}  spd ${mph(p.speed).padStart(5)}  gust ${mph(p.gust).padStart(5)}  ${dirStr(p.dir).padEnd(10)}` +
        `  ${p.rh !== null ? `RH ${p.rh.toFixed(0)}%` : ''}`
    );
  }

  /* --- windowed stats: last 30 and 60 minutes are what the session actually rides --- */
  console.log(`\n## SIGNAL SUMMARY (threshold ${args.threshold} mph)`);
  let stats30 = null;
  let stats60 = null;
  if (ideal) console.log(`Ideal katabatic direction for ${target.name}: ${ideal.min}°–${ideal.max}° (perfect ${ideal.perfect}°)`);
  for (const mins of [30, 60, 120]) {
    const cutoff = now.getTime() - mins * 60000;
    const s = windowStats(points.filter((p) => p.date.getTime() >= cutoff), args.threshold, ideal);
    if (!s) continue;
    if (mins === 30) stats30 = s;
    if (mins === 60) stats60 = s;
    console.log(
      `Last ${String(mins).padStart(3)} min: avg ${mph(s.avg)} (${mph(s.min)}–${mph(s.max)})  peak gust ${mph(s.peakGust)}  ` +
        `dir ${dirStr(s.meanDir)}  consistency ${pct(s.consistency)}  ` +
        `${ideal ? `in-ideal ${pct(s.inIdealPct)}  ` : ''}over-${args.threshold} ${pct(s.pctOverThreshold)}`
    );
  }

  /* --- build pattern: is it still ramping, holding, or already decaying? --- */
  let trendWord = null;
  let trendDelta = null;
  const last30 = mean(points.filter((p) => now - p.date <= 30 * 60000).map((p) => p.speed));
  const prev30 = mean(points.filter((p) => now - p.date > 30 * 60000 && now - p.date <= 60 * 60000).map((p) => p.speed));
  if (last30 !== null && prev30 !== null) {
    const delta = last30 - prev30;
    // Katabatic flow is modulated by mountain waves on ~1-hour timescales, so a 30-min
    // dip is normal breathing rather than the event ending. Measured at this station,
    // the median peak-to-lull spread inside a single hour is 5.6 mph. A tighter band
    // (the original was +/-1.5) reports DECAYING during routine lulls, which is the
    // costly error here: it talks the user out of a session that is still running.
    const BAND = 3.0;
    const word = delta > BAND ? 'BUILDING' : delta < -BAND ? 'DECAYING' : 'HOLDING';
    trendWord = word;
    trendDelta = delta;
    console.log(`Trend: ${word} (last 30 min ${mph(last30)} vs prior 30 min ${mph(prev30)}, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} mph)`);
    if (word === 'HOLDING' && Math.abs(delta) > 1.5) {
      console.log(`       note: ${delta.toFixed(1)} mph swing is within normal mountain-wave modulation, not a trend`);
    }
  }

  /* --- humidity: radiative cooling drives the flow; drying air confirms it --- */
  let rhDelta = null;
  const rhPts = points.filter((p) => Number.isFinite(p.rh));
  if (rhPts.length > 1) {
    console.log(`Humidity: ${rhPts[0].rh.toFixed(0)}% at ${fmtTime(rhPts[0].date)} → ${rhPts[rhPts.length - 1].rh.toFixed(0)}% now`);
    rhDelta = rhPts[rhPts.length - 1].rh - rhPts[0].rh;
  }

  /* --- neighbors: a local drainage jet should NOT show up basin-wide --- */
  console.log(`\n## NEIGHBOR STATIONS (cross-check — drainage flow is local)`);
  const neighborSeries = [];
  for (const dev of dpDevices) {
    if (dev.mac === target.mac) continue;
    try {
      // Same window as the target station. Ecowitt's history endpoint returns zero rows for a
      // short trailing window (a 60-minute request comes back empty even when data ~10 minutes
      // old exists), which silently reported every neighbour as "no recent data" and left
      // neighborMax null. A wide window returns the same recent rows reliably.
      const np = await getHistory(dev.mac, start, now);
      neighborSeries.push(np.map((p) => ({ ts: p.ts, speed: p.speed, dir: p.dir, gust: p.gust })));
      const n = np[np.length - 1];
      if (!n) {
        console.log(`${dev.name.padEnd(20)} no recent data`);
        continue;
      }
      // The reading is only a usable cross-check if it is roughly contemporaneous with the
      // target's latest reading; a hours-old point says nothing about what is happening now.
      const ageMin = (now.getTime() - n.date.getTime()) / 60000;
      const stale = ageMin > NEIGHBOR_MAX_AGE_MIN;
      console.log(
        `${dev.name.padEnd(20)} ${fmtTime(n.date)}  spd ${mph(n.speed)}  gust ${mph(n.gust)}  ${dirStr(n.dir)}` +
          (stale ? `  (stale — ${Math.round(ageMin)} min old, not used as a cross-check)` : '')
      );
    } catch (err) {
      console.log(`${dev.name.padEnd(20)} error: ${err.message}`);
    }
  }

  /* --- versioned deterministic verdict: shared computeFeatures/callRule (call-rule.mjs), the
   * SAME code the backtest replays across ~330 archived mornings. This is the promoted baseline
   * — call-rule-v1 — not an ad-hoc re-implementation. A v2 candidate (corrected neighbour signal,
   * §8; trajectory feature) exists in call-rule-v2.mjs but did NOT clear the plan's promotion bar
   * in the real backtest (0 misses recovered, false-alarm rate unchanged within noise — see
   * research/katabatic-prediction.md), so v1 remains what actually drives the score below. v2's
   * trajectory feature IS shown, descriptively, because per the plan it was never gated on
   * promotion — it changes wording, never the verdict, in either version. */
  const callTimeTs = Math.floor(now.getTime() / 1000);
  const sunriseTs = sunrise ? Math.floor(sunrise.getTime() / 1000) : null;
  const featureOpts = { station: target.name, threshold: args.threshold, sunriseTs, neighborSeries };
  const features = computeFeatures(points, callTimeTs, featureOpts);
  const call = callRule(features, { threshold: args.threshold });
  const featuresV2 = computeFeaturesV2(points, callTimeTs, featureOpts); // descriptive trajectory only

  console.log(`\n## VERSIONED VERDICT (${RULE_VERSION_V1}, deterministic — treat as the baseline)`);
  console.log(`${call.verdict}${call.score !== null ? `  (score ${call.score})` : ''}`);
  for (const reason of call.reasons) console.log(`  - ${reason}`);
  if (featuresV2?.pctOverThresholdTrendDelta !== null && featuresV2?.pctOverThresholdTrendDelta <= -20) {
    console.log(
      `  ⚠️  over-${args.threshold} share fell ${Math.abs(featuresV2.pctOverThresholdTrendDelta).toFixed(0)}pp over the last hour ` +
        `(slices: ${featuresV2.pctOverThresholdSlices.map((s) => (s === null ? 'n/a' : `${s.toFixed(0)}%`)).join(' → ')}) ` +
        `— this is fading regardless of what the mean Trend word says. Sharpen the advice; do not suppress a go.`
    );
  }

  /* --- if an event is already running, show measured checkpoint hold history (§4). This is a
   * SEPARATE question from the verdict above: not "should you go" but "given it's already
   * blowing, how long has this historically held". Reads a static, pre-computed artifact
   * (scripts/analyze-active-hold.mjs) rather than re-deriving anything at call time. --- */
  if (features?.avg30 !== null && features?.avg30 >= args.threshold) {
    console.log(`\n## ACTIVE-EVENT HOLD HISTORY (measured, not a live re-derivation)`);
    try {
      const calibPath = join(REPO_ROOT, 'research', 'active-hold-calibration.json');
      const calib = JSON.parse(await readFile(calibPath, 'utf8'));
      const gh = gateOpenHour(todayAtStation());
      const group = calib.byGateHour?.[gh];
      const { useGroup, summary: g } = pickGroupOrOverall(group, calib.overall, calib.minGroupSize);
      const note = useGroup ? '' : ` (gate-${gh} sample n=${group?.n ?? 0} < ${calib.minGroupSize}; showing overall rate)`;
      const asPct = (r) => (r?.rate === null || r?.rate === undefined ? 'n/a' : `${(r.rate * 100).toFixed(0)}% (${r.above}/${r.n})`);
      console.log(`Already at/above ${args.threshold} mph now.${note}`);
      console.log(`  held to gate-open:  ${asPct(g.gate)}`);
      console.log(`  held to gate+30min: ${asPct(g.gatePlus30)}`);
      console.log(`  held to gate+60min: ${asPct(g.gatePlus60)}`);
      if (g.duration?.medianMinutes !== null && g.duration?.medianMinutes !== undefined) {
        console.log(
          `  observed full-event duration: median +${g.duration.medianMinutes}min ` +
            `(p25 +${g.duration.p25Minutes}, p75 +${g.duration.p75Minutes}; ${g.duration.observedCount} observed, ` +
            `${g.duration.censoredCount} still running when the observation window closed)`
        );
      }
      console.log(`  ${calib.note}`);
    } catch {
      console.log('⚠️  Historical calibration unavailable (run scripts/analyze-active-hold.mjs) — no fabricated probability given.');
    }
  }

  console.log(`\n${'='.repeat(72)}`);

  /* --- optional: persist this call to the prediction log ---
   *
   * Same CSV shape the backtest emits, so a live morning and a replayed one are directly
   * comparable. Outcome columns (label, sustained_minutes, ...) are deliberately left blank:
   * at call time the morning has not happened yet, and guessing them would be fabricating the
   * very ground truth the log exists to provide. `scripts/reconcile-live-log.mjs` fills them in
   * once the archive has the day. Written via the atomic upsert store (scripts/lib/
   * prediction-log-store.mjs), which also fixes the double-newline defect the old
   * appendFileSync-based writer had, and de-duplicates a same-morning re-run by key rather than
   * appending a second row for it.
   */
  if (args.log) {
    const row = buildLogRow({
      source: 'live',
      date: fmtStationDateTime(now).slice(0, 10),
      callTime: fmtStationDateTime(now).slice(11, 16),
      station: target.name,
      threshold: args.threshold,
      features,
      call,
      label: null,
      humanNote: args.note,
      featureVersion: FEATURE_VERSION_V1,
      ruleVersion: RULE_VERSION_V1,
    });

    const logPath = join(REPO_ROOT, 'research', 'prediction-log.csv');
    await upsertRow(logPath, row);
    console.log(`\n📝 Logged ${call.verdict} (score ${call.score}) to research/prediction-log.csv (outcome filled in by reconciliation)`);
  }
}

main().catch((err) => {
  console.error(`❌ Katabatic check failed: ${err.message}`);
  process.exit(1);
});
