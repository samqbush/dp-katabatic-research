/**
 * Shared Ecowitt API client.
 *
 * Extracted so the live skill (`.github/skills/dp-katabatic-check/scripts/katabatic-check.mjs`),
 * the archiver, and the backtest all speak to the API the same way. If they drift, the backtest
 * stops testing the thing that actually runs in the morning.
 *
 * See research/katabatic-prediction.md §4.1–§4.3 for the measured API behaviour encoded here.
 */

import axios from 'axios';
import { config } from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SUNRISE_COORDS } from './sunrise.mjs';
import { fmtStationDateTime } from './zone.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..', '..');

config({ path: join(REPO_ROOT, '.env') });

const BASE_URL = 'https://api.ecowitt.net/api/v3';

export { SUNRISE_COORDS };

// Ecowitt unit ids. The parameter names matter: `wind_unit` / `temp_unit` are silently
// ignored by the API, which previously caused a 2.237x over-reporting bug (mph read as m/s).
// Always use the *_unitid names. See SKILL.md "Notes on the data source".
export const UNITS = {
  wind_speed_unitid: '9', // mph
  temp_unitid: '2', // Fahrenheit
  pressure_unitid: '3', // hPa
};

export class EcowittError extends Error {
  constructor(message, { retryable = false, rateLimited = false } = {}) {
    super(message);
    this.name = 'EcowittError';
    this.retryable = retryable;
    this.rateLimited = rateLimited;
  }
}

/**
 * Ecowitt enforces an undocumented call-rate cap and reports it in the message body with
 * `code !== 0`, NOT as an HTTP 429. Measured 2026-07-31 during the first full backfill: a run at
 * ~3 req/s died partway with "The number of interface accesses reached the upper limit".
 *
 * This must be distinguished from a genuine empty day, or a throttle would be silently archived
 * as "the station reported nothing" — which §4.2 forbids in the strongest terms.
 */
export function isRateLimitMessage(msg = '') {
  return /upper limit|frequency|too many|rate limit/i.test(msg);
}

/**
 * Resolve which Ecowitt credentials to use.
 *
 * **This is a blast-radius control, not a convenience.** The `ECOWITT_*` keys are compiled into
 * the shipped mobile app, and Ecowitt rate-limits per account. The research archiver is by far
 * the heaviest consumer in this repo — a single backfill is several hundred requests and has
 * already tripped the cap in practice. If it ran on the app's keys it could exhaust the shared
 * quota and **break wind data for every installed app on every user's phone**, to service a
 * side research project. That trade is never worth making.
 *
 * So: prefer a dedicated `ECOWITT_RESEARCH_*` pair. Fall back to the app keys only for local
 * one-off use, and say loudly when that happens.
 */
export function resolveCredentials({ purpose = 'research' } = {}) {
  const research = {
    application_key: process.env.ECOWITT_RESEARCH_APPLICATION_KEY,
    api_key: process.env.ECOWITT_RESEARCH_API_KEY,
  };
  if (research.application_key && research.api_key) {
    return { ...research, source: 'research' };
  }

  const app = {
    application_key: process.env.ECOWITT_APPLICATION_KEY,
    api_key: process.env.ECOWITT_API_KEY,
  };
  if (app.application_key && app.api_key) {
    return { ...app, source: 'app' };
  }
  return { application_key: null, api_key: null, source: 'none', purpose };
}

/**
 * Hard requirement for bulk jobs (the archiver, CI). Refuses to run heavy traffic on the app's
 * keys at all — a warning is not enough when the downside is every user's app going dark.
 */
export function assertResearchCredentials() {
  const c = resolveCredentials();
  if (c.source === 'research') return c;
  throw new EcowittError(
    'Refusing to run a bulk archive job on the shipped app\'s Ecowitt keys.\n' +
      '  Set ECOWITT_RESEARCH_APPLICATION_KEY and ECOWITT_RESEARCH_API_KEY to a separate\n' +
      '  Ecowitt account/token used only for research.\n' +
      '  Reason: Ecowitt rate-limits per account. Bulk archiving on the app keys can exhaust\n' +
      '  the shared quota and break wind data for every installed app.\n' +
      `  Expected in ${join(REPO_ROOT, '.env')} (see .env.example), or as CI secrets.`
  );
}

