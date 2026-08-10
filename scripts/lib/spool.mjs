/**
 * Archive spool — a transient on-disk outbox for days whose Neon write failed.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS IS NOT THE FILE BACKEND COMING BACK
 * ---------------------------------------------------------------------------------------------
 * The migration deletes the committed JSON archive on purpose, and it stays deleted. The two
 * things look superficially alike (JSON on disk) and are opposites in every way that mattered:
 *
 *   The FILE BACKEND was a second permanent store. It was committed to git, consulted on every
 *   read, and needed parity gates, a reconcile script and an exporter to keep two copies of the
 *   truth agreeing with each other. That machinery — and the git churn, and the "which copy is
 *   right?" question — is what we are getting rid of.
 *
 *   The SPOOL is a failure queue. It is gitignored, it is written ONLY after a Neon write has
 *   already failed, it is drained and deleted at the start of the next run, and nothing ever
 *   reads from it to answer a question about the weather. It has no parity gate, no reconcile
 *   script, no read path. It is never a source of truth. It is an outbox.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT EXISTS AT ALL
 * ---------------------------------------------------------------------------------------------
 * Neon is now the only store, so a failed write is permanent loss rather than an inconvenience
 * a repair script can fix from the files later. The common systemic failures — dead database,
 * expired credential, no network — are caught by the pre-flight liveness probe in the archivers,
 * BEFORE the perishable upstream fetch is spent. That probe cannot catch the narrow case this
 * module exists for: Neon dying part-way through a run, when the irreplaceable data is already
 * in memory and the upstream window has effectively been consumed.
 *
 * Holfuy publishes a ~5.9-day rolling window with no backfill, so the cost of dropping that
 * in-memory record is a day that never comes back. Spilling it to disk costs nothing and buys
 * the operator roughly five days to notice and re-run.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MODE IS PART OF THE DATA, NOT A CALLER CONVENTION
 * ---------------------------------------------------------------------------------------------
 * Every entry persists the write mode alongside the record, and a drain dispatches on the
 * PERSISTED mode rather than on whoever happens to be running the drain. Replaying a day through
 * the wrong operation corrupts it in exactly the ways `archive-store.mjs` warns about:
 *
 *   A `replace` (Ecowitt) record replayed as a merge leaves ghost observations from an earlier
 *   fetch that the refetch no longer contains — and a day re-fetched as `unobserved` would keep
 *   its old points, which is the "dark day reported as calm" failure this project forbids.
 *
 *   A `merge` (Holfuy) record replayed as a replace deletes the day's bounded range first, which
 *   throws away the 1-minute rows a day was first seen at in favour of the 15-minute rows the
 *   rolling window has since thinned to. That resolution is unrecoverable.
 *
 * Both underlying operations are idempotent (`replaceDay` is delete-then-insert over a bounded
 * day range, `mergeDay` is ON CONFLICT DO NOTHING, both inside a transaction), so replaying an
 * entry whose write actually committed but whose acknowledgement was lost is harmless. That is
 * why an entry is deleted only AFTER its handler resolves: a spurious replay is free, a
 * prematurely deleted entry is not.
 *
 * ---------------------------------------------------------------------------------------------
 * A SILENT SPOOL IS THE SAME DATA LOSS WITH EXTRA STEPS
 * ---------------------------------------------------------------------------------------------
 * A spool that fills up and never drains hides the loss instead of preventing it. Everything
 * here is built so the caller can shout: `spoolCount()` is cheap enough to call unconditionally
 * at startup, and `spoolReport()` returns a pre-formatted, deadline-bearing message because
 * "re-run before 2026-08-14 or these days are gone forever" is actionable and "write failed" is
 * not.
 *
 * No database coupling on purpose: handlers are injected by the caller (the archivers pass
 * `replaceDay` / `mergeDay` from `./archive-store.mjs`), which keeps this module testable with
 * fake in-memory handlers and free of a connection it might not be able to open.
 *
 * Usage from an archiver:
 *
 *   import { spoolCount, spoolDrain, spoolWrite, spoolReport } from './lib/spool.mjs';
 *   import { replaceDay, mergeDay } from './lib/archive-store.mjs';
 *
 *   if (await spoolCount() > 0) {
 *     console.warn((await spoolReport()).message);
 *     const drain = await spoolDrain({ replace: replaceDay, merge: mergeDay });
 *     if (drain.failed.length) process.exitCode = 1;
 *   }
 *   ...
 *   catch (err) { await spoolWrite(slug, 'merge', record); }
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** Gitignored. Lives at the repo root so a human can see it without hunting. */
export const SPOOL_DIR = join(REPO_ROOT, '.archive-spool');

/** The only two write semantics the archive has. See the header for why mixing them corrupts. */
export const SPOOL_MODES = Object.freeze(['replace', 'merge']);

