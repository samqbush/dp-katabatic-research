import { TREND_BAND_MPH } from './call-rule.mjs';
import {
  STRUCTURE_DIRECTION_LOCK_PCT,
  STRUCTURE_DIRECTION_PARTIAL_PCT,
  STRUCTURE_HUMIDITY_DROP_POINTS,
  STRUCTURE_NEIGHBOR_RATIO,
  STRUCTURE_POSSIBLE_SCORE,
  STRUCTURE_PRESENT_SCORE,
} from './call-rule-v3.mjs';
import {
  POST_SUNRISE_DIRECTION_OVERRIDE_MINUTES,
  POST_SUNRISE_MIN_IDEAL_PCT,
} from './call-rule-v5.mjs';
import {
  FLOW_CHECKPOINT_STEP_MIN,
  FLOW_IDEAL_MAX_DEG,
  FLOW_IDEAL_MIN_DEG,
  FLOW_IDEAL_PCT,
  FLOW_LOCAL_RATIO,
  FLOW_MAX_NEIGHBOR_STEP_MIN,
  FLOW_PULSE_MINUTES,
  FLOW_REGIONAL_RATIO,
  FLOW_TARGET_STEP_MIN,
} from './flow-class.mjs';
import {
  CANOE_THRESHOLD_MPH,
  DEFAULT_MIN_SUSTAINED_MIN,
  MAX_LABELABLE_STEP_MIN,
  MAX_MINUTES_PAST_SUNRISE,
} from './label.mjs';
import { MIN_NIGHT_BEFORE_FORECAST_HOURS } from './night-before-call.mjs';

const HRRR_WINDOW =
  'valid hours 05:00, 06:00, 07:00, and 08:00 America/Denver';

function number(value, digits = 6) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

function signedTerm(coefficient, variable) {
  const numeric = number(coefficient, 9);
  if (numeric === null) return null;
  return `${numeric < 0 ? '-' : '+'} ${Math.abs(numeric)} × ${variable}`;
}

function chanceCalculation(model) {
  const params = model?.parameters;
  const weights = Array.isArray(params?.weights) ? params.weights : [];
  const intercept = number(weights[0], 9);
  const windTerm = signedTerm(weights[1], 'wind_z');
  const lidTerm = signedTerm(weights[2], 'lid_z');
  const windMean = number(params?.windMean, 6);
  const windSd = number(params?.windSd, 6);
  const lidMean = number(params?.lidMean, 6);
  const lidSd = number(params?.lidSd, 6);
  const rounding = number(params?.displayRoundingPercent, 0);
  const caps = Array.isArray(params?.displayCapPercent)
    ? params.displayCapPercent.map((value) => number(value, 0))
    : [];

  if (
    intercept === null ||
    !windTerm ||
    !lidTerm ||
    windMean === null ||
    windSd === null ||
    lidMean === null ||
    lidSd === null
  ) {
    return (
      `Read from the immutable stored prediction for model ${model?.modelVersion ?? 'unknown'}. ` +
      'The active model parameters are unavailable in this report.'
    );
  }

  const displayRule =
    rounding !== null && caps.length === 2 && caps.every((value) => value !== null)
      ? `Round to the nearest ${rounding}% and cap the displayed result at ${caps[0]}%-${caps[1]}%.`
      : 'Apply the display rounding and caps stored with the versioned model.';

  return (
    `Using unrounded stored averages: wind_z = (wind - ${windMean}) / ${windSd}; ` +
    `lid_z = (lid - ${lidMean}) / ${lidSd}; linear score = clamp(${intercept} ` +
    `${windTerm} ${lidTerm}, -30, 30); probability = 1 / (1 + exp(-score)). ` +
    `${displayRule}`
  );
}

