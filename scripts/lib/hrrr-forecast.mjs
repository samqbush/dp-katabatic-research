import axios from 'axios';
import { MIN_NIGHT_BEFORE_FORECAST_HOURS } from './night-before-call.mjs';

const API = 'https://single-runs-api.open-meteo.com/v1/forecast';
const SITE = { lat: 39.646115, lon: -105.174958 };
const WINDOW_HOURS = Object.freeze([5, 6, 7, 8]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mergeRows(...groups) {
  const byHour = new Map();
  for (const rows of groups) {
    for (const row of rows) byHour.set(row.hr, row);
  }
  return [...byHour.values()].sort((a, b) => a.hr - b.hr);
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
    if (!WINDOW_HOURS.includes(hr)) continue;
    const rawLid = hourly.boundary_layer_height[index];
    const rawWind = hourly.wind_speed_10m[index];
    if (rawLid === null || rawLid === undefined || rawWind === null || rawWind === undefined) {
      continue;
    }
    const lid = Number(rawLid);
    const wind = Number(rawWind);
    if (!Number.isFinite(lid) || !Number.isFinite(wind)) continue;
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
  } = {},
) {
  const run = `${date}T00:00`;

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
      const usableHours = mergeRows(existingRows, rows).length;
      if (usableHours >= MIN_NIGHT_BEFORE_FORECAST_HOURS) {
        return { status: 'ready', rows, attempts: attempt, usableHours };
      }

      if (!waitForPublication || attempt === maxAttempts) {
        log(
          `  ${date}: incomplete 00Z response (${usableHours}/4 usable hours) ` +
          `after ${attempt} attempt(s) — nothing written`,
        );
        return { status: 'incomplete', rows: null, attempts: attempt, usableHours };
      }

      const wait = retryBaseMs * attempt;
      log(
        `  ${date}: incomplete 00Z response (${usableHours}/4 usable hours), ` +
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
          `after ${attempt} attempt(s) — nothing written`,
        );
        return {
          status: unavailable ? 'unavailable' : 'failed',
          rows: null,
          attempts: attempt,
          usableHours: existingRows.length,
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
}) {
  const issued = await findIssuedPrediction();
  if (issued) {
    return { status: 'already-issued', prediction: issued, rows: null };
  }

  let storedRows = await loadStoredRows();
  let source = 'stored';
  if (storedRows.length < MIN_NIGHT_BEFORE_FORECAST_HOURS) {
    const fetched = await fetchMorning(date, {
      existingRows: storedRows,
      waitForPublication: generationMode === 'forward',
    });
    if (!fetched.rows) {
      return { status: 'unresolved', prediction: null, rows: null, fetch: fetched };
    }
    await storeRows(fetched.rows);
    storedRows = await loadStoredRows();
    source = 'upstream';
  }

  if (storedRows.length < MIN_NIGHT_BEFORE_FORECAST_HOURS) {
    throw new Error(
      `Stored HRRR forecast for ${date} has only ${storedRows.length} usable hour(s) after capture`,
    );
  }

  const prediction = await persistRows(storedRows);
  if (!prediction) {
    throw new Error(`Usable HRRR forecast for ${date} did not produce a prediction`);
  }
  return { status: 'captured', prediction, rows: storedRows, source };
}
