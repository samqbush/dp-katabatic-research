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
 *
 * `feature_version` / `rule_version` / `label_version` (see scripts/lib/versions.mjs) make every
 * row self-describing. Rows written before these columns existed are backfilled to `legacy` by
 * `scripts/migrate-prediction-log.mjs` rather than left blank, so "legacy" is a fact about the
 * row, not an absence of one.
 *
 * The `session_class*` / `canoe_*` columns are an ADDITIVE outcome tier (§ canoe club):
 * `label` keeps its original 15 mph meaning, and the canoe columns record whether a morning that
 * missed that bar still delivered a 12 mph downwind-board session. Newer gust and flow evidence
 * remains appended after the original schema so pre-existing rows round-trip blank — which means
 * "not classified", never "flat".
 */

import { FEATURE_VERSION_V1, RULE_VERSION_V1, LABEL_VERSION_V1, SESSION_CLASS_VERSION_V1 } from './versions.mjs';

export const LOG_COLUMNS = [
  'source', // backtest | live
  'date',
  'call_time',
  'station',
  'threshold_mph',
  'feature_version',
  'rule_version',
  'label_version',
  // --- features visible at call time (no lookahead) ---
  'avg30',
  'avg60',
  'avg15',
  'avg_prev15',
  'amplitude_delta15',
  'amplitude_trend',
  'latest_speed',
  'latest_age_minutes',
  'recent_peak15',
  'drop_from_recent_peak15',
  'recent_peak30',
  'drop_from_recent_peak30',
  'min30',
  'max30',
  'peak_gust30',
  'pct_over_threshold30',
  'pct_over_threshold_slices',
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
  'structure_status',
  'structure_score',
  // --- the outcome, auto-derived from the meter ---
  'gate_open_hour',
  'label',
  'sustained_minutes',
  'pre_gate_sustained_minutes',
  'missed_due_to_gate',
  'cycle_type',
  // --- the canoe tier (session-class-v1), appended so pre-existing rows round-trip blank ---
  // Blank here means "this row predates the session class", NOT "flat". Same null-vs-false
  // discipline the `label` column already follows (§4.2).
  'session_class_version',
  'session_class',
  'canoe_threshold_mph',
  'canoe_sustained_minutes',
  'canoe_verdict',
  // --- optional, human, never required ---
  'human_note',
  // --- objective gust support over the best gate-conditioned 12 mph run ---
  'canoe_mean_gust_mph',
  'canoe_peak_gust_mph',
  'canoe_pct_gust_at_least_18',
  // --- exploratory full-morning mechanism outcome, appended after all existing columns ---
  'flow_class_version',
  'flow_class',
  'flow_evidence',
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
export function buildLogRow({
  source,
  date,
  callTime,
  station,
  threshold,
  features,
  call,
  label,
  flow = null,
  canoeCall = null,
  humanNote = null,
  featureVersion = FEATURE_VERSION_V1,
  ruleVersion = RULE_VERSION_V1,
  labelVersion = LABEL_VERSION_V1,
  sessionClassVersion = SESSION_CLASS_VERSION_V1,
}) {
  return {
    source,
    date,
    call_time: callTime,
    station,
    threshold_mph: threshold,
    feature_version: featureVersion,
    rule_version: ruleVersion,
    label_version: labelVersion,
    avg30: round(features?.avg30),
    avg60: round(features?.avg60),
    avg15: round(features?.avg15),
    avg_prev15: round(features?.avgPrev15),
    amplitude_delta15: round(features?.amplitudeDelta15),
    amplitude_trend: features?.amplitudeTrend ?? null,
    latest_speed: round(features?.latestSpeed),
    latest_age_minutes: round(features?.latestAgeMinutes),
    recent_peak15: round(features?.recentPeak15),
    drop_from_recent_peak15: round(features?.dropFromRecentPeak15),
    recent_peak30: round(features?.recentPeak30),
    drop_from_recent_peak30: round(features?.dropFromRecentPeak30),
    min30: round(features?.min30),
    max30: round(features?.max30),
    peak_gust30: round(features?.peakGust30),
    pct_over_threshold30: round(features?.pctOverThreshold30, 0),
    pct_over_threshold_slices: features?.pctOverThresholdSlices
      ? JSON.stringify(features.pctOverThresholdSlices.map((v) => round(v, 0)))
      : null,
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
    structure_status: call?.structure?.status ?? null,
    structure_score: call?.structure?.score ?? null,
    gate_open_hour: label?.gateOpenHour ?? null,
    // Deliberately serialised as the strings true/false/'' — an unobserved day must round-trip
    // as empty, never as `false`, or it becomes a fabricated negative on read (§4.2).
    label: label?.label === null || label?.label === undefined ? '' : String(label.label),
    sustained_minutes: label?.sustainedMinutes ?? null,
    pre_gate_sustained_minutes: label?.preGateSustainedMinutes ?? null,
    missed_due_to_gate: label?.missedDueToGate === undefined ? null : String(label.missedDueToGate),
    cycle_type: label?.cycleType ?? null,
    // Present only when `label` is a `classifySession` result; a plain `labelDay` result leaves
    // these blank, which is the honest encoding of "this row was never session-classified".
    session_class_version: label?.sessionClass === undefined ? null : sessionClassVersion,
    session_class: label?.sessionClass ?? null,
    canoe_threshold_mph: label?.canoeThreshold ?? null,
    canoe_sustained_minutes: label?.canoeSustainedMinutes ?? null,
    // The call-time counterpart: what the rule said at the canoe threshold. Independent of the
    // outcome columns above, and blank when no canoe call was made.
    canoe_verdict: canoeCall?.verdict ?? null,
    human_note: humanNote,
    canoe_mean_gust_mph: round(label?.canoeMeanGustMph),
    canoe_peak_gust_mph: round(label?.canoePeakGustMph),
    canoe_pct_gust_at_least_18: round(label?.canoePctGustAtLeast18, 0),
    flow_class_version: flow?.flowClassVersion ?? null,
    flow_class: flow?.flowClass ?? null,
    flow_evidence: flow ? JSON.stringify({ reasons: flow.reasons, ...flow.evidence }) : null,
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
