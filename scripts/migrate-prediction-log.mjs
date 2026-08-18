#!/usr/bin/env node

/**
 * One-time migration for research/prediction-log.csv: adds the feature_version / rule_version /
 * label_version columns (scripts/lib/versions.mjs) to every existing row and fixes the
 * double-newline defect in the live-appended rows (scripts/lib/prediction-log-store.mjs docs the
 * bug this repairs).
 *
 * Tagging rule for rows written before these columns existed:
 *   - source=backtest, source=retrospective  → features-v1 / call-rule-v1 (the only rule that
 *     existed when these were written, and their column shape matches its output exactly).
 *   - source=live                            → legacy / legacy (the live script had its own,
 *     separately-drifted feature calculation — see call-rule-v2.mjs header — so these rows are
 *     NOT assumed comparable to features-v1, even though the label itself hasn't changed).
 *   - label_version is label-v1 for every row: the label definition (scripts/lib/label.mjs) has
 *     not changed as part of this work.
 *
 * Idempotent: rows that already carry a feature_version are left untouched.
 *
 * Usage: node scripts/migrate-prediction-log.mjs [path]
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT } from './lib/ecowitt.mjs';
import { LOG_COLUMNS, csvHeader, toCsvRow } from './lib/prediction-log.mjs';
import { FEATURE_VERSION_V1, RULE_VERSION_V1, LABEL_VERSION_V1, LEGACY_VERSION } from './lib/versions.mjs';
import { readAllRows } from './lib/prediction-log-store.mjs';

const DEFAULT_PATH = join(REPO_ROOT, 'research', 'prediction-log.csv');

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse with whatever header the file actually has — may be the pre-migration column set. */
function parseWithOwnHeader(text) {
  const lines = text.split('\n').filter((l) => l.trim().length);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] === '' || cells[i] === undefined ? null : cells[i];
    });
    return row;
  });
}

function tagVersions(row) {
  if (row.feature_version) return row; // Already migrated.
  const isV1Shaped = row.source === 'backtest' || row.source === 'retrospective';
  return {
    ...row,
    feature_version: isV1Shaped ? FEATURE_VERSION_V1 : LEGACY_VERSION,
    rule_version: isV1Shaped ? RULE_VERSION_V1 : LEGACY_VERSION,
    label_version: LABEL_VERSION_V1,
  };
}

async function main() {
  const path = process.argv[2] || DEFAULT_PATH;
  const raw = await readFile(path, 'utf8');
  const rows = parseWithOwnHeader(raw).map(tagVersions);

  // Ensure every LOG_COLUMNS key exists on every row (missing = null), so toCsvRow doesn't emit
  // literal "undefined".
  const complete = rows.map((r) => {
    const out = {};
    for (const c of LOG_COLUMNS) out[c] = r[c] === undefined ? null : r[c];
    return out;
  });

  // A full replacement, NOT an upsert-by-key merge: this run's whole job is to change every
  // existing row's shape (adding the version columns), so the "before" content on disk and the
  // "after" content being written describe the SAME rows under a different key. Merging them by
  // `rowKey` (which now includes `rule_version`) would treat the old, unversioned row and its
  // newly-tagged replacement as two distinct rows and silently duplicate the entire file — this
  // was caught by inspecting the output of the first migration attempt, which doubled every row.
  const before = await readAllRows(path).catch(() => []);
  const alreadyMigrated = before.length && before[0].feature_version;
  if (alreadyMigrated) {
    console.log('Already migrated (feature_version present on existing rows) — nothing to do.');
    return;
  }

  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, csvHeader() + complete.map(toCsvRow).join(''));
  await rename(tmpPath, path);
  const bySource = {};
  for (const r of complete) bySource[r.source] = (bySource[r.source] || 0) + 1;
  console.log(`Migrated ${complete.length} row(s): ${JSON.stringify(bySource)}`);
}

main().catch((err) => {
  console.error(`❌ Migration failed: ${err.stack}`);
  process.exit(1);
});
