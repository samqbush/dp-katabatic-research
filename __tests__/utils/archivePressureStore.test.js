import { jest } from '@jest/globals';

const client = { query: jest.fn() };

jest.unstable_mockModule('@/scripts/lib/db.mjs', () => ({
  query: jest.fn(),
  withTransaction: async (fn) => fn(client),
  closePool: jest.fn(),
}));

const { enrichObservationPressure, readDays } = await import('@/scripts/lib/archive-store.mjs');

describe('pressure enrichment storage', () => {
  beforeEach(() => {
    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pressure_provenance: null }] })
      .mockResolvedValueOnce({
        rows: [{ total: 2, pressure_count: 1, complete_count: 1 }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });
  });

  describe('consistent archive reads', () => {
    it('reads day metadata and observations in one repeatable-read transaction', async () => {
      client.query.mockReset();
      client.query
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [{
            local_date: '2026-09-01',
            fetched_at: '2026-09-02T20:00:00Z',
            status: 'ok',
            cycle_type: '1min',
            point_count: 1,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            local_date: '2026-09-01',
            ts: '2026-09-01T12:00:00Z',
            speed: 12,
            gust: 18,
            dir: 270,
            temp: 50,
            rh: 40,
            solar: 10,
          }],
        });

      const days = await readDays('lookout-mtn', {
        from: '2026-09-01',
        to: '2026-09-01',
        consistentSnapshot: true,
      });

      expect(client.query).toHaveBeenNthCalledWith(
        1, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
      );
      expect(client.query.mock.calls[1][0]).toContain('FROM station_days');
      expect(client.query.mock.calls[2][0]).toContain('FROM observations');
      expect(days).toHaveLength(1);
      expect(days[0].point_count).toBe(1);
      expect(days[0].points).toHaveLength(1);
      expect(days[0].points[0].speed).toBe(12);
    });
  });

  it('fills pressure only and records partial retrospective coverage atomically', async () => {
    const result = await enrichObservationPressure(
      'dp-soda-lakes',
      '2026-09-01',
      [{
        ts: 1788256800,
        absolute_pressure_hpa: 826.1,
        relative_pressure_hpa: 1012.4,
      }],
      {
        fetchedAt: '2026-09-02T21:00:00.000Z',
        cycleType: '5min',
      }
    );

    expect(result).toMatchObject({
      received: 1,
      matched: 1,
      unmatched: 0,
      updated: 1,
      pressureCount: 1,
      status: 'partial',
    });

    const updateSql = client.query.mock.calls[1][0];
    expect(updateSql).toContain('COALESCE(o.absolute_pressure_hpa, i.absolute_pressure_hpa)');
    expect(updateSql).toContain('COALESCE(o.relative_pressure_hpa, i.relative_pressure_hpa)');
    expect(updateSql).not.toMatch(/\b(speed|gust|dir|temp|rh)\s*=/);

    const metadataParams = client.query.mock.calls[4][1];
    expect(metadataParams).toEqual([
      'dp-soda-lakes',
      '2026-09-01',
      '2026-09-02T21:00:00.000Z',
      '5min',
      1,
      'partial',
      'retrospective',
    ]);
  });

  it('refuses to downgrade co-captured provenance during a retrospective retry', async () => {
    client.query.mockReset();
    client.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ pressure_provenance: 'co-captured' }] });

    await expect(
      enrichObservationPressure(
        'dp-soda-lakes',
        '2026-09-01',
        [{
          ts: Date.parse('2026-09-01T06:00:00Z') / 1000,
          absolute_pressure_hpa: 826.1,
          relative_pressure_hpa: 1012.4,
        }],
        {
          fetchedAt: '2026-09-02T21:00:00.000Z',
          cycleType: '5min',
        }
      )
    ).rejects.toThrow('refusing to relabel co-captured pressure as retrospective');
  });
});
