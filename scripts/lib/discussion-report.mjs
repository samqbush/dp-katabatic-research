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

function cell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, '<br>');
}

function value(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`;
}

function sample(day) {
  if (day.predictionMode === 'forward') return 'forward';
  if (day.predictionMode === 'retrospective') return 'retrospective';
  return day.forecastPhase ?? 'no prediction';
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

export function assertPublishableReport(data) {
  if (!data?.recent?.length) {
    throw new Error('Refusing to publish an empty katabatic report.');
  }
  if (!data.recent.some((day) => day.forecastCall && day.predictionMode)) {
    throw new Error('Refusing to publish without a stored prediction.');
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
    `${cell(day.date)}<br><sub>${cell(sample(day))}</sub>`,
    cell(day.forecastCall ?? 'No call'),
    cell(day.successChancePercent === null ? null : `${day.successChancePercent}%`),
    cell(value(day.observedMorningMaxSpeedMph, ' mph')),
    cell(value(day.observedMorningMaxGustMph, ' mph')),
    cell(value(day.observedMorningSustainedMinutes, ' min')),
    cell(value(day.avgForecastWindMph, ' mph')),
    cell(value(day.avgLidM, ' m')),
  ].join(' | '));

  const latestSummary = [
    `**${cell(latestForecast.date)}: ${cell(latestForecast.forecastCall)}`,
    latestForecast.successChancePercent === null
      ? ''
      : ` · ${cell(latestForecast.successChancePercent)}% exploratory chance`,
    '**',
  ].join('');

  const lines = [
    '# Night-before katabatic research',
    '',
    '> [!CAUTION]',
    `> **Research display only — not a go/no-go recommendation.** ${cell(data.research.experimentalRuleStatus)}`,
    `> ${cell(data.research.morningAutomation)}`,
    '',
    '## Latest stored prediction',
    '',
    latestSummary,
    '',
    `Average HRRR wind: **${cell(value(latestForecast.avgForecastWindMph, ' mph'))}** · Average lid: **${cell(value(latestForecast.avgLidM, ' m'))}** · Sample: **${cell(sample(latestForecast))}**`,
    '',
    stale
      ? `> [!WARNING]\n> Soda archive is stale: latest observation day is ${cell(soda?.latestDate)} (${cell(soda?.lagDays)} days behind).`
      : `Soda observations through **${cell(soda?.latestDate)}**.`,
    '',
    `Data last changed **${sourceUpdatedAt ? DENVER_TIME.format(sourceUpdatedAt) : 'unknown'}** (America/Denver).`,
    '',
    '## Rolling 14-day record',
    '',
    `| Date / sample | Call | Chance | Max wind | Max gust | Minutes ≥${REPORT_THRESHOLD_MPH} mph | HRRR wind | Lid |`,
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row} |`),
    '',
    `<sub>Observed wind covers Colorado-local midnight through sunrise +3 hours. “Minutes ≥${REPORT_THRESHOLD_MPH} mph” is the longest continuous run; data gaps break a run. An em dash means the observation is unavailable or too coarse, not calm wind. “forward” means stored before the observed morning; “retrospective” means backfilled after it. Forward holdout began ${FORWARD_HOLDOUT_START}. Chance is an unvalidated, rounded research estimate—not a calibrated product probability.</sub>`,
    '',
    `Model: \`${cell(model?.modelVersion)}\` · trained through ${cell(model?.trainedThrough)} · ${cell(model?.trainingPairs)} training mornings.`,
    '',
    'This post is replaced automatically after the nightly forecast and afternoon outcome archive workflows.',
  ];

  return `${lines.join('\n')}\n`;
}
