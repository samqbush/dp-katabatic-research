import axios from 'axios';
import { MIN_NIGHT_BEFORE_FORECAST_HOURS } from './night-before-call.mjs';
import { zonedParts } from './zone.mjs';

const API = 'https://single-runs-api.open-meteo.com/v1/forecast';
const SITE = { lat: 39.646115, lon: -105.174958 };
export const HRRR_CAPTURE_HOURS = Object.freeze([5, 6, 7, 8, 9, 10, 11]);
const WINDOW_HOURS = new Set(HRRR_CAPTURE_HOURS);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usablePair(row) {
  return row.lid !== null && row.lid !== undefined && Number.isFinite(Number(row.lid))
    && row.wind !== null && row.wind !== undefined && Number.isFinite(Number(row.wind));
}

function mergeRows(...groups) {
  const byHour = new Map();
  for (const rows of groups) {
    for (const row of rows) {
      const hr = Number(row.hr);
      const previous = byHour.get(hr);
      byHour.set(hr, {
        hr,
        lid: row.lid ?? previous?.lid ?? null,
        wind: row.wind ?? previous?.wind ?? null,
      });
    }
  }
  return [...byHour.values()].sort((a, b) => a.hr - b.hr);
}

export function nightBeforeGenerationMode(date, requestedMode, now = new Date()) {
  if (!['forward', 'retrospective', null].includes(requestedMode)) {
    throw new Error('--mode must be "forward" or "retrospective"');
  }
  const { year, month, day } = zonedParts(now);
  const today = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const canBeForward = date > today && now >= new Date(`${date}T00:00:00Z`);
  if (requestedMode === 'forward' && !canBeForward) {
    throw new Error(`Cannot mark ${date} forward: its run must exist and its local day must not have started.`);
  }
  return requestedMode || (canBeForward ? 'forward' : 'retrospective');
}

export function extractHrrrMorningRows(payload, date) {
  const hourly = payload?.hourly;
  if (
    !Array.isArray(hourly?.time)
    || !Array.isArray(hourly?.boundary_layer_height)
    || !Array.isArray(hourly?.wind_speed_10m)
  ) return [];

  const rows = [];
  for (let index = 0; index < hourly.time.length; index++) {
    const [rowDate, time] = hourly.time[index].split('T');
    if (rowDate !== date) continue;
    const hr = Number.parseInt(time?.slice(0, 2), 10);
    if (!WINDOW_HOURS.has(hr)) continue;
    const rawLid = hourly.boundary_layer_height[index];
    const rawWind = hourly.wind_speed_10m[index];
    const lid = rawLid == null || !Number.isFinite(Number(rawLid)) ? null : Number(rawLid);
    const wind = rawWind == null || !Number.isFinite(Number(rawWind)) ? null : Number(rawWind);
    if (lid === null && wind === null) continue;
    rows.push({ hr, lid, wind });
  }
  return rows;
}

export async function fetchHrrrMorning(
  date,
  {
    existingRows = [],
    waitForPublication = false,
    request = axios.get,
    sleep = defaultSleep,
    log = (message) => console.log(message),
    maxAttempts = 4,
    retryBaseMs = 30_000,
    minimumUsableHours = MIN_NIGHT_BEFORE_FORECAST_HOURS,
  } = {},
) {
  const run = `${date}T00:00`;
  let accumulatedRows = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await request(API, {
        params: {
          latitude: SITE.lat,
          longitude: SITE.lon,
          hourly: 'boundary_layer_height,wind_speed_10m',
          models: 'gfs_hrrr',
          run,
          timezone: 'America/Denver',
          wind_speed_unit: 'mph',
        },
        timeout: 60_000,
      });
      const rows = extractHrrrMorningRows(response.data, date);
      accumulatedRows = mergeRows(rows, accumulatedRows);
      const usableHours = mergeRows(accumulatedRows, existingRows).filter(usablePair).length;
      if (usableHours >= minimumUsableHours) {
        return { status: 'ready', rows: accumulatedRows, attempts: attempt, usableHours };
      }

      if (!waitForPublication || attempt === maxAttempts) {
        log(
          `  ${date}: incomplete 00Z response (${usableHours}/${HRRR_CAPTURE_HOURS.length} captured hours) ` +
          `after ${attempt} attempt(s)`,
        );
        return {
          status: 'incomplete',
          rows: accumulatedRows.length ? accumulatedRows : null,
          attempts: attempt,
          usableHours,
        };
      }

      const wait = retryBaseMs * attempt;
      log(
        `  ${date}: incomplete 00Z response (${usableHours}/${HRRR_CAPTURE_HOURS.length} captured hours), ` +
        `attempt ${attempt}/${maxAttempts}; retrying in ${wait / 1000}s`,
      );
      await sleep(wait);
    } catch (error) {
      const reason = error.response?.data?.reason || error.message;
      const unavailable = /not available/i.test(reason);
      const retryable = attempt < maxAttempts && (!unavailable || waitForPublication);

      if (!retryable) {
        log(
          `  ${date}: ${unavailable ? 'run unavailable' : `request failed (${reason})`} ` +
          `after ${attempt} attempt(s)`,
        );
        return {
          status: unavailable ? 'unavailable' : 'failed',
          rows: accumulatedRows.length ? accumulatedRows : null,
          attempts: attempt,
          usableHours: mergeRows(accumulatedRows, existingRows).filter(usablePair).length,
        };
      }

      const wait = retryBaseMs * attempt;
      log(
        `  ${date}: attempt ${attempt}/${maxAttempts} failed (${reason}); ` +
        `retrying in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }

  throw new Error(`HRRR retry loop ended unexpectedly for ${date}`);
}

export async function collectHrrrMorning({
  date,
  generationMode,
  findIssuedPrediction,
  loadStoredRows,
  storeRows,
  persistRows,
  fetchMorning = fetchHrrrMorning,
  minimumUsableHours = MIN_NIGHT_BEFORE_FORECAST_HOURS,
  requiredCaptureHours = null,
}) {
  const issued = await findIssuedPrediction();
  if (issued && !requiredCaptureHours) {
    return { status: 'already-issued', prediction: issued, rows: null };
  }

  let storedRows = await loadStoredRows();
  const isComplete = (rows) => (
    requiredCaptureHours
      ? requiredCaptureHours.every(
        (hour) => rows.some((row) => Number(row.hr) === hour && usablePair(row)),
      )
      : rows.filter(usablePair).length >= minimumUsableHours
  );
  if (issued && isComplete(storedRows)) {
    return { status: 'already-issued', prediction: issued, rows: null };
  }
  let source = 'stored';
  if (!isComplete(storedRows)) {
    const fetched = await fetchMorning(date, {
      existingRows: storedRows,
      waitForPublication: generationMode === 'forward',
      minimumUsableHours,
    });
    if (fetched.rows?.length) {
      await storeRows(fetched.rows);
      storedRows = await loadStoredRows();
      source = 'upstream';
    }
  }

  const prediction = issued || await persistRows(storedRows);
  if (!prediction) {
    return { status: 'unresolved', prediction: null, rows: storedRows, source };
  }
  return {
    status: isComplete(storedRows)
      ? (issued && source === 'stored' ? 'already-issued' : 'captured')
      : 'incomplete',
    prediction,
    rows: storedRows,
    source,
  };
}
