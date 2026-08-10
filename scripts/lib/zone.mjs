/**
 * Station-local time, pinned explicitly.
 *
 * ⚠️ THE BUG THIS EXISTS TO PREVENT. Every window in this project — gate open, the overnight
 * predictor window, call times — is defined in *Colorado* time, because that is where the meters
 * and the park gate are. The original code built those instants with `new Date(y, m, d, hour)`,
 * which silently means *whatever timezone the laptop happens to be in*.
 *
 * That held right up until the user ran the refresh from a trip. On an America/Chicago laptop the
 * labeller placed the 6:00 gate at 6:00 Chicago = 5:00 Denver, handing itself a free extra hour
 * of pre-dawn drainage flow. Measured on the full archive, that turned 92 rideable mornings into
 * 121 and the base rate from 29.4% into 38.7% — i.e. it re-admitted exactly the "blew before the
 * gate opened" mornings that §4.5's gate amendment was written to exclude, which is the single
 * failure mode that section exists to prevent.
 *
 * It was invisible because nothing errored; the numbers just got better. Both corroborating
 * checks are in §4.5/§8.1: the doc records a 29.5% base rate and 78 pre-gate mornings, and only
 * the Denver-pinned computation reproduces them (29.4%, 79).
 *
 * So: never build a station-local instant from the machine clock. Use `zonedTime`.
 */

export const STATION_TZ = 'America/Denver';

/** Milliseconds that `zone` is offset from UTC at the given instant. */
function offsetMs(zone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/**
 * The instant at which the given wall-clock time occurs in `STATION_TZ`.
 *
 * Two passes, because the offset itself depends on the instant: the first guess uses the offset
 * at the naive-UTC reading, the second re-resolves it at the corrected instant. That matters only
 * on the two DST changeover days a year, but those are real mornings in this archive and a
 * silently wrong one is worth more than the four lines it costs to avoid.
 */
export function zonedTime(year, month, day, hour = 0, minute = 0, second = 0, zone = STATION_TZ) {
  const naive = Date.UTC(year, month, day, hour, minute, second);
  let ts = naive - offsetMs(zone, new Date(naive));
  ts = naive - offsetMs(zone, new Date(ts));
  return new Date(ts);
}

/** As `zonedTime`, but taking the Y/M/D from an existing Date's calendar fields. */
export function zonedTimeFrom(date, hour = 0, minute = 0, second = 0, zone = STATION_TZ) {
  return zonedTime(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, second, zone);
}

/** Numeric calendar/clock fields of an instant, as read in `zone`. */
export function zonedParts(date, zone = STATION_TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month - 1, // 0-based, to match Date
    day: +p.day,
    hour: +p.hour % 24,
    minute: +p.minute,
    second: +p.second,
  };
}

/** Hour-of-day at the station for an absolute instant. Use instead of `date.getHours()`. */
export function zonedHour(date, zone = STATION_TZ) {
  return zonedParts(date, zone).hour;
}

/**
 * A Date carrying *the station's* current calendar day.
 *
 * Only Y/M/D are meaningful; it is deliberately built at machine-local midnight so the existing
 * calendar-bookkeeping helpers that read getFullYear/getMonth/getDate keep working unchanged.
 * Matters near midnight: at 00:30 in Chicago it is still the previous day in Denver, and
 * archiving "today" by the laptop's reckoning would try to fetch a day that has not happened yet.
 */
export function todayAtStation(zone = STATION_TZ) {
  const p = zonedParts(new Date(), zone);
  return new Date(p.year, p.month, p.day);
}

/** Calendar day (Y/M/D only) of an absolute instant, as observed at the station. */
export function stationDayOf(date, zone = STATION_TZ) {
  const p = zonedParts(date, zone);
  return new Date(p.year, p.month, p.day);
}

/** `YYYY-MM-DD HH:mm:ss` at the station — the format the Ecowitt API expects. */
export function fmtStationDateTime(date, zone = STATION_TZ) {
  const p = zonedParts(date, zone);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.year}-${z(p.month + 1)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}:${z(p.second)}`;
}

/** Human-readable station-local time, e.g. "6:45 AM". Always labelled MT by callers. */
export function fmtStationTime(date, zone = STATION_TZ) {
  return date.toLocaleTimeString('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Human-readable station-local date and time, for report headers. */
export function fmtStationDateTimeHuman(date, zone = STATION_TZ) {
  return date.toLocaleString('en-US', { timeZone: zone });
}
