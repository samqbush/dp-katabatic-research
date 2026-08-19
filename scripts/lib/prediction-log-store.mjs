/**
 * Atomic, deduplicating storage for the prediction log CSV.
 *
 * WHY THIS EXISTS: the previous writer (`appendFileSync` in the live skill script) had two real
 * defects, both found while implementing this file:
 *
 *   1. It double-appended a newline on top of what `toCsvRow`/`csvHeader` already include,
 *      producing a blank row after every header and every live-logged call. Confirmed present in
 *      the checked-in `research/prediction-log.csv`.
 *   2. An exact retry of a call appended a duplicate row rather than replacing the earlier one.
 *
 * This module fixes both: it upserts by key rather than appending, and it writes the whole file
 * atomically (temp file + rename) under a simple directory-based lock, so two writers running
 * near-simultaneously (a manual check plus the cron job, say) cannot interleave and corrupt the
 * file. This is a single local user's machine, not a multi-writer server, so the lock is
 * deliberately simple: a short retry loop, not a distributed lock service.
 */

import { readFile, rename, writeFile, mkdir, rmdir } from 'fs/promises';
import { existsSync } from 'fs';
import { csvHeader, toCsvRow, parseCsv, LOG_COLUMNS } from './prediction-log.mjs';

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5000;

/**
 * The identity of a "call" for upsert purposes: one row per (source, date, call_time, station,
 * rule_version). Live call times include seconds, so separate checks in one minute remain separate
 * evidence while an exact retry replaces in place. Including `rule_version` keeps paired backtest
 * rows distinct (§ pairing requirement).
 */
export function rowKey(row) {
  return [row.source, row.date, row.call_time, row.station, row.rule_version].join('|');
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lockPath} — a previous writer may have crashed; remove it manually if so.`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

async function releaseLock(lockPath) {
  await rmdir(lockPath).catch(() => {});
}

/** Read every row currently in the log, as plain objects (parseCsv's null-preserving parse). */
export async function readAllRows(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return parseCsv(text);
}

/**
 * Write the full row set atomically: a temp file in the same directory, then a rename, which is
 * atomic on the same filesystem. A crash mid-write leaves either the old file or the new one
 * intact, never a half-written one.
 */
async function writeAllAtomic(path, rows) {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = csvHeader() + rows.map(toCsvRow).join('');
  await writeFile(tmpPath, body);
  await rename(tmpPath, path);
}

/**
 * Insert or replace rows by `rowKey`, then rewrite the file atomically under a lock.
 *
 * @param path Prediction log CSV path.
 * @param newRows Array of row objects (as produced by `buildLogRow`) to upsert.
 * @returns { written, replaced } counts.
 */
export async function upsertRows(path, newRows) {
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);
  try {
    const existing = await readAllRows(path);
    const byKey = new Map(existing.map((r) => [rowKey(r), r]));
    let replaced = 0;
    for (const row of newRows) {
      const key = rowKey(row);
      if (byKey.has(key)) replaced++;
      byKey.set(key, row);
    }
    // Stable, human-scannable order: chronological, then call time, then source so paired rule
    // versions for the same morning sit next to each other.
    const all = [...byKey.values()].sort((a, b) => {
      const ad = String(a.date), bd = String(b.date);
      if (ad !== bd) return ad < bd ? -1 : 1;
      const at = String(a.call_time ?? ''), bt = String(b.call_time ?? '');
      if (at !== bt) return at < bt ? -1 : 1;
      const as = String(a.source ?? ''), bs = String(b.source ?? '');
      if (as !== bs) return as < bs ? -1 : 1;
      return String(a.rule_version ?? '') < String(b.rule_version ?? '') ? -1 : 1;
    });
    await writeAllAtomic(path, all);
    return { written: newRows.length, replaced, total: all.length };
  } finally {
    await releaseLock(lockPath);
  }
}

/** Convenience for a single row (the live skill's common case). */
export async function upsertRow(path, row) {
  return upsertRows(path, [row]);
}

export { LOG_COLUMNS };
