#!/usr/bin/env node

/**
 * pg_dump the katabatic archive out of Neon and onto this machine.
 *
 * Why this exists: the archive is now Neon-only. The committed JSON copies under data/ are gone,
 * and the upstream data cannot be re-fetched — Holfuy publishes a ~5.9-day rolling window with no
 * backfill, and Ecowitt decays 5-minute history to 30-minute averages past ~90 days. So a dropped
 * table, a lapsed free-tier project, or a bad migration is permanent loss, not an inconvenience.
 * This script is the second copy that makes those recoverable.
 *
 * The dump is pg_dump custom format (-Fc), which is what `pg_restore` consumes:
 *   pg_restore --clean --if-exists -d "$NEON_DATABASE_URL" <file>
 *
 * The version guard below is the whole reason this is a script and not a one-line npm alias.
 * pg_dump refuses to dump from a server newer than itself, and macOS Homebrew happily leaves a
 * years-old keg first on PATH: measured here on 2026-08-08, PATH pg_dump was 14.18 while Neon
 * was serving 18.4. Raw, that surfaces as "server version mismatch" with no hint that the fix is
 * a brew install — so this checks the majors up front and, failing that, goes looking for a
 * matching keg before giving up.
 *
 * Usage:
 *   node scripts/backup-archive.mjs                    # -> ~/dp-archive-backups/
 *   node scripts/backup-archive.mjs --out /Volumes/ext/dp-backups
 *   node scripts/backup-archive.mjs --pg-dump /opt/homebrew/opt/postgresql@18/bin/pg_dump
 *   node scripts/backup-archive.mjs --help
 */

import { spawn, execFile } from 'child_process';
import { mkdir, stat, unlink } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { promisify } from 'util';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { query, closePool } from './lib/db.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const DEFAULT_OUT_DIR = join(homedir(), 'dp-archive-backups');

const HELP = `
Backup the Neon katabatic archive to a local pg_dump custom-format file.

  node scripts/backup-archive.mjs [--out <dir>] [--pg-dump <path>]

  --out <dir>       Where to write the dump. Default: ${DEFAULT_OUT_DIR}
  --pg-dump <path>  Use a specific pg_dump binary instead of the one on PATH.
                    Also settable via the PG_DUMP environment variable.
  --help            Show this.

Requires NEON_DATABASE_URL in .env or the environment, and a pg_dump whose major
version is >= the Neon server's major version.

Restore with:
  pg_restore --clean --if-exists -d "$NEON_DATABASE_URL" <file>
`.trim();

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT_DIR, pgDump: process.env.PG_DUMP || null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    if (argv[i] === '--out') {
      if (!next) throw new Error('--out needs a directory path.');
      args.out = next;
    }
    if (argv[i] === '--pg-dump') {
      if (!next) throw new Error('--pg-dump needs a path to a pg_dump binary.');
      args.pgDump = next;
    }
  }
  return args;
}

function expandPath(p) {
  const expanded = p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/** "pg_dump (PostgreSQL) 18.4 (Homebrew)" -> 18 ; "18.4 (be2730e)" -> 18 */
function majorVersion(text) {
  const m = String(text).match(/(\d+)(?:\.\d+)*/);
  return m ? Number(m[1]) : null;
}

async function pgDumpVersion(binary) {
  const { stdout } = await execFileAsync(binary, ['--version']);
  const raw = stdout.trim();
  const major = majorVersion(raw.replace(/^pg_dump\s+\(PostgreSQL\)\s*/i, ''));
  if (major === null) throw new Error(`Could not parse a version out of "${raw}" (${binary}).`);
  return { raw, major };
}

/**
 * Where a package manager would have put a major-version-specific client. Checked only after the
 * PATH pg_dump turns out to be too old, so a correct PATH always wins.
 */
function candidateBinaries(major) {
  return [
    `/opt/homebrew/opt/postgresql@${major}/bin/pg_dump`, // Homebrew, Apple silicon
    `/usr/local/opt/postgresql@${major}/bin/pg_dump`, // Homebrew, Intel
    `/usr/lib/postgresql/${major}/bin/pg_dump`, // Debian/Ubuntu
    `/Applications/Postgres.app/Contents/Versions/${major}/bin/pg_dump`,
  ];
}

function upgradeInstructions(major) {
  return (
    `  Install a matching client and put it first on PATH:\n` +
    `    brew install postgresql@${major}\n` +
    `    export PATH="/opt/homebrew/opt/postgresql@${major}/bin:$PATH"\n` +
    `  Or point this script straight at it, no PATH surgery:\n` +
    `    node scripts/backup-archive.mjs --pg-dump /opt/homebrew/opt/postgresql@${major}/bin/pg_dump`
  );
}

/**
 * Connection details for the child process, as libpq PG* env vars rather than a URL argument —
 * argv is world-readable via `ps`, and the Neon password must not leak there.
 */
function connectionEnv(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(
      'NEON_DATABASE_URL is not a valid connection URL.\n' +
        '  Expected postgresql://user:password@host/database?sslmode=require'
    );
  }

  // Neon's pooled endpoint (host contains "-pooler") is PgBouncer in transaction mode, which does
  // not support the session-level machinery pg_dump relies on. The direct endpoint is the same
  // database, so just drop the suffix rather than making the caller keep two URLs around.
  const directHost = url.hostname.replace('-pooler', '');

  const env = {
    PGHOST: directHost,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'neondb',
    PGSSLMODE: url.searchParams.get('sslmode') || 'require',
  };
  const options = url.searchParams.get('options');
  if (options) env.PGOPTIONS = options;

  if (!env.PGUSER) throw new Error('NEON_DATABASE_URL has no username.');

  return { env, label: `${env.PGUSER}@${directHost}/${env.PGDATABASE}` };
}

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

