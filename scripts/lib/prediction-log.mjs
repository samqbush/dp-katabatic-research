/**
 * The prediction log — one row per (morning, call time).
 *
 * §3.2 asked for this. The original design assumed a human would hand-enter each row at 5:30am
 * and fill in the outcome after driving out. The user has ruled that out: he travels, this is a
 * hobby project, and he will not maintain a manual dataset.
 *
 * That turned out to be liberating rather than limiting. The outcome — "did it sustain ≥15 mph
 * for ≥30 min after the gate opened" — is fully computable from meter history, so every column
 * here is machine-fillable. The backtest populates ~400 historical rows immediately, and the
 * daily workflow appends and scores new ones. §3.3's "wait for 30+ logged mornings" gate is
 * therefore satisfiable today rather than in a month.
 *
 * `human_note` is the one column a machine cannot fill: whether it was *actually* rideable
 * (chop, launch-relative direction, gear). It is strictly optional and NOTHING may block on it.
 */

export const LOG_COLUMNS = [
  'source', // backtest | live
  'date',
  'call_time',
  'station',
  'threshold_mph',
  // --- features visible at call time (no lookahead) ---
  'avg30',
  'avg60',
  'min30',
  'max30',
  'peak_gust30',
  'pct_over_threshold30',
  'mean_dir',
  'dir_consistency',
  'in_ideal_pct',
  'trend',
  'trend_delta',
  'rh_delta',
  'neighbor_max',
  'minutes_past_sunrise',
  'minutes_until_gate',
  // --- the call ---
  'verdict',
  'score',
  // --- the outcome, auto-derived from the meter ---
  'gate_open_hour',
  'label',
  'sustained_minutes',
  'pre_gate_sustained_minutes',
  'missed_due_to_gate',
  'cycle_type',
  // --- optional, human, never required ---
  'human_note',
];

function escapeCsv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvHeader() {
  return `${LOG_COLUMNS.join(',')}\n`;
}

export function toCsvRow(obj) {
  return `${LOG_COLUMNS.map((c) => escapeCsv(obj[c])).join(',')}\n`;
}

const round = (v, dp = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

/** Flatten features + call + label into a log row. Single place, so backtest and live agree. */
export function buildLogRow({ source, date, callTime, station, threshold, features, call, label, humanNote = null }) {
  return {
    source,
    date,
    call_time: callTime,
    station,
    threshold_mph: threshold,
    avg30: round(features?.avg30),
    avg60: round(features?.avg60),
    min30: round(features?.min30),
    max30: round(features?.max30),
    peak_gust30: round(features?.peakGust30),
    pct_over_threshold30: round(features?.pctOverThreshold30, 0),
    mean_dir: round(features?.meanDir, 0),
    dir_consistency: round(features?.dirConsistency, 0),
    in_ideal_pct: round(features?.inIdealPct, 0),
    trend: features?.trend ?? null,
    trend_delta: round(features?.trendDelta),
    rh_delta: round(features?.rhDelta, 0),
    neighbor_max: round(features?.neighborMax),
    minutes_past_sunrise: features?.minutesPastSunrise ?? null,
    minutes_until_gate: features?.minutesUntilGate ?? null,
    verdict: call?.verdict ?? null,
    score: call?.score ?? null,
    gate_open_hour: label?.gateOpenHour ?? null,
    // Deliberately serialised as the strings true/false/'' — an unobserved day must round-trip
    // as empty, never as `false`, or it becomes a fabricated negative on read (§4.2).
    label: label?.label === null || label?.label === undefined ? '' : String(label.label),
    sustained_minutes: label?.sustainedMinutes ?? null,
    pre_gate_sustained_minutes: label?.preGateSustainedMinutes ?? null,
    missed_due_to_gate: label?.missedDueToGate === undefined ? null : String(label.missedDueToGate),
    cycle_type: label?.cycleType ?? null,
    human_note: humanNote,
  };
}

/** Parse the log back, preserving the null-vs-false distinction the label depends on. */
export function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i] === '' ? null : cells[i];
    });
    return row;
  });
}

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