/**
 * Holfuy's public feed exposes a rolling window measured at ~5.9 days with no backfill. This is
 * the tightest deadline in the system, so it is the one the warnings quote — an Ecowitt day is
 * recoverable for ~90 days, and a message tuned to the forgiving source would understate the
 * urgency of the unforgiving one.
 */
export const PERISHABLE_WINDOW_DAYS = 5.9;

const ENTRY_VERSION = 1;
const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function entryFilename(slug, date, mode) {
  return `${slug}__${date}__${mode}.json`;
}

/**
 * Filenames are the dedup key (slug + date + mode), so a slug containing a separator or a path
 * traversal would silently collide with — or escape — another entry's file. Refuse rather than
 * sanitise: a mangled slug that still writes would replay against the wrong station.
 */
function assertSlug(slug) {
  if (typeof slug !== 'string' || !SAFE_SLUG.test(slug)) {
    throw new TypeError(`spool: invalid station slug ${JSON.stringify(slug)}`);
  }
  return slug;
}

function assertMode(mode) {
  if (!SPOOL_MODES.includes(mode)) {
    throw new TypeError(
      `spool: mode must be 'replace' or 'merge', got ${JSON.stringify(mode)} — ` +
        'the wrong mode on replay corrupts the day'
    );
  }
  return mode;
}

function assertRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('spool: record must be an archive day object');
  }
  if (!ISO_DATE.test(record.date ?? '')) {
    throw new TypeError(
      `spool: record.date must be YYYY-MM-DD, got ${JSON.stringify(record.date)}`
    );
  }
  return record;
}

/** ISO date of the day this entry stops being re-fetchable from the unforgiving upstream. */
function deadlineFor(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + PERISHABLE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
}

