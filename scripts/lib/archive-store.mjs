/**
 * Archive store — the single data-access layer for the katabatic research archive.
 *
 * ---------------------------------------------------------------------------------------------
 * SINGLE STORE: NEON
 * ---------------------------------------------------------------------------------------------
 * Neon Postgres is now the only store. The dual-write to committed JSON files was a migration
 * safety net and has been removed: parity was verified clean across all 901 archived days (day
 * sets, day fields, point hashes and readDay round-trips all identical) and the files remain in
 * git as a frozen historical copy, not as a live backend.
 *
 * The data itself is still PERISHABLE and UNRECOVERABLE — Holfuy publishes a ~5.9-day rolling
 * window with no backfill, and Ecowitt downsamples past ~90 days (112 days in the archive are
 * already stuck at 4-hour resolution). Every safety property below exists because of that.
 *
 * ---------------------------------------------------------------------------------------------
 * FAILURE MODEL: A FAILED WRITE IS FATAL, NOT DEGRADED
 * ---------------------------------------------------------------------------------------------
 * Writes used to swallow database errors into a non-fatal `neonError` and let the run continue
 * (exit 3, "degraded"). That contract was correct only while a file on disk had ALREADY captured
 * the day: collection and replication were separate failure domains, and losing the replica cost
 * nothing recoverable.
 *
 * With no file, there is no second copy. A swallowed write error is now permanent loss of an
 * observation window that upstream will never serve again. So writeDay THROWS, and callers must
 * fail loudly rather than report a successful-looking run that persisted nothing.
 *
 * `ping()` exists for the same reason from the other direction: the archivers call it before
 * spending the upstream fetch, so a dead database is discovered while the data is still
 * retrievable instead of after it has been pulled and dropped.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO WRITE OPERATIONS, NOT ONE
 * ---------------------------------------------------------------------------------------------
 * The two archivers genuinely differ, and collapsing them into one write corrupts data:
 *
 *   replaceDay()  Ecowitt. archive-ecowitt.mjs rebuilds the whole day record, so a refetch must
 *                 REPLACE the day. Merging instead would leave ghost observations from a
 *                 previous fetch that the fresh record no longer contains — and a day re-fetched
 *                 as `unobserved` would keep its old wind points, which is precisely the "dark
 *                 day reported as calm" failure the project forbids.
 *
 *   mergeDay()    Holfuy. archive-holfuy.mjs unions by timestamp across the rolling window so
 *                 coverage only accumulates as 1-minute rows thin to 15-minute ones. Replacing
 *                 here would discard everything the window has already scrolled past.
 *
 * ---------------------------------------------------------------------------------------------
 * OBSERVATIONS ARE IMMUTABLE ON CONFLICT
 * ---------------------------------------------------------------------------------------------
 * mergeDay inserts with ON CONFLICT DO NOTHING: new timestamps are added, existing ones are never
 * rewritten. An archived observation is a record of what the station actually reported, so it is
 * append-only by construction and history cannot silently degrade if upstream later serves a
 * coarser or altered value for a timestamp already captured. `mergeDay` reports how many rows it
 * added so a fetch that contributes nothing is visible rather than assumed.
 *
 * ---------------------------------------------------------------------------------------------
 * TIMEZONE
 * ---------------------------------------------------------------------------------------------
 * Day bounds are half-open [start, end) and DST-aware, computed with the station-timezone helpers
 * in lib/zone.mjs rather than as `start + 24h`. A timezone bug shipped once and silently inflated
 * the headline base rate from 29.4% to 38.7% before anyone noticed. DST days are legitimately 23
 * or 25 hours — never assume 24.
 *
 * For the same reason an observation whose timestamp falls outside the day being written THROWS
 * instead of being stored: attaching it to the wrong day is exactly how the numbers were corrupted
 * the first time, and it is invisible afterwards.
 *
 * ---------------------------------------------------------------------------------------------
 * STATION METADATA IS LOCAL
 * ---------------------------------------------------------------------------------------------
 * getStation resolves from scripts/lib/stations.mjs, never from the database. A DB lookup once
 * ran before the write and an outage therefore aborted collection entirely, costing days that can
 * never be re-fetched. Metadata is static config; it has no business being a network dependency.
 */

