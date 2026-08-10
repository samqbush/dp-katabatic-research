#!/usr/bin/env node
/**
 * Apply scripts/db/schema.sql to the Neon database.
 *
 * Idempotent: every statement is CREATE ... IF NOT EXISTS or an upsert, so it is safe to re-run.
 *
 * Usage:
 *   node scripts/db/apply-schema.mjs
 *   node scripts/db/apply-schema.mjs --dry-run    # print the SQL, connect to nothing
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query, closePool } from '../lib/db.mjs';
import { STATIONS, requireEcowittMac } from '../lib/stations.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

async function main() {
  const sql = await readFile(SCHEMA_PATH, 'utf8');

  if (process.argv.includes('--dry-run')) {
    console.log(sql);
    return;
  }

  console.log('Applying schema to Neon...');
  await query(sql);

  // Seed from the code registry so stations.mjs is the only source of truth.
  //
  // MACs come from the environment (this repo is public), and the stations CHECK constraint
  // requires one for every Ecowitt station. Without this guard a missing variable surfaces as a
  // constraint violation naming a column, which says nothing about the variable to set.
  for (const s of STATIONS) {
    if (s.source === 'ecowitt') requireEcowittMac(s.slug);
  }

  for (const s of STATIONS) {
    await query(
      `INSERT INTO stations (slug, name, source, ecowitt_mac, holfuy_id, lat, lon)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, source = EXCLUDED.source,
         ecowitt_mac = EXCLUDED.ecowitt_mac, holfuy_id = EXCLUDED.holfuy_id,
         lat = EXCLUDED.lat, lon = EXCLUDED.lon`,
      [s.slug, s.name, s.source, s.ecowitt_mac, s.holfuy_id, s.lat, s.lon]
    );
  }

  const { rows: tables } = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  );
  const { rows: stations } = await query(
    'SELECT slug, source FROM stations ORDER BY source, slug'
  );

  console.log(`\n✅ Tables: ${tables.map((t) => t.table_name).join(', ')}`);
  console.log('✅ Stations seeded:');
  for (const s of stations) console.log(`   ${s.source.padEnd(8)} ${s.slug}`);
}

main()
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