export function assertCredentials() {
  const c = resolveCredentials();
  if (c.source === 'none') {
    throw new EcowittError(
      `Missing Ecowitt credentials. Set ECOWITT_RESEARCH_APPLICATION_KEY / ECOWITT_RESEARCH_API_KEY ` +
        `(preferred) or ECOWITT_APPLICATION_KEY / ECOWITT_API_KEY in ${join(REPO_ROOT, '.env')} (see .env.example).`
    );
  }
  return c;
}

function creds() {
  const c = resolveCredentials();
  return { application_key: c.application_key, api_key: c.api_key };
}

/**
 * Ecowitt wants *station* wall-clock time in `YYYY-MM-DD HH:mm:ss`, not ISO/UTC.
 *
 * This used to read the machine clock, which was correct only by cancellation: callers built a
 * machine-local midnight and formatted it machine-locally, so the string came out "00:00:00"
 * whatever the laptop's zone, and Ecowitt read it as station-local. Two errors annihilating.
 * That is fragile — it breaks the moment a caller passes a genuine instant such as `new Date()`,
 * which is exactly what the live check does. Now pinned to the station zone (§9.1), so callers
 * must pass real instants and get correct strings from anywhere on earth.
 */
export function fmtEcowittDate(d) {
  return fmtStationDateTime(d);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Distinguish a genuine empty response (station was off) from a transport failure.
 * This matters enormously: §4.2 requires that "no data" is recorded as *unobserved*,
 * never as calm — and an API error must never be mistaken for either.
 */
async function withRetry(fn, { attempts = 4, baseDelayMs = 1000, label = 'request', onRateLimit = null } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.rateLimited) {
        // Backing off a second is useless against a rate cap — it needs a real cooldown, and
        // burning retries on it just deepens the hole.
        const cooldown = RATE_LIMIT_COOLDOWN_MS;
        if (onRateLimit) onRateLimit(cooldown, i);
        await sleep(cooldown);
        continue;
      }
      const retryable = err.retryable !== false;
      if (!retryable || i === attempts - 1) break;
      await sleep(baseDelayMs * Math.pow(2, i));
    }
  }
  throw new EcowittError(`${label} failed after ${attempts} attempts: ${lastErr?.message}`, {
    retryable: true,
    rateLimited: !!lastErr?.rateLimited,
  });
}

export const RATE_LIMIT_COOLDOWN_MS = 65000;

export async function getDevices() {
  assertCredentials();
  return withRetry(
    async () => {
      const res = await axios.get(`${BASE_URL}/device/list`, { params: creds(), timeout: 15000 });
      if (res.data.code !== 0) throw new EcowittError(`device list error: ${res.data.msg}`);
      return res.data.data?.list || [];
    },
    { label: 'device list' }
  );
}

/** All stations this project tracks. Name prefix is the existing convention. */
export async function getDpDevices() {
  const devices = await getDevices();
  return devices.filter((d) => /^DP /i.test(d.name));
}

export async function findDevice(nameFragment) {
  const devices = await getDevices();
  const match = devices.find((d) => d.name.toLowerCase().includes(nameFragment.toLowerCase()));
  if (!match) {
    throw new EcowittError(`No station matching "${nameFragment}". Available: ${devices.map((d) => d.name).join(', ')}`);
  }
  return match;
}

/**
 * Parse one Ecowitt history payload into the archive point contract.
 *
 * Wind timestamps remain canonical because observations require wind. Pressure timestamps that
 * do not align are reported rather than invented as wind observations.
 */
