/**
 * Neon connection for the katabatic research archive.
 *
 * Deliberately mirrors the ECOWITT_RESEARCH_* credential guard in lib/ecowitt.mjs: a missing
 * or broken credential fails loudly and actionably rather than silently falling back to another
 * store. A silent fallback here would look like a working run that wrote nothing.
 */

import pg from 'pg';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '..', '.env') });

/**
 * numeric(4,1) arrives from pg as a string, because JS floats cannot represent every numeric
 * exactly. The archive's values all fit in a double safely (one decimal place, |v| < 1100), and
 * the record contract says points carry numbers, so parse them back.
 *
 * Without this the parity checksum fails on every single row: "10.5" !== 10.5.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

/** int8 (count(*)) also arrives as a string for the same reason. Counts here are tiny. */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let pool;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Missing NEON_DATABASE_URL.\n' +
        '  The katabatic archive store needs a Neon Postgres connection string in .env:\n' +
        '    NEON_DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require\n' +
        '  Use the POOLED connection string (host contains "-pooler"); the refresh spawns several\n' +
        '  child processes, each opening its own connections.'
    );
  }

  pool = new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run fn inside a transaction. A day is written all-or-nothing: a half-written day whose
 * point_count disagrees with its observations is exactly the kind of silent corruption the
 * parity gate exists to catch, so never let one escape in the first place.
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The rollback failing is not the interesting error; surface the original one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Must be called before a script exits, or node hangs with the pool open. katabatic-refresh.mjs
 * spawns these scripts as child processes and waits on them, so a leaked pool stalls the refresh.
 */
export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.end();
}
