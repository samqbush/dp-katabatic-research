import {
  renderStationHistoryCsv,
  stationHistoryRows,
  STATION_HISTORY_COLUMNS,
} from '@/scripts/lib/station-history-csv.mjs';

const ORIGINAL_COLUMNS = [
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
];

describe('station history CSV', () => {
  it('preserves the Alex export columns and appends pressure provenance', () => {
    expect(STATION_HISTORY_COLUMNS.slice(0, ORIGINAL_COLUMNS.length)).toEqual(ORIGINAL_COLUMNS);
    expect(STATION_HISTORY_COLUMNS.slice(ORIGINAL_COLUMNS.length)).toEqual([
      'pressure_status',
      'pressure_provenance',
      'pressure_cycle_type',
      'pressure_point_count',
      'pressure_fetched_at_utc',
      'absolute_pressure_hpa',
      'relative_pressure_hpa',
    ]);
  });

  it('renders observations and metadata-only unobserved days with honest blanks', () => {
    const days = [
      {
        station: 'DP Soda Lakes',
        date: '2026-09-01',
        status: 'ok',
        cycle_type: '5min',
        point_count: 1,
        fetched_at: '2026-09-02T20:00:00.000Z',
        pressure_status: 'ok',
        pressure_provenance: 'retrospective',
        pressure_cycle_type: '5min',
        pressure_point_count: 1,
        pressure_fetched_at: '2026-09-02T21:00:00.000Z',
        points: [{
          ts: Date.parse('2026-09-01T06:00:00Z') / 1000,
          speed: 12.3,
          gust: 18.4,
          dir: 275,
          temp: 52.1,
          rh: 44,
          absolute_pressure_hpa: 826.1,
          relative_pressure_hpa: 1012.4,
        }],
      },
      {
        station: 'DP Soda Lakes',
        date: '2026-01-06',
        status: 'unobserved',
        reason: 'seasonal-shutdown',
        cycle_type: null,
        point_count: 0,
        fetched_at: '2026-09-02T20:00:00.000Z',
        pressure_status: 'no-data',
        pressure_provenance: 'co-captured',
        pressure_cycle_type: null,
        pressure_point_count: 0,
        pressure_fetched_at: '2026-09-02T20:00:00.000Z',
        points: [],
      },
    ];

    const rows = stationHistoryRows(days);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      observation_time_utc: '2026-09-01T06:00:00Z',
      observation_time_local: '2026-09-01 00:00:00',
      absolute_pressure_hpa: 826.1,
      relative_pressure_hpa: 1012.4,
    });
    expect(rows[1]).toMatchObject({
      day_status: 'unobserved',
      day_reason: 'seasonal-shutdown',
    });
    expect(rows[1].observation_epoch_seconds).toBeUndefined();

    const lines = renderStationHistoryCsv(days).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(STATION_HISTORY_COLUMNS.join(','));
    expect(lines[2].split(',')).toHaveLength(STATION_HISTORY_COLUMNS.length);
    expect(lines[2]).toContain('unobserved,seasonal-shutdown');
  });
});