async function resolvePgDump(requested, serverMajor) {
  if (requested) {
    let version;
    try {
      version = await pgDumpVersion(requested);
    } catch {
      throw new Error(
        `Cannot run pg_dump at "${requested}".\n` +
          '  Check the --pg-dump path (or PG_DUMP env var) points at a real pg_dump binary.'
      );
    }
    if (version.major < serverMajor) {
      throw new Error(
        `pg_dump at "${requested}" is version ${version.major}, but Neon is serving ` +
          `PostgreSQL ${serverMajor}.\n  pg_dump cannot dump from a newer server.\n` +
          upgradeInstructions(serverMajor)
      );
    }
    return { binary: requested, ...version };
  }

  let onPath = null;
  try {
    onPath = await pgDumpVersion('pg_dump');
  } catch {
    // Not installed, or not on this PATH. Either way, a keg may still be sitting there unlinked —
    // which is the normal state on macOS after `brew install postgresql@18` without `brew link`.
  }

  if (onPath && onPath.major >= serverMajor) return { binary: 'pg_dump', ...onPath };

  for (const candidate of candidateBinaries(serverMajor)) {
    try {
      const version = await pgDumpVersion(candidate);
      if (version.major >= serverMajor) {
        const why = onPath
          ? `pg_dump on PATH is ${onPath.major} (too old for server ${serverMajor})`
          : 'pg_dump is not on PATH';
        console.log(`ℹ️  ${why}; using ${candidate} instead.`);
        return { binary: candidate, ...version };
      }
    } catch {
      // Candidate is not installed on this machine; try the next one.
    }
  }

  if (!onPath) {
    throw new Error(
      'pg_dump is not installed, or not on PATH.\n' +
        `  Neon is serving PostgreSQL ${serverMajor}, so the client must be at least that major.\n` +
        upgradeInstructions(serverMajor)
    );
  }

  throw new Error(
    `pg_dump on PATH is version ${onPath.major} (${onPath.raw}), but Neon is serving ` +
      `PostgreSQL ${serverMajor}.\n` +
      '  pg_dump refuses to dump from a server newer than itself, and no matching client was\n' +
      `  found in the usual places.\n` +
      upgradeInstructions(serverMajor)
  );
}

function runPgDump(binary, outFile, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      binary,
      ['--format=custom', '--compress=9', '--no-owner', '--no-privileges', '--file', outFile],
      { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'pipe'] }
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => reject(new Error(`Could not run ${binary}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`pg_dump exited ${code}.\n${stderr.trim() || '(no stderr output)'}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const connectionString = process.env.NEON_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Missing NEON_DATABASE_URL.\n' +
        '  There is nothing to back up without it. Put the Neon connection string in .env:\n' +
        '    NEON_DATABASE_URL=postgresql://user:password@ep-xxx.region.aws.neon.tech/neondb?sslmode=require\n' +
        '  (or export it in this shell before running the backup).'
    );
  }

  const { env, label } = connectionEnv(connectionString);

  // Ask the server first: the version guard needs a number, not a guess.
  const { rows } = await query("SELECT current_setting('server_version') AS version");
  const serverRaw = rows[0]?.version;
  const serverMajor = majorVersion(serverRaw);
  if (!serverMajor) throw new Error(`Could not parse the Neon server version ("${serverRaw}").`);

  const pgDump = await resolvePgDump(args.pgDump, serverMajor);

  const outDir = expandPath(args.out);
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `dp-archive-${timestamp()}.dump`);

  console.log(`📦 Backing up ${label}`);
  console.log(`   server pg ${serverMajor}, client pg ${pgDump.major} (${pgDump.binary})`);
  console.log(`   -> ${outFile}`);

  try {
    await runPgDump(pgDump.binary, outFile, env);
  } catch (err) {
    // A failed dump leaves a truncated file behind, which is worse than no file: it looks like a
    // backup until the day someone tries to restore it.
    await unlink(outFile).catch(() => {});
    throw err;
  }

  const { size } = await stat(outFile);
  if (size === 0) {
    await unlink(outFile).catch(() => {});
    throw new Error('pg_dump succeeded but wrote an empty file. Refusing to keep it.');
  }

  console.log(`\n✅ ${outFile}`);
  console.log(`   ${humanSize(size)} (${size.toLocaleString()} bytes)`);
  console.log(`   Restore: pg_restore --clean --if-exists -d "$NEON_DATABASE_URL" ${outFile}`);
}

main()
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);