export function buildReportMethodology({
  thresholdMph,
  model,
  forwardHoldoutStart,
}) {
  const threshold = number(thresholdMph, 1);
  const targetThreshold = number(model?.targetThresholdMph, 1);
  const targetMinutes = Number(model?.targetSustainedMinutes);
  const canoeRelationship =
    threshold !== null && threshold <= CANOE_THRESHOLD_MPH
      ? `At a selected threshold of ${threshold} mph, this class cannot occur because a qualifying ` +
        `>=${CANOE_THRESHOLD_MPH} mph run also satisfies the selected sustained class.`
      : (
          `gust-driven/canoe means the selected sustained target failed but ` +
          `>=${CANOE_THRESHOLD_MPH} mph held for >=${DEFAULT_MIN_SUSTAINED_MIN} continuous minutes.`
        );

  return {
    fields: [
      {
        name: 'Date',
        sourceWindow: 'Calendar date in America/Denver.',
        calculation:
          'The local morning date shared by the stored HRRR run, issued prediction, and archived observations.',
      },
      {
        name: 'Prediction provenance',
        sourceWindow: 'Immutable night_before_predictions.generation_mode.',
        calculation:
          '`forward` is the collector mode used for a normal single-date capture; `retrospective` is the explicit/range backfill mode. This is row provenance, not proof inferred from the observation timestamps.',
      },
      {
        name: 'Experiment phase',
        sourceWindow: `Date split at ${forwardHoldoutStart}.`,
        calculation:
          `Dates on or after ${forwardHoldoutStart} are held-out; earlier dates are development/backfill. This is independent of prediction provenance.`,
      },
      {
        name: 'Call',
        sourceWindow:
          `Arithmetic means of complete HRRR wind/lid pairs in ${HRRR_WINDOW} from the exact 00Z run; at least ${MIN_NIGHT_BEFORE_FORECAST_HOURS} usable hours are required.`,
        calculation:
          'PACK when wind >=9 mph and lid <250 m. SLEEP IN when wind <5 mph and lid >=250 m, or wind <6 mph and lid >=100 m. MAYBE for every other complete forecast. No call is issued when the forecast is incomplete.',
      },
      {
        name: 'Chance',
        sourceWindow:
          `The same unrounded HRRR averages as Call. Target: >=${targetThreshold ?? '—'} mph for >=${Number.isFinite(targetMinutes) ? targetMinutes : '—'} continuous minutes in the accessible morning window.`,
        calculation:
          `${chanceCalculation(model)} The table's wind/lid cells are rounded display values and are not used to recompute the stored percentage.`,
      },
      {
        name: 'Session outcome',
        sourceWindow:
          `Soda observations from park gate-open through sunrise +${MAX_MINUTES_PAST_SUNRISE} minutes; ${MAX_LABELABLE_STEP_MIN}-minute resolution or finer.`,
        calculation:
          `sustained means >=${threshold ?? '—'} mph for >=${DEFAULT_MIN_SUSTAINED_MIN} continuous minutes. ${canoeRelationship} flat means neither run qualified. A gap breaks a run; unavailable or too-coarse data stays unavailable rather than becoming flat.`,
      },
      {
        name: 'Flow mechanism',
        sourceWindow:
          `Completed physical morning from midnight through sunrise +${MAX_MINUTES_PAST_SUNRISE} minutes, using ${FLOW_TARGET_STEP_MIN}-minute Soda data and both configured neighbors at ${FLOW_MAX_NEIGHBOR_STEP_MIN}-minute resolution or finer.`,
        calculation:
          'Exploratory flow-class-v1 attribution after the outcome is known. It is not a predictor. See the structure score and category precedence below.',
      },
      {
        name: `Minutes >=${threshold ?? '—'}`,
        sourceWindow: `The same accessible Soda window used by Session outcome.`,
        calculation:
          `Length of the longest continuous run at or above ${threshold ?? '—'} mph. A below-threshold point or a data gap >1.5 times the archive cadence breaks the run; each archive bucket contributes its cadence in minutes.`,
      },
      {
        name: `Minutes >=${CANOE_THRESHOLD_MPH}`,
        sourceWindow: `The same accessible Soda window used by Session outcome.`,
        calculation:
          `Length of the longest continuous run at or above ${CANOE_THRESHOLD_MPH} mph, using the same cadence and gap rules.`,
      },
      {
        name: 'Gust support',
        sourceWindow: `Finite gust readings inside the best >=${CANOE_THRESHOLD_MPH} mph run.`,
        calculation:
          `Shown only when that run lasted >=${DEFAULT_MIN_SUSTAINED_MIN} minutes: arithmetic mean gust, peak gust, and percent of readings with gust >=18 mph. These values describe the run; they do not decide the class.`,
      },
      {
        name: 'Average HRRR wind',
        sourceWindow:
          `Complete wind/lid pairs in ${HRRR_WINDOW} from the exact 00Z run; at least ${MIN_NIGHT_BEFORE_FORECAST_HOURS} of four hours.`,
        calculation:
          'Arithmetic mean of 10 m wind speed in mph. Issued rows use the immutable value stored with the prediction; forecast-only rows use the latest stored run for that date. Displayed to one decimal place.',
      },
      {
        name: 'Average lid',
        sourceWindow:
          `The same complete HRRR pairs and run used by Average HRRR wind.`,
        calculation:
          'Arithmetic mean boundary-layer height in metres. Issued rows use the immutable value stored with the prediction; forecast-only rows use the latest stored run for that date. Displayed to one decimal place.',
      },
    ],
    flowPrerequisites: [
      {
        component: 'Coverage',
        rule:
          `Soda must be complete at ${FLOW_TARGET_STEP_MIN}-minute cadence and both neighbors complete at <=${FLOW_MAX_NEIGHBOR_STEP_MIN}-minute cadence from midnight through sunrise +${MAX_MINUTES_PAST_SUNRISE} minutes. Missing edge coverage or a gap >1.5 cadences returns unknown.`,
      },
      {
        component: 'Structure checkpoints',
        rule:
          `Every ${FLOW_CHECKPOINT_STEP_MIN} minutes from 00:30 through sunrise. Each checkpoint uses only observations at or before that time.`,
      },
      {
        component: 'Organized W/NW pulse',
        rule:
          `>=${CANOE_THRESHOLD_MPH} mph for >=${FLOW_PULSE_MINUTES} continuous minutes with >=${FLOW_IDEAL_PCT}% of directions inside ${FLOW_IDEAL_MIN_DEG}°-${FLOW_IDEAL_MAX_DEG}°. Gaps break the pulse.`,
      },
      {
        component: 'Collapse',
        rule:
          `<${CANOE_THRESHOLD_MPH} mph for >=${FLOW_PULSE_MINUTES} continuous minutes. A data gap cannot prove a collapse.`,
      },
      {
        component: 'Local contrast',
        rule:
          `At a PRESENT checkpoint, each neighbor's concurrent 30-minute mean is <${FLOW_LOCAL_RATIO * 100}% of Soda's 30-minute mean.`,
      },
      {
        component: 'Regional concurrency',
        rule:
          `During an organized pulse, Soda's trailing 30-minute mean is >=${CANOE_THRESHOLD_MPH} mph and both neighbors are >=${FLOW_REGIONAL_RATIO * 100}% of Soda.`,
      },
    ],
    structureScore: [
      {
        component: 'Direction',
        rule:
          `Prior 60 minutes inside Soda's ${FLOW_IDEAL_MIN_DEG}°-${FLOW_IDEAL_MAX_DEG}° window: +2 at >=${STRUCTURE_DIRECTION_LOCK_PCT}%, +1 at >=${STRUCTURE_DIRECTION_PARTIAL_PCT}%, otherwise +0.`,
      },
      {
        component: 'Drying',
        rule:
          `+1 when relative humidity has fallen by at least ${STRUCTURE_HUMIDITY_DROP_POINTS} percentage points since the first observation visible that day.`,
      },
      {
        component: 'Neighbor contrast',
        rule:
          `+1 when the largest concurrent neighbor 30-minute mean is <${STRUCTURE_NEIGHBOR_RATIO * 100}% of Soda's 30-minute mean.`,
      },
      {
        component: 'Broader trend',
        rule:
          `+1 when Soda's latest 30-minute mean exceeds the previous 30-minute mean by >${TREND_BAND_MPH} mph.`,
      },
      {
        component: 'Status',
        rule:
          `PRESENT at score >=${STRUCTURE_PRESENT_SCORE}; POSSIBLE at score >=${STRUCTURE_POSSIBLE_SCORE}; otherwise ABSENT. v5 also forces ABSENT after sunrise +${POST_SUNRISE_DIRECTION_OVERRIDE_MINUTES} minutes when <${POST_SUNRISE_MIN_IDEAL_PCT}% of directions are ideal, but flow-class-v1 checkpoints stop at sunrise so that override does not fire here.`,
      },
    ],
    flowClasses: [
      {
        value: 'unknown (required evidence)',
        rule:
          'Returned first when Soda or either neighbor is missing, unobserved, incomplete across the physical morning, or too coarse.',
      },
      {
        value: 'transition-hybrid',
        rule:
          'An organized second W/NW pulse extending past gate-open follows a qualifying collapse, and before that collapse there was either a PRESENT pre-sunrise checkpoint or any earlier organized W/NW pulse. The implemented v1 rule does not prove that earlier pulse was pre-sunrise drainage.',
      },
      {
        value: 'unknown (conflict)',
        rule:
          'Returned when both local-contrast PRESENT evidence and a regionally concurrent organized pulse exist.',
      },
      {
        value: 'katabatic',
        rule:
          'At least one pre-sunrise PRESENT checkpoint has local contrast, after the transition and conflict checks did not fire.',
      },
      {
        value: 'synoptic',
        rule:
          'An organized Soda pulse has regional concurrency and no checkpoint establishes local contrast.',
      },
      {
        value: 'absent',
        rule:
          'Complete evidence exists, every pre-sunrise checkpoint is ABSENT, and no organized W/NW pulse formed.',
      },
      {
        value: 'unknown (unresolved)',
        rule:
          'Every remaining mixture, including only POSSIBLE structure or evidence that cannot distinguish the mechanism.',
      },
    ],
    missingValues:
      'An em dash means the value is unavailable or was not calculated. A literal unknown means flow-class-v1 ran but could not attribute a mechanism. absent is affirmative evidence, never a missing-data fallback.',
  };
}
