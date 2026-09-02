import { fmtStationDateTime } from './zone.mjs';

export const STATION_HISTORY_COLUMNS = [
  'station',
  'local_date',
  'day_status',
  'day_reason',
  'cycle_type',
  'day_point_count',
  'fetched_at_utc',
  'observation_epoch_seconds',
  'observation_time_utc',
  'observation_time_local',
  'wind_speed_mph',
  'wind_gust_mph',
  'wind_direction_degrees',
  'temperature_f',
  'relative_humidity_percent',
  'pressure_status',
  'pressure_provenance',
  'pressure_cycle_type',
  'pressure_point_count',
  'pressure_fetched_at_utc',
  'absolute_pressure_hpa',
  'relative_pressure_hpa',
];

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function observationIso(ts) {
  return new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
}

export function stationHistoryRows(days) {
  const rows = [];
  for (const day of days) {
    const base = {
      station: day.station,
      local_date: day.date,
      day_status: day.status,
      day_reason: day.reason,
      cycle_type: day.cycle_type,
      day_point_count: day.point_count,
      fetched_at_utc: day.fetched_at,
      pressure_status: day.pressure_status,
      pressure_provenance: day.pressure_provenance,
      pressure_cycle_type: day.pressure_cycle_type,
      pressure_point_count: day.pressure_point_count,
      pressure_fetched_at_utc: day.pressure_fetched_at,
    };

    if (!day.points?.length) {
      rows.push(base);
      continue;
    }

    for (const point of day.points) {
      const instant = new Date(point.ts * 1000);
      rows.push({
        ...base,
        observation_epoch_seconds: point.ts,
        observation_time_utc: observationIso(point.ts),
        observation_time_local: fmtStationDateTime(instant),
        wind_speed_mph: point.speed,
        wind_gust_mph: point.gust,
        wind_direction_degrees: point.dir,
        temperature_f: point.temp,
        relative_humidity_percent: point.rh,
        absolute_pressure_hpa: point.absolute_pressure_hpa,
        relative_pressure_hpa: point.relative_pressure_hpa,
      });
    }
  }
  return rows;
}

export function renderStationHistoryCsv(days) {
  const rows = stationHistoryRows(days);
  const lines = [STATION_HISTORY_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(STATION_HISTORY_COLUMNS.map((column) => escapeCsv(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