export function parseHistoryData(data = {}) {
  const speed = data.wind?.wind_speed?.list || {};
  const gust = data.wind?.wind_gust?.list || {};
  const dir = data.wind?.wind_direction?.list || {};
  const temp = data.outdoor?.temperature?.list || {};
  const rh = data.outdoor?.humidity?.list || {};
  const absolutePressure = data.pressure?.absolute?.list || {};
  const relativePressure = data.pressure?.relative?.list || {};

  const points = Object.keys(speed)
    .map((ts) => ({
      ts: parseInt(ts, 10),
      speed: parseFloat(speed[ts]),
      gust: parseFloat(gust[ts] ?? speed[ts]),
      dir: parseFloat(dir[ts]),
      temp: temp[ts] !== undefined ? parseFloat(temp[ts]) : null,
      rh: rh[ts] !== undefined ? parseFloat(rh[ts]) : null,
      absolute_pressure_hpa:
        absolutePressure[ts] !== undefined ? parseFloat(absolutePressure[ts]) : null,
      relative_pressure_hpa:
        relativePressure[ts] !== undefined ? parseFloat(relativePressure[ts]) : null,
    }))
    .filter((p) => Number.isFinite(p.speed))
    .sort((a, b) => a.ts - b.ts);

  const windTimestamps = new Set(points.map((p) => String(p.ts)));
  const pressureTimestamps = new Set([
    ...Object.keys(absolutePressure),
    ...Object.keys(relativePressure),
  ]);
  const pressure = {
    absoluteCount: Object.values(absolutePressure).filter((v) => Number.isFinite(parseFloat(v))).length,
    relativeCount: Object.values(relativePressure).filter((v) => Number.isFinite(parseFloat(v))).length,
    matchedCount: points.filter(
      (p) => Number.isFinite(p.absolute_pressure_hpa) || Number.isFinite(p.relative_pressure_hpa)
    ).length,
    unmatchedCount: [...pressureTimestamps].filter((ts) => !windTimestamps.has(ts)).length,
    cycleType: inferCycleType(
      [...pressureTimestamps]
        .map((ts) => ({ ts: parseInt(ts, 10) }))
        .filter((p) => Number.isFinite(p.ts))
        .sort((a, b) => a.ts - b.ts)
    ),
  };

  return { points, pressure };
}

/**
 * Fetch a window of history. Returns `{ points, cycleType, pressure }`.
 *
 * `points` may legitimately be empty — that is data, not an error (see §4.2). Callers must
 * decide what an empty result means based on the date; this function will not guess.
 */
export async function getHistory(mac, start, end, { cycleType = 'auto', onRateLimit = null } = {}) {
  assertCredentials();
  return withRetry(
    async () => {
      const res = await axios.get(`${BASE_URL}/device/history`, {
        params: {
          ...creds(),
          mac,
          start_date: fmtEcowittDate(start),
          end_date: fmtEcowittDate(end),
          cycle_type: cycleType,
          call_back: 'wind,outdoor,pressure',
          ...UNITS,
        },
        timeout: 25000,
      });
      if (res.data.code !== 0) {
        throw new EcowittError(`history error: ${res.data.msg}`, { rateLimited: isRateLimitMessage(res.data.msg) });
      }

      const parsed = parseHistoryData(res.data.data || {});
      return { ...parsed, cycleType: inferCycleType(parsed.points) };
    },
    { label: `history ${fmtEcowittDate(start)}`, onRateLimit }
  );
}

/**
 * Resolution decays with age (§4.1): ~5 min for the first ~90 days, ~30 min after.
 * Record what we actually got rather than what we asked for, so the archive is self-describing.
 */
export function inferCycleType(points) {
  if (points.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].ts - points[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const medianSec = gaps[Math.floor(gaps.length / 2)];
  if (medianSec <= 450) return '5min';
  if (medianSec <= 2700) return '30min';
  return `${Math.round(medianSec / 60)}min`;
}

export async function getSunrise(date = new Date()) {
  try {
    const p = (n) => String(n).padStart(2, '0');
    const res = await axios.get('https://api.sunrise-sunset.org/json', {
      params: {
        lat: SUNRISE_COORDS.lat,
        lng: SUNRISE_COORDS.lng,
        date: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
        formatted: 0,
      },
      timeout: 8000,
    });
    return res.data?.status === 'OK' ? new Date(res.data.results.sunrise) : null;
  } catch {
    return null; // Non-fatal: sunrise is context, not a gate.
  }
}
