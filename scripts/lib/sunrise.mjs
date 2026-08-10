/**
 * Local sunrise calculation (NOAA solar position algorithm).
 *
 * The backtest needs sunrise for ~400 mornings. Hitting api.sunrise-sunset.org that many times
 * is slow and adds a network dependency to a computation that is pure math, so this replaces it
 * for bulk work. The live skill still uses the API for the single morning it cares about.
 *
 * Accurate to well under a minute at these latitudes, which is far tighter than the ±85 min
 * spread of the katabatic window close (§4.5) — so precision is not a limiting factor here.
 */

import { zonedTime } from './zone.mjs';

const DEG = Math.PI / 180;

/**
 * Morrison, CO — the drainage basin all the DP stations sit in.
 *
 * Lives here rather than in ecowitt.mjs so that pure-computation consumers (the label, the
 * backtest, the unit tests) can use it without dragging in axios, dotenv and `import.meta`.
 */
export const SUNRISE_COORDS = { lat: 39.6547, lng: -105.1956 };

function toJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function fromJulian(j) {
  return new Date((j - 2440587.5) * 86400000);
}

/**
 * @param {Date}   date Calendar day to compute for (only Y/M/D are read)
 * @param {number} lat  Degrees north
 * @param {number} lng  Degrees east (negative for the western hemisphere)
 * @returns {Date|null} Sunrise as an absolute instant, or null above/below the polar circles
 */
export function calcSunrise(date, lat, lng) {
  // Solar noon must be an instant pinned to Colorado, not to the machine.
  //
  // This was `new Date(y, m, d, 12)` — noon wherever the code happened to run. Everything after
  // it is instant arithmetic (`toJulian` reads epoch milliseconds), so the Julian day, and with
  // it the whole solar position, shifted with the operator's timezone. Far enough east the
  // rounded Julian day landed a day early and the label's morning window closed before the
  // morning began: measured from Pacific/Auckland, the base rate silently fell from 29.5% to
  // 14.4%. Nothing errored — the same signature as the §9.1 gate bug that moved 29.4% to 38.7%.
  //
  // The date argument is a calendar bag by convention (see parseArchiveDate), so its Y/M/D are
  // read with the machine-local getters that constructed it, then pinned to the station zone.
  const noonAtStation = zonedTime(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const n = Math.round(toJulian(noonAtStation) - 2451545.0 + 0.0008);

  // Solar mean anomaly
  const Jstar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;

  // Equation of the center and ecliptic longitude
  const C = 1.9148 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 0.0003 * Math.sin(3 * M * DEG);
  const lambda = (M + C + 180 + 102.9372) % 360;

  // Solar transit
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(M * DEG) - 0.0069 * Math.sin(2 * lambda * DEG);

  // Declination of the sun
  const sinDec = Math.sin(lambda * DEG) * Math.sin(23.44 * DEG);
  const cosDec = Math.cos(Math.asin(sinDec));

  // Hour angle, using the standard -0.833° altitude for refraction and solar radius
  const cosOmega = (Math.sin(-0.833 * DEG) - Math.sin(lat * DEG) * sinDec) / (Math.cos(lat * DEG) * cosDec);
  if (cosOmega > 1 || cosOmega < -1) return null; // polar day/night

  const omega = Math.acos(cosOmega) / DEG;
  return fromJulian(Jtransit - omega / 360);
}
