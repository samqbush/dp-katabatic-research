#!/usr/bin/env node

import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { closePool, readDays } from './lib/archive-store.mjs';
import { renderStationHistoryCsv, stationHistoryRows } from './lib/station-history-csv.mjs';
import { SODA_SLUG, stationBySlugOrName } from './lib/stations.mjs';
import { todayAtStation } from './lib/zone.mjs';

function isoDay(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseArgs(argv) {
  const args = { station: SODA_SLUG, from: null, to: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--station' && next) args.station = next;
    if (argv[i] === '--from' && next) args.from = next;
    if (argv[i] === '--to' && next) args.to = next;
    if (argv[i] === '--out' && next) args.out = next;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const station = stationBySlugOrName(args.station);
  const days = await readDays(station.slug, { from: args.from, to: args.to });
  if (!days.length) throw new Error(`No archived days found for ${station.name}.`);

  const output = resolve(
    args.out || `${station.slug.replace(/^dp-/, '')}-history-${isoDay(todayAtStation())}.csv`
  );
  const csv = renderStationHistoryCsv(days);
  await writeFile(output, csv, 'utf8');

  const rows = stationHistoryRows(days);
  const observationRows = rows.filter((row) => row.observation_epoch_seconds !== undefined);
  const metadataOnlyRows = rows.length - observationRows.length;
  console.log(`Created ${output}`);
  console.log(
    `${observationRows.length} observations and ${metadataOnlyRows} metadata-only day row(s), ` +
      `${days[0].date} through ${days[days.length - 1].date}`
  );
}

main()
  .catch((err) => {
    console.error(`History export failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(closePool);