async function listEntryFiles() {
  let names;
  try {
    names = await readdir(SPOOL_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // `.tmp-*` files are in-flight atomic writes, not entries.
  return names.filter((n) => n.endsWith('.json') && !n.startsWith('.tmp-')).sort();
}

/**
 * Persist a day whose Neon write failed.
 *
 * Written temp-file-then-rename because the alternative is a truncated JSON file sitting where
 * irreplaceable data is supposed to be — an interrupted write that leaves a half-entry is
 * indistinguishable, at drain time, from data we never had.
 *
 * @param {string} slug   station slug, e.g. 'lookout-mtn'
 * @param {'replace'|'merge'} mode  write semantics, persisted with the record
 * @param {object} record archive day record (must carry an ISO `date`)
 * @returns {Promise<{path: string, file: string, slug: string, mode: string, date: string,
 *                    spooled_at: string, deadline: string|null}>}
 * @throws {TypeError} on an unsafe slug, an unknown mode, or a record without an ISO date
 */
export async function spoolWrite(slug, mode, record) {
  assertSlug(slug);
  assertMode(mode);
  assertRecord(record);

  const spooledAt = new Date().toISOString();
  const entry = {
    version: ENTRY_VERSION,
    slug,
    mode,
    date: record.date,
    spooled_at: spooledAt,
    record,
  };

  await mkdir(SPOOL_DIR, { recursive: true });
  const file = entryFilename(slug, record.date, mode);
  const finalPath = join(SPOOL_DIR, file);
  const tmpPath = join(SPOOL_DIR, `.tmp-${randomBytes(6).toString('hex')}-${file}`);

  await writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return {
    path: finalPath,
    file,
    slug,
    mode,
    date: record.date,
    spooled_at: spooledAt,
    deadline: deadlineFor(record.date),
  };
}

/**
 * How many entries are pending. Cheap (a single readdir, no parsing) so an archiver can call it
 * unconditionally at startup to decide whether to shout.
 *
 * @returns {Promise<number>}
 */
export async function spoolCount() {
  return (await listEntryFiles()).length;
}

/**
 * The pending entries, oldest day first — the oldest day is the closest to falling out of the
 * upstream window, so it is the one worth replaying first if a drain is going to be cut short.
 *
 * A file that will not parse is returned with `corrupt: true` and a null record rather than
 * being skipped or deleted. Dropping it would be a silent loss of exactly the data this module
 * exists to protect; a human has to look at it.
 *
 * @returns {Promise<Array<{file: string, path: string, slug: string|null, mode: string|null,
 *                          date: string|null, spooled_at: string|null, record: object|null,
 *                          deadline: string|null, corrupt: boolean, error: string|null}>>}
 */
export async function spoolList() {
  const files = await listEntryFiles();
  const entries = [];

  for (const file of files) {
    const path = join(SPOOL_DIR, file);
    const base = {
      file,
      path,
      slug: null,
      mode: null,
      date: null,
      spooled_at: null,
      record: null,
      deadline: null,
      corrupt: false,
      error: null,
    };
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('entry is not an object');
      assertSlug(parsed.slug);
      assertMode(parsed.mode);
      assertRecord(parsed.record);
      entries.push({
        ...base,
        slug: parsed.slug,
        mode: parsed.mode,
        date: parsed.record.date,
        spooled_at: parsed.spooled_at ?? null,
        record: parsed.record,
        deadline: deadlineFor(parsed.record.date),
      });
    } catch (err) {
      entries.push({ ...base, corrupt: true, error: err.message });
    }
  }

  entries.sort((a, b) => (a.date ?? '9999-99-99').localeCompare(b.date ?? '9999-99-99'));
  return entries;
}

/**
 * A report a caller can print verbatim. Returns `count: 0` and a null message when the spool is
 * empty, so the happy path stays quiet.
 *
 * The message quotes a concrete date rather than a generic complaint because the operator's only
 * decision is "do I have to re-run this today?", and only the deadline answers that.
 *
 * @returns {Promise<{count: number, corruptCount: number, oldestDate: string|null,
 *                    deadline: string|null, entries: object[], message: string|null}>}
 */
export async function spoolReport() {
  const entries = await spoolList();
  if (entries.length === 0) {
    return { count: 0, corruptCount: 0, oldestDate: null, deadline: null, entries, message: null };
  }

  const dated = entries.filter((e) => e.date);
  const oldestDate = dated.length ? dated[0].date : null;
  const deadline = oldestDate ? deadlineFor(oldestDate) : null;
  const corrupt = entries.filter((e) => e.corrupt);

  const lines = [
    `!! ARCHIVE SPOOL NOT EMPTY: ${entries.length} day(s) failed to reach Neon and are ` +
      'sitting on disk, NOT in the database.',
  ];
  for (const e of entries) {
    lines.push(
      e.corrupt
        ? `   - ${e.file} — UNREADABLE (${e.error}); inspect by hand, do not delete`
        : `   - ${e.slug} ${e.date} (${e.mode}) — re-fetchable upstream until ~${e.deadline}`
    );
  }
  if (deadline) {
    lines.push(
      `   Re-run the archiver before ${deadline} or the oldest of these days is gone forever ` +
        `(Holfuy publishes a ~${PERISHABLE_WINDOW_DAYS}-day window with no backfill).`
    );
  }
  if (corrupt.length) {
    lines.push(
      `   ${corrupt.length} entr(y/ies) could not be parsed and will NOT replay automatically.`
    );
  }

  return {
    count: entries.length,
    corruptCount: corrupt.length,
    oldestDate,
    deadline,
    entries,
    message: lines.join('\n'),
  };
}

/**
 * Replay every pending entry through the caller's handlers and delete the ones that land.
 *
 * `handlers` is `{ replace, merge }` — normally `replaceDay` / `mergeDay` from
 * `./archive-store.mjs`. Each is called as `handler(slug, record)`. Dispatch is on the mode
 * PERSISTED in the entry, never on the caller's context, so an Ecowitt run draining a Holfuy
 * entry still replays it as a merge.
 *
 * The entry file is unlinked only after its handler resolves. A drain therefore never loses a
 * day it could not write: a thrown handler leaves that file exactly where it was, the remaining
 * entries are still attempted, and the failure is reported for the caller to shout about.
 *
 * @param {{replace?: Function, merge?: Function}} handlers
 * @returns {Promise<{attempted: number, drained: Array<{slug,mode,date,file,result}>,
 *                    failed: Array<{slug,mode,date,file,error,deadline}>,
 *                    corrupt: Array<{file,path,error}>, remaining: number}>}
 * @throws {TypeError} if `handlers` is missing or neither handler is a function
 */
export async function spoolDrain(handlers) {
  if (!handlers || typeof handlers !== 'object') {
    throw new TypeError('spoolDrain: handlers must be { replace, merge }');
  }
  if (typeof handlers.replace !== 'function' && typeof handlers.merge !== 'function') {
    throw new TypeError('spoolDrain: at least one of handlers.replace / handlers.merge required');
  }

  const entries = await spoolList();
  const drained = [];
  const failed = [];
  const corrupt = [];

  for (const entry of entries) {
    if (entry.corrupt) {
      corrupt.push({ file: entry.file, path: entry.path, error: entry.error });
      continue;
    }

    const handler = handlers[entry.mode];
    const describe = {
      slug: entry.slug,
      mode: entry.mode,
      date: entry.date,
      file: entry.file,
      deadline: entry.deadline,
    };

    if (typeof handler !== 'function') {
      // Missing handler is a caller bug, not a reason to drop the day or to guess a mode.
      failed.push({
        ...describe,
        error: `no handler supplied for mode '${entry.mode}'`,
      });
      continue;
    }

    try {
      const result = await handler(entry.slug, entry.record);
      await unlink(entry.path);
      drained.push({ ...describe, result });
    } catch (err) {
      failed.push({ ...describe, error: err?.message ?? String(err) });
    }
  }

  return {
    attempted: entries.length,
    drained,
    failed,
    corrupt,
    remaining: await spoolCount(),
  };
}
