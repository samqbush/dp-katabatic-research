/**
 * Frozen experimental night-before rule from the 2026-08-10 pre-registration.
 *
 * This is a research label, not an operational recommendation. It failed the safety endpoint on
 * the historical pilot (17.9% of rideable sessions lost) and must remain visibly experimental
 * until it passes on a forward, held-out season.
 */

export const FORWARD_HOLDOUT_START = '2026-08-11';
export const MIN_NIGHT_BEFORE_FORECAST_HOURS = 3;

export const EXPERIMENTAL_PROBABILITY_MODEL_V1 = Object.freeze({
  modelVersion: 'wind-lid-logistic-v1',
  createdAt: '2026-08-18T00:27:00.000Z',
  trainedThrough: '2026-08-10',
  trainingSize: 130,
  positives: 28,
  targetThresholdMph: 15,
  targetSustainedMinutes: 30,
  target:
    'at least 15 mph for 30 continuous minutes in the accessible morning window',
  status:
    'UNVALIDATED: exploratory logistic estimate from backfill HRRR wind/lid only.',
  windMean: 6.6325,
  windSd: 3.5682516323177755,
  lidMean: 297.6826923076923,
  lidSd: 237.9577123640264,
  weights: Object.freeze([
    -1.634963978772643,
    0.8883596150515636,
    -0.9704648759371536,
  ]),
});

const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, average) {
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2))) || 1;
}

export function experimentalNightBeforeCall({ avgWindMph, avgLidM, forecastHours }) {
  const wind = Number(avgWindMph);
  const lid = Number(avgLidM);

  if (
    !Number.isFinite(wind)
    || !Number.isFinite(lid)
    || !Number.isInteger(forecastHours)
    || forecastHours < MIN_NIGHT_BEFORE_FORECAST_HOURS
  ) {
    return {
      call: null,
      reason: `fewer than ${MIN_NIGHT_BEFORE_FORECAST_HOURS} usable HRRR hours`,
    };
  }

  if (wind >= 9 && lid < 250) {
    return {
      call: 'PACK',
      reason: `average HRRR wind ${wind.toFixed(1)} mph with a ${lid.toFixed(1)} m lid`,
    };
  }

  if ((wind < 5 && lid >= 250) || (wind < 6 && lid >= 100)) {
    return {
      call: 'SLEEP IN',
      reason: `average HRRR wind ${wind.toFixed(1)} mph with a ${lid.toFixed(1)} m lid`,
    };
  }

  return {
    call: 'MAYBE',
    reason: `average HRRR wind ${wind.toFixed(1)} mph with a ${lid.toFixed(1)} m lid`,
  };
}

/**
 * Fit an exploratory logistic model on development/backfill mornings only.
 *
 * The model intentionally stays small: average HRRR wind and average HRRR lid are the same two
 * inputs used by the frozen bucket rule. L2 regularization keeps thin samples from producing
 * extreme coefficients. Callers own the temporal split and must never pass held-out outcomes.
 */
export function fitExperimentalProbabilityModel(rows) {
  const training = rows
    .map((row) => ({
      wind: Number(row.avgWindMph),
      lid: Number(row.avgLidM),
      rideable: row.rideable === true ? 1 : row.rideable === false ? 0 : null,
    }))
    .filter((row) => (
      Number.isFinite(row.wind)
      && Number.isFinite(row.lid)
      && row.rideable !== null
    ));

  const positives = training.filter((row) => row.rideable === 1).length;
  if (training.length < 10 || positives === 0 || positives === training.length) return null;

  const windValues = training.map((row) => row.wind);
  const lidValues = training.map((row) => row.lid);
  const windMean = mean(windValues);
  const lidMean = mean(lidValues);
  const windSd = standardDeviation(windValues, windMean);
  const lidSd = standardDeviation(lidValues, lidMean);
  const normalized = training.map((row) => ({
    x: [1, (row.wind - windMean) / windSd, (row.lid - lidMean) / lidSd],
    y: row.rideable,
  }));

  const baseRate = positives / training.length;
  const weights = [Math.log(baseRate / (1 - baseRate)), 0, 0];
  const learningRate = 0.2;
  const l2 = 0.1;

  for (let iteration = 0; iteration < 2000; iteration++) {
    const gradient = [0, 0, 0];
    for (const row of normalized) {
      const probability = sigmoid(
        weights[0] + weights[1] * row.x[1] + weights[2] * row.x[2],
      );
      const error = probability - row.y;
      for (let i = 0; i < gradient.length; i++) gradient[i] += error * row.x[i];
    }
    gradient[1] += l2 * weights[1];
    gradient[2] += l2 * weights[2];

    let largestUpdate = 0;
    for (let i = 0; i < weights.length; i++) {
      const update = learningRate * gradient[i] / normalized.length;
      weights[i] -= update;
      largestUpdate = Math.max(largestUpdate, Math.abs(update));
    }
    if (largestUpdate < 1e-9) break;
  }

  return {
    trainingSize: training.length,
    positives,
    baseRate,
    windMean,
    windSd,
    lidMean,
    lidSd,
    weights,
  };
}

export function experimentalSuccessChance(model, forecast) {
  if (
    !model
    || !forecast
    || !Number.isInteger(forecast.forecastHours)
    || forecast.forecastHours < MIN_NIGHT_BEFORE_FORECAST_HOURS
  ) return null;
  const wind = Number(forecast.avgWindMph);
  const lid = Number(forecast.avgLidM);
  if (!Number.isFinite(wind) || !Number.isFinite(lid)) return null;

  const windZ = (wind - model.windMean) / model.windSd;
  const lidZ = (lid - model.lidMean) / model.lidSd;
  const probability = sigmoid(
    model.weights[0] + model.weights[1] * windZ + model.weights[2] * lidZ,
  );

  // Avoid communicating false certainty from a small, unvalidated model.
  const roundedPercent = Math.max(5, Math.min(95, Math.round(probability * 20) * 5));
  return {
    probability,
    roundedPercent,
  };
}

export function buildExperimentalNightBeforePrediction(
  forecast,
  model = EXPERIMENTAL_PROBABILITY_MODEL_V1,
) {
  const call = experimentalNightBeforeCall(forecast);
  const successChance = experimentalSuccessChance(model, forecast);
  if (!call.call || !successChance) return null;

  return {
    modelVersion: model.modelVersion,
    call: call.call,
    callReason: call.reason,
    successProbability: successChance.probability,
    successChancePercent: successChance.roundedPercent,
  };
}

export function experimentalCallResult(call, rideable) {
  if (!call || rideable === null || rideable === undefined) return null;

  if (call === 'SLEEP IN') {
    return rideable
      ? { label: 'MISSED SESSION', tone: 'danger' }
      : { label: 'Correct sleep-in', tone: 'success' };
  }

  if (call === 'PACK') {
    return rideable
      ? { label: 'PACK hit', tone: 'success' }
      : { label: 'PACK false alarm', tone: 'warning' };
  }

  return {
    label: rideable ? 'MAYBE — rideable' : 'MAYBE — not rideable',
    tone: 'neutral',
  };
}
