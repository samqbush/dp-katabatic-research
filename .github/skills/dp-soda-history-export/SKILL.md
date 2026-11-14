---
name: dp-soda-history-export
description: >
  Export archived DP Soda Lakes weather-station history from the Neon research database to a
  shareable CSV. Use this skill whenever the user asks for a Soda Lake or Soda Lakes data dump,
  database extract, station history, raw wind observations, or a CSV to send to another person,
  including requests like "dump everything we have for Soda", "export August Soda data", "give
  me the Soda meter history", or "make a spreadsheet of the Soda archive." This skill creates
  the CSV only; do not draft or send email unless the user separately asks for that.
---

# DP Soda Lakes History Export

Create a read-only CSV from the archived Soda Lakes station data. The repository already owns the
database query and CSV schema in `scripts/export-station-history.mjs`; use that command rather than
querying Neon directly or inventing a second export format.

## Interpret the request

- Default to the complete archived history when the user does not provide dates.
- Treat `from` and `to` dates as inclusive Colorado-local calendar dates.
- Accept either one bound or both. Do not guess missing dates.
- Require dates in `YYYY-MM-DD` form and reject impossible calendar dates. When both bounds are
  present, require `from <= to` before querying the database.
- Export only `dp-soda-lakes`. If the user asks for another station, use the repository's generic
  exporter directly or the archive skill instead of silently changing this skill's scope.
- This is an export, not an archive refresh. Do not fetch Ecowitt, run `npm run refresh`, backfill
  data, or modify Neon. Handle any separate archive-maintenance request with
  `dp-katabatic-archive`.

## Choose the output path

Save to the user's Downloads folder by default so the file is easy to attach:

- Complete history: `~/Downloads/soda-lakes-history-YYYY-MM-DD.csv`
- Date range: `~/Downloads/soda-lakes-history-FROM-to-TO.csv`
- From only: `~/Downloads/soda-lakes-history-from-FROM.csv`
- Through only: `~/Downloads/soda-lakes-history-through-TO.csv`

Use the current date only as a filename generation date; it does not imply an archive cutoff.
If the user or an evaluation harness provides an explicit output directory or filename, use that
instead of Downloads.

Never overwrite an existing file. Add `-2`, `-3`, and so on before the `.csv` extension when the
intended path already exists, then continue without interrupting the export. Always pass
`--no-clobber` for atomic protection; if the exporter reports `EEXIST`, another export claimed the
path, so choose the next suffix and retry. Do not retry other errors as filename collisions.

## Run the supported exporter

The repository must have `NEON_DATABASE_URL` and `ECOWITT_MAC_DP_SODA_LAKES` configured in `.env`;
the archive reader currently requires the station identifier even for read-only exports. Do not
print, copy, or inspect either value; let the existing database layer report configuration errors
safely.

Run the complete-history export:

```bash
npm run export:history -- \
  --station dp-soda-lakes \
  --no-clobber \
  --out "/absolute/path/to/soda-lakes-history-YYYY-MM-DD.csv"
```

Add date bounds only when requested:

```bash
npm run export:history -- \
  --station dp-soda-lakes \
  --from YYYY-MM-DD \
  --to YYYY-MM-DD \
  --no-clobber \
  --out "/absolute/path/to/soda-lakes-history-FROM-to-TO.csv"
```

The exporter reads day metadata and observations from one consistent, read-only database snapshot.
The exporter fails loudly when the archive has no matching days. Preserve that behavior. Never
turn a failed or empty query into a success-shaped empty CSV.

## Verify the result

Before reporting success:

1. Confirm the command exited zero and printed `Created <path>`.
2. Confirm the file exists, is non-empty, and begins with the repository-owned header from
   `scripts/lib/station-history-csv.mjs`.
3. Confirm there is at least one data row after the header.
4. For a bounded request, verify every non-empty `local_date` value falls within the inclusive
   requested bounds.
5. Keep metadata-only rows for unobserved days. Blank observation fields are honest archive
   state, not malformed data.

The CSV intentionally includes day status, capture resolution, timestamps in UTC and local time,
wind, temperature, humidity, and pressure provenance. Do not remove columns or replace blanks with
zeroes.

## Report the outcome

Lead with the full clickable path to the CSV. Then state the exported date span and the exporter's
observation and metadata-only row counts. If the export fails, report the error plainly and do not
claim a file was created.