import { query, withTransaction, closePool } from './db.mjs';
import { STATION_TZ, zonedTime } from './zone.mjs';
import { stationBySlug, stationsBySource, requireEcowittMac } from './stations.mjs';

// ------------------------------------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------------------------------------

/**
 * One-line description of where the archive actually lives, for run headers.
 *
 * Host and database only. The connection string carries the password, and these headers get
 * pasted into issues and logs — never widen this to the full URL.
 */
export function storeConfigSummary() {
  const raw = process.env.NEON_DATABASE_URL;
  if (!raw) return 'store=neon (NEON_DATABASE_URL unset)';
  try {
    const u = new URL(raw);
    return `store=neon host=${u.hostname} db=${u.pathname.replace(/^\//, '') || '(default)'}`;
  } catch {
    return 'store=neon (NEON_DATABASE_URL unparseable)';
  }
}

/**
 * Cheap liveness check, run by the archivers BEFORE the upstream fetch.
 *
 * Holfuy's window scrolls and Ecowitt downsamples, so discovering a dead database after the fetch
 * means the data is already gone. Fail here, while it can still be retried.
 */
export async function ping() {
  try {
    await query('SELECT 1');
  } catch (err) {
    throw new Error(
      `Neon is unreachable — refusing to fetch upstream data that would have nowhere to go.\n` +
        `  ${storeConfigSummary()}\n` +
        `  Cause: ${err.message}\n` +
        '  Check NEON_DATABASE_URL in .env (use the POOLED host, containing "-pooler") and that\n' +
        '  the Neon project is not suspended, then re-run.',
      { cause: err }
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Day boundaries
// ------------------------------------------------------------------------------------------------

function parseIsoDay(date) {
  if (date instanceof Date) return date;
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function isoDay(date) {
  const d = parseIsoDay(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Half-open [start, end) bounds of a station-local day, as epoch seconds.
 *
 * Computed as midnight-of-this-day to midnight-of-next-day in the station timezone, NOT as
 * start + 24h: across a DST transition the day is 23 or 25 hours long and a fixed offset would
 * drop or duplicate an hour of observations at the boundary.
 */
export function dayBoundsEpoch(date) {
  const d = parseIsoDay(date);
  const start = zonedTime(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, STATION_TZ);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const end = zonedTime(next.getFullYear(), next.getMonth(), next.getDate(), 0, 0, 0, STATION_TZ);
  return { startSec: Math.floor(start.getTime() / 1000), endSec: Math.floor(end.getTime() / 1000) };
}

// ------------------------------------------------------------------------------------------------
// Record shape
// ------------------------------------------------------------------------------------------------

/**
 * Rebuild the exact JSON day-record shape from relational rows.
 *
 * Source-conditional fields must be OMITTED, not nulled: an Ecowitt record has `mac` and no
 * `holfuy_id`/`slug`/`lat`/`lon`, and a Holfuy record is the reverse. Emitting `holfuy_id: null`
 * on an Ecowitt day would be a different object than the file holds and would fail parity.
 */
function buildRecord(stationRow, dayRow, points) {
  const rec = {
    station: stationRow.name,
    ...(stationRow.source === 'ecowitt'
      ? {
          mac: requireEcowittMac(stationRow.slug),
          pressure_fetched_at: dayRow.pressure_fetched_at
            ? new Date(dayRow.pressure_fetched_at).toISOString()
            : null,
          pressure_cycle_type: dayRow.pressure_cycle_type,
          pressure_point_count: dayRow.pressure_point_count,
          pressure_status: dayRow.pressure_status,
          pressure_provenance: dayRow.pressure_provenance,
        }
      : {
          holfuy_id: stationRow.holfuy_id,
          slug: stationRow.slug,
          lat: Number(stationRow.lat),
          lon: Number(stationRow.lon),
        }),
    date: isoDay(dayRow.local_date),
    fetched_at: new Date(dayRow.fetched_at).toISOString(),
    status: dayRow.status,
    ...(dayRow.reason ? { reason: dayRow.reason } : {}),
    cycle_type: dayRow.cycle_type,
    point_count: dayRow.point_count,
    points,
  };
  return rec;
}

/** Pressure is Ecowitt-only and solar is Holfuy-only; absent and null are distinct. */
function buildPoint(row, source) {
  const p = {
    ts: Math.floor(new Date(row.ts).getTime() / 1000),
    speed: row.speed,
    gust: row.gust,
    dir: row.dir,
    temp: row.temp,
    rh: row.rh,
  };
  if (source === 'ecowitt') {
    p.absolute_pressure_hpa = row.absolute_pressure_hpa;
    p.relative_pressure_hpa = row.relative_pressure_hpa;
  } else {
    p.solar = row.solar;
  }
  return p;
}

// ------------------------------------------------------------------------------------------------
// Station registry
// ------------------------------------------------------------------------------------------------

/**
 * Station metadata resolves locally, never from the database.
 *
 * This is deliberately synchronous-in-spirit (kept async for a stable call signature): a Neon
 * lookup here used to run *before* the local file write, so a database outage aborted collection
 * and cost days that can never be re-fetched.
 */
export async function getStation(slug) {
  return stationBySlug(slug);
}

export async function listStations(source) {
  return stationsBySource(source);
}

export function stationSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------------------------------------
// Neon backend
// ------------------------------------------------------------------------------------------------

async function readDayNeon(stationRow, date) {
  const day = isoDay(date);
  const { rows: dayRows } = await query(
    'SELECT * FROM station_days WHERE station_slug = $1 AND local_date = $2',
    [stationRow.slug, day]
  );
  if (!dayRows.length) return null;

  const { startSec, endSec } = dayBoundsEpoch(day);
  const { rows: obsRows } = await query(
    `SELECT * FROM observations
      WHERE station_slug = $1 AND ts >= to_timestamp($2) AND ts < to_timestamp($3)
      ORDER BY ts`,
    [stationRow.slug, startSec, endSec]
  );

  return buildRecord(
    stationRow,
    dayRows[0],
    obsRows.map((r) => buildPoint(r, stationRow.source))
  );
}

/**
 * Insert observations for one day inside an existing transaction.
 *
 * Every point is validated against the day's DST-aware bounds first. A point outside them means
 * a timezone or merge bug, and writing it would attach an observation to the wrong day — the
 * exact failure mode that corrupted the numbers before. Fail loudly instead.
 */
async function insertObservations(client, stationRow, date, points, { onConflict }) {
  if (!points.length) return 0;

  const day = isoDay(date);
  const { startSec, endSec } = dayBoundsEpoch(day);
  for (const p of points) {
    if (p.ts < startSec || p.ts >= endSec) {
      throw new Error(
        `${stationRow.slug} ${day}: observation ts=${p.ts} falls outside the station-local day ` +
          `[${startSec}, ${endSec}). Refusing to write — this indicates a timezone or merge bug.`
      );
    }
  }

  const values = [];
  const params = [];
  points.forEach((p, i) => {
    const b = i * 10;
    values.push(
      `($${b + 1}, to_timestamp($${b + 2}), $${b + 3}, $${b + 4}, $${b + 5},
        $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`
    );
    params.push(
      stationRow.slug,
      p.ts,
      p.speed,
      p.gust,
      p.dir,
      p.temp ?? null,
      p.rh ?? null,
      p.absolute_pressure_hpa ?? null,
      p.relative_pressure_hpa ?? null,
      p.solar ?? null
    );
  });

  const conflict =
    onConflict === 'replace'
      ? `ON CONFLICT (station_slug, ts) DO UPDATE SET
           speed = EXCLUDED.speed, gust = EXCLUDED.gust, dir = EXCLUDED.dir,
        temp = EXCLUDED.temp, rh = EXCLUDED.rh,
        absolute_pressure_hpa = EXCLUDED.absolute_pressure_hpa,
        relative_pressure_hpa = EXCLUDED.relative_pressure_hpa,
        solar = EXCLUDED.solar`
      : 'ON CONFLICT (station_slug, ts) DO NOTHING';

  const res = await client.query(
    `INSERT INTO observations
       (station_slug, ts, speed, gust, dir, temp, rh,
        absolute_pressure_hpa, relative_pressure_hpa, solar)
     VALUES ${values.join(', ')} ${conflict}`,
    params
  );
  return res.rowCount;
}

async function upsertDayRow(client, stationRow, record, pointCount) {
  await client.query(
    `INSERT INTO station_days
       (station_slug, local_date, status, reason, cycle_type, point_count, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (station_slug, local_date) DO UPDATE SET
       status = EXCLUDED.status, reason = EXCLUDED.reason, cycle_type = EXCLUDED.cycle_type,
       point_count = EXCLUDED.point_count, fetched_at = EXCLUDED.fetched_at`,
    [
      stationRow.slug,
      isoDay(record.date),
      record.status,
      record.reason ?? null,
      record.cycle_type ?? null,
      pointCount,
      record.fetched_at,
    ]
  );
}

const PRESSURE_PROVENANCE = new Set(['co-captured', 'retrospective']);

async function updatePressureDayMetadata(
  client,
  stationRow,
  date,
  { fetchedAt, cycleType, provenance }
) {
  if (stationRow.source !== 'ecowitt') {
    throw new Error(`Pressure metadata is Ecowitt-only; ${stationRow.slug} is ${stationRow.source}.`);
  }
  if (!PRESSURE_PROVENANCE.has(provenance)) {
    throw new Error(`Invalid pressure provenance "${provenance}".`);
  }

  const { rows: dayRows } = await client.query(
    `SELECT pressure_provenance
       FROM station_days
      WHERE station_slug = $1 AND local_date = $2
      FOR UPDATE`,
    [stationRow.slug, isoDay(date)]
  );
  if (!dayRows.length) {
    throw new Error(`${stationRow.slug} ${isoDay(date)}: station day is missing during pressure metadata update.`);
  }
  if (provenance === 'retrospective' && dayRows[0].pressure_provenance === 'co-captured') {
    throw new Error(
      `${stationRow.slug} ${isoDay(date)}: refusing to relabel co-captured pressure as retrospective.`
    );
  }

  const { startSec, endSec } = dayBoundsEpoch(date);
  const { rows } = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (
         WHERE absolute_pressure_hpa IS NOT NULL OR relative_pressure_hpa IS NOT NULL
       )::int AS pressure_count,
       COUNT(*) FILTER (
         WHERE absolute_pressure_hpa IS NOT NULL AND relative_pressure_hpa IS NOT NULL
       )::int AS complete_count
     FROM observations
     WHERE station_slug = $1 AND ts >= to_timestamp($2) AND ts < to_timestamp($3)`,
    [stationRow.slug, startSec, endSec]
  );
  const { total, pressure_count: pressureCount, complete_count: completeCount } = rows[0];
  const status = pressureCount === 0
    ? 'no-data'
    : completeCount === total
      ? 'ok'
      : 'partial';

  const res = await client.query(
    `UPDATE station_days
        SET pressure_fetched_at = $3,
            pressure_cycle_type = $4,
            pressure_point_count = $5,
            pressure_status = $6,
            pressure_provenance = $7
      WHERE station_slug = $1 AND local_date = $2`,
    [
      stationRow.slug,
      isoDay(date),
      fetchedAt,
      cycleType ?? null,
      pressureCount,
      status,
      provenance,
    ]
  );
  if (res.rowCount !== 1) throw new Error(`${stationRow.slug} ${isoDay(date)}: pressure metadata update failed.`);
  return { total, pressureCount, completeCount, status };
}

/** point_count is recomputed from actual rows, never trusted from the caller. */
async function countObservations(client, stationRow, date) {
  const { startSec, endSec } = dayBoundsEpoch(date);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM observations
      WHERE station_slug = $1 AND ts >= to_timestamp($2) AND ts < to_timestamp($3)`,
    [stationRow.slug, startSec, endSec]
  );
  return rows[0].n;
}

async function replaceDayNeon(stationRow, record) {
  return withTransaction(async (client) => {
    const { startSec, endSec } = dayBoundsEpoch(record.date);
    await client.query(
      `DELETE FROM observations
        WHERE station_slug = $1 AND ts >= to_timestamp($2) AND ts < to_timestamp($3)`,
      [stationRow.slug, startSec, endSec]
    );
    await insertObservations(client, stationRow, record.date, record.points ?? [], {
      onConflict: 'replace',
    });
    const n = await countObservations(client, stationRow, record.date);
    await upsertDayRow(client, stationRow, record, n);
    const pressure = stationRow.source === 'ecowitt' && record.pressure_fetched_at
      ? await updatePressureDayMetadata(client, stationRow, record.date, {
          fetchedAt: record.pressure_fetched_at,
          cycleType: record.pressure_cycle_type,
          provenance: record.pressure_provenance,
        })
      : null;
    return { pointCount: n, pressure };
  });
}

async function mergeDayNeon(stationRow, record) {
  return withTransaction(async (client) => {
    const before = await countObservations(client, stationRow, record.date);
    await insertObservations(client, stationRow, record.date, record.points ?? [], {
      onConflict: 'keep',
    });
    const after = await countObservations(client, stationRow, record.date);
    await upsertDayRow(client, stationRow, record, after);
    return { pointCount: after, added: after - before };
  });
}

async function listDaysNeon(stationRow) {
  const { rows } = await query(
    'SELECT local_date FROM station_days WHERE station_slug = $1 ORDER BY local_date',
    [stationRow.slug]
  );
  return rows.map((r) => isoDay(r.local_date));
}

// ------------------------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------------------------

export async function readDay(slug, date) {
  const stationRow = await getStation(slug);
  return readDayNeon(stationRow, date);
}

/**
 * Bulk read. Reading 877 days one query at a time is an N+1 round trip to a remote database;
 * the consumers walk the whole archive, so give them one query instead.
 */
export async function readDays(slug, { from, to } = {}) {
  const stationRow = await getStation(slug);

  const clauses = ['station_slug = $1'];
  const params = [stationRow.slug];
  if (from) clauses.push(`local_date >= $${params.push(from)}`);
  if (to) clauses.push(`local_date <= $${params.push(to)}`);

  const { rows: dayRows } = await query(
    `SELECT * FROM station_days WHERE ${clauses.join(' AND ')} ORDER BY local_date`,
    params
  );
  if (!dayRows.length) return [];

  const { rows: obsRows } = await query(
    `SELECT *, (ts AT TIME ZONE '${STATION_TZ}')::date AS local_date
       FROM observations
      WHERE station_slug = $1
        AND (ts AT TIME ZONE '${STATION_TZ}')::date >= $2
        AND (ts AT TIME ZONE '${STATION_TZ}')::date <= $3
      ORDER BY ts`,
    [
      stationRow.slug,
      isoDay(dayRows[0].local_date),
      isoDay(dayRows[dayRows.length - 1].local_date),
    ]
  );

  const byDay = new Map();
  for (const r of obsRows) {
    const key = isoDay(r.local_date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(buildPoint(r, stationRow.source));
  }

  return dayRows.map((d) =>
    buildRecord(stationRow, d, byDay.get(isoDay(d.local_date)) ?? [])
  );
}

/**
 * Ecowitt semantics: the day is replaced wholesale.
 *
 * @returns {Promise<{pointCount: number}>} pointCount is recounted from the rows actually stored,
 *   never echoed back from the caller's record.
 * @throws if the write fails — see writeDay.
 */
export async function replaceDay(slug, record) {
  const stationRow = await getStation(slug);
  return writeDay(stationRow, record, replaceDayNeon);
}

/**
 * Holfuy semantics: union by timestamp, existing observations immutable.
 *
 * @returns {Promise<{pointCount: number, added: number}>} `added` is how many rows this fetch
 *   actually contributed, so a run that gained nothing is visible instead of assumed.
 * @throws if the write fails — see writeDay.
 */
export async function mergeDay(slug, record) {
  const stationRow = await getStation(slug);
  return writeDay(stationRow, record, mergeDayNeon);
}

/**
 * Days eligible for a retrospective Ecowitt pressure fill.
 *
 * Newest-first protects the still-fine part of Ecowitt's decaying history before old coarse days.
 */
export async function listPressureBackfillDays(slug, { from, to, force = false } = {}) {
  const stationRow = await getStation(slug);
  if (stationRow.source !== 'ecowitt') {
    throw new Error(`Pressure backfill is Ecowitt-only; ${slug} is ${stationRow.source}.`);
  }

  const clauses = [`station_slug = $1`, `status = 'ok'`];
  const params = [stationRow.slug];
  if (from) clauses.push(`local_date >= $${params.push(from)}`);
  if (to) clauses.push(`local_date <= $${params.push(to)}`);
  if (force) {
    clauses.push(`pressure_provenance IS DISTINCT FROM 'co-captured'`);
  } else {
    clauses.push('pressure_fetched_at IS NULL');
  }

  const { rows } = await query(
    `SELECT local_date
       FROM station_days
      WHERE ${clauses.join(' AND ')}
      ORDER BY local_date DESC`,
    params
  );
  return rows.map((r) => isoDay(r.local_date));
}

/**
 * Fill missing pressure values on existing observations without changing any original reading.
 *
 * The UPDATE is column-level fill-only, so a retry cannot replace already-captured pressure with a
 * changed or coarser value. Pressure timestamps without an existing wind observation are counted
 * but never inserted because the observation contract requires wind.
 */
export async function enrichObservationPressure(
  slug,
  date,
  points,
  { fetchedAt, cycleType, provenance = 'retrospective' }
) {
  const stationRow = await getStation(slug);
  if (stationRow.source !== 'ecowitt') {
    throw new Error(`Pressure enrichment is Ecowitt-only; ${slug} is ${stationRow.source}.`);
  }

  const day = isoDay(date);
  const { startSec, endSec } = dayBoundsEpoch(day);
  const incoming = points.filter(
    (p) => Number.isFinite(p.absolute_pressure_hpa) || Number.isFinite(p.relative_pressure_hpa)
  );
  for (const p of incoming) {
    if (!Number.isFinite(p.ts) || p.ts < startSec || p.ts >= endSec) {
      throw new Error(
        `${stationRow.slug} ${day}: pressure ts=${p.ts} falls outside the station-local day ` +
          `[${startSec}, ${endSec}).`
      );
    }
  }

  return withTransaction(async (client) => {
    let matched = 0;
    let updated = 0;

    if (incoming.length) {
      const params = [];
      const values = incoming.map((p, i) => {
        const b = i * 3;
        params.push(p.ts, p.absolute_pressure_hpa ?? null, p.relative_pressure_hpa ?? null);
        return `(to_timestamp($${b + 1}), $${b + 2}::numeric, $${b + 3}::numeric)`;
      });
      const stationParam = params.push(stationRow.slug);
      const incomingCte =
        `WITH incoming(ts, absolute_pressure_hpa, relative_pressure_hpa) AS ` +
        `(VALUES ${values.join(', ')})`;

      const matchRes = await client.query(
        `${incomingCte}
         SELECT COUNT(*)::int AS n
           FROM observations o
           JOIN incoming i ON o.ts = i.ts
          WHERE o.station_slug = $${stationParam}`,
        params
      );
      matched = matchRes.rows[0].n;

      const updateRes = await client.query(
        `${incomingCte}
         UPDATE observations o
            SET absolute_pressure_hpa =
                  COALESCE(o.absolute_pressure_hpa, i.absolute_pressure_hpa),
                relative_pressure_hpa =
                  COALESCE(o.relative_pressure_hpa, i.relative_pressure_hpa)
           FROM incoming i
          WHERE o.station_slug = $${stationParam}
            AND o.ts = i.ts
            AND (
              (o.absolute_pressure_hpa IS NULL AND i.absolute_pressure_hpa IS NOT NULL)
              OR
              (o.relative_pressure_hpa IS NULL AND i.relative_pressure_hpa IS NOT NULL)
            )`,
        params
      );
      updated = updateRes.rowCount;
    }

    const metadata = await updatePressureDayMetadata(client, stationRow, day, {
      fetchedAt,
      cycleType,
      provenance,
    });
    return {
      received: incoming.length,
      matched,
      unmatched: incoming.length - matched,
      updated,
      ...metadata,
    };
  });
}

/**
 * The single write path. It THROWS on failure.
 *
 * This is the inversion the migration turned on. While a JSON file on disk had already captured
 * the day, a database error was genuinely non-fatal and was returned as `neonError` for the
 * caller to report (exit 3, "degraded") while reconcile-archive.mjs repaired the replica later
 * from the files. That contract depended entirely on the second copy existing.
 *
 * Neon is now the only copy, and the upstream sources will not serve these observations again.
 * A swallowed error would therefore be permanent, silent data loss dressed up as a successful
 * run, so failure must be impossible to ignore. Callers must not catch-and-continue.
 */
async function writeDay(stationRow, record, neonWriter) {
  return neonWriter(stationRow, record);
}

export async function listDays(slug) {
  const stationRow = await getStation(slug);
  return listDaysNeon(stationRow);
}

/**
 * Bulk fetch of every archived day's `fetched_at`, keyed by ISO day string.
 *
 * Same reasoning as readDays: completeness checks are an N+1 against a remote database. isComplete
 * is readDay underneath — 2 queries plus up to 288 observation rows per candidate day, every one
 * of which is discarded except `fetched_at`. A full re-backfill from 2025-06-01 is ~1300 days, so
 * ~2600 round trips hauling ~370k rows purely to decide "skip". Callers prefetch this once per
 * station and evaluate completeness locally against dayBoundsEpoch().
 *
 * @param {string} slug
 * @returns {Promise<Map<string, Date>>} ISO day ("YYYY-MM-DD") -> fetched_at
 */
export async function fetchedAtMap(slug) {
  const stationRow = await getStation(slug);
  const { rows } = await query(
    'SELECT local_date, fetched_at FROM station_days WHERE station_slug = $1',
    [stationRow.slug]
  );
  return new Map(rows.map((r) => [isoDay(r.local_date), r.fetched_at]));
}

/**
 * Is an already-archived day actually finished?
 *
 * Mirrors archive-ecowitt.mjs: a run during the day writes a partial record, so completeness is
 * judged by whether the fetch happened after the local day ended, not by whether the day merely
 * exists. Uses the same DST-aware end bound as everything else.
 */
export async function isComplete(slug, date) {
  const rec = await readDay(slug, date);
  if (!rec || !rec.fetched_at) return false;
  const { endSec } = dayBoundsEpoch(date);
  return new Date(rec.fetched_at).getTime() >= endSec * 1000;
}

export { closePool };
