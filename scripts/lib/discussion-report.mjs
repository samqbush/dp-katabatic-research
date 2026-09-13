import { FORWARD_HOLDOUT_START } from './night-before-call.mjs';

export const DISCUSSION_TITLE = 'Night-before katabatic research report';
export const REPORT_DAYS = 14;
export const REPORT_THRESHOLD_MPH = 15;

const DENVER_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DENVER_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function isoDenverDate(date) {
  const parts = Object.fromEntries(
    DENVER_DATE.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function reportWindowStart(now = new Date(), days = REPORT_DAYS) {
  const localToday = isoDenverDate(now);
  const [year, month, day] = localToday.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - days + 1)).toISOString().slice(0, 10);
}

export function escapeDiscussionCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, '<br>');
}

function value(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function latestSourceUpdate(data, latestForecast) {
  const soda = data.stationHealth.find((station) => station.slug === 'dp-soda-lakes');
  const timestamps = [
    soda?.latestFetchedAt,
    latestForecast?.predictionGeneratedAt,
  ].filter(Boolean).map((timestamp) => new Date(timestamp));
  return timestamps.length
    ? new Date(Math.max(...timestamps.map((date) => date.getTime())))
    : null;
}

function gustEvidence(day) {
  if (
    day.canoeSustainedMinutes < 30 ||
    day.canoeMeanGustMph === null ||
    day.canoeMeanGustMph === undefined
  ) return '—';
  return `${day.canoeMeanGustMph} mph avg / ${value(day.canoePeakGustMph, ' mph')} peak / ` +
    `${value(day.canoePctGustAtLeast18, '%')} ≥18`;
}

export function assertPublishableReport(data) {
  if (!data?.recent?.length) {
    throw new Error('Refusing to publish an empty katabatic report.');
  }
  if (!data.recent.some((day) => day.forecastCall && day.predictionMode)) {
    throw new Error('Refusing to publish without a stored prediction.');
  }
  if (!data.methodology?.fields?.length || !data.methodology?.flowClasses?.length) {
    throw new Error('Refusing to publish without report methodology.');
  }
}

export function renderDiscussionReport(data) {
  assertPublishableReport(data);

  const latestForecast = data.recent.find(
    (day) => day.forecastCall && day.predictionMode,
  );
  const soda = data.stationHealth.find((station) => station.slug === 'dp-soda-lakes');
  const sourceUpdatedAt = latestSourceUpdate(data, latestForecast);
  const stale = soda?.lagDays === null || soda?.lagDays === undefined || soda.lagDays > 1;
  const model = data.research.probabilityModel;

  const rows = data.recent.map((day) => [
    escapeDiscussionCell(day.date),
    escapeDiscussionCell(day.predictionMode),
    escapeDiscussionCell(day.forecastPhase),
    escapeDiscussionCell(day.forecastCall ?? 'No call'),
    escapeDiscussionCell(
      day.successChancePercent === null ? null : `${day.successChancePercent}%`,
    ),
    escapeDiscussionCell(day.sessionOutcome),
    escapeDiscussionCell(day.flowClass),
    escapeDiscussionCell(value(day.sustainedMinutes, ' min')),
    escapeDiscussionCell(value(day.canoeSustainedMinutes, ' min')),
    escapeDiscussionCell(gustEvidence(day)),
    escapeDiscussionCell(value(day.avgForecastWindMph, ' mph')),
    escapeDiscussionCell(value(day.avgLidM, ' m')),
  ].join(' | '));

  const latestSummary = [
    `**${escapeDiscussionCell(latestForecast.date)}: ${escapeDiscussionCell(latestForecast.forecastCall)}`,
    latestForecast.successChancePercent === null
      ? ''
      : ` · ${escapeDiscussionCell(latestForecast.successChancePercent)}% exploratory chance`,
    '**',
  ].join('');
  const methodology = data.methodology;
  const fieldRows = methodology.fields.map((field) =>
    `| ${escapeDiscussionCell(field.name)} | ${escapeDiscussionCell(field.sourceWindow)} | ${escapeDiscussionCell(field.calculation)} |`
  );
  const prerequisiteRows = methodology.flowPrerequisites.map((item) =>
    `| ${escapeDiscussionCell(item.component)} | ${escapeDiscussionCell(item.rule)} |`
  );
  const structureRows = methodology.structureScore.map((item) =>
    `| ${escapeDiscussionCell(item.component)} | ${escapeDiscussionCell(item.rule)} |`
  );
  const flowRows = methodology.flowClasses.map((item) =>
    `| ${escapeDiscussionCell(item.value)} | ${escapeDiscussionCell(item.rule)} |`
  );

  const lines = [
    '# Night-before katabatic research',
    '',
    '> [!CAUTION]',
    `> **Research display only — not a go/no-go recommendation.** ${escapeDiscussionCell(data.research.experimentalRuleStatus)}`,
    `> ${escapeDiscussionCell(data.research.morningAutomation)}`,
    '',
    '## Latest stored prediction',
    '',
    latestSummary,
    '',
    `Average HRRR wind: **${escapeDiscussionCell(value(latestForecast.avgForecastWindMph, ' mph'))}** · Average lid: **${escapeDiscussionCell(value(latestForecast.avgLidM, ' m'))}**`,
    '',
    `Prediction provenance: **${escapeDiscussionCell(latestForecast.predictionMode)}** · Experiment phase: **${escapeDiscussionCell(latestForecast.forecastPhase)}**`,
    '',
    stale
      ? `> [!WARNING]\n> Soda archive is stale: latest observation day is ${escapeDiscussionCell(soda?.latestDate)} (${escapeDiscussionCell(soda?.lagDays)} days behind).`
      : `Soda observations through **${escapeDiscussionCell(soda?.latestDate)}**.`,
    '',
    `Data last changed **${sourceUpdatedAt ? DENVER_TIME.format(sourceUpdatedAt) : 'unknown'}** (America/Denver).`,
    '',
    '## Rolling 14-day record',
    '',
    `| Date | Prediction provenance | Experiment phase | Call | Chance | Session outcome | Flow mechanism | Minutes ≥${REPORT_THRESHOLD_MPH} | Minutes ≥12 | Gust support | HRRR wind | Lid |`,
    '|---|---|---|---|---:|---|---|---:|---:|---|---:|---:|',
    ...rows.map((row) => `| ${row} |`),
    '',
    '## How each field is calculated',
    '',
    '| Field | Source and window | Calculation and interpretation |',
    '|---|---|---|',
    ...fieldRows,
    '',
    '## How flow mechanism is classified',
    '',
    '> [!IMPORTANT]',
    '> This is an exploratory after-the-fact classification of the completed morning, not an input to the call or chance.',
    '',
    '### Required evidence and event shapes',
    '',
    '| Component | `flow-class-v1` rule |',
    '|---|---|',
    ...prerequisiteRows,
    '',
    '### Pre-sunrise structure score',
    '',
    '| Component | Score rule |',
    '|---|---|',
    ...structureRows,
    '',
    '### Category precedence',
    '',
    '| Value | Rule |',
    '|---|---|',
    ...flowRows,
    '',
    methodology.missingValues,
    '',
    `Model: \`${escapeDiscussionCell(model?.modelVersion)}\` · trained through ${escapeDiscussionCell(model?.trainedThrough)} · ${escapeDiscussionCell(model?.trainingPairs)} training mornings · forward holdout began ${FORWARD_HOLDOUT_START}.`,
    '',
    'This post is replaced automatically after the nightly forecast and afternoon outcome archive workflows.',
  ];

  return `${lines.join('\n')}\n`;
}
