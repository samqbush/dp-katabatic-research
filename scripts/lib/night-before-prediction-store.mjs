import { query } from './db.mjs';
import {
  buildExperimentalNightBeforePrediction,
  EXPERIMENTAL_PROBABILITY_MODEL_V1,
} from './night-before-call.mjs';

let modelRegistered = false;

const average = (values) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
);

export function summarizeForecastRows(rows) {
  const usable = rows.filter(
    (row) => (
      row.wind !== null
      && row.wind !== undefined
      && row.lid !== null
      && row.lid !== undefined
      && Number.isFinite(Number(row.wind))
      && Number.isFinite(Number(row.lid))
    ),
  );
  return {
    avgWindMph: average(usable.map((row) => Number(row.wind))),
    avgLidM: average(usable.map((row) => Number(row.lid))),
    forecastHours: usable.length,
  };
}

export async function findNightBeforePrediction({
  stationSlug,
  localDate,
  runInit,
  modelVersion = EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion,
}) {
  const { rows } = await query(
    `SELECT *
     FROM night_before_predictions
     WHERE station_slug = $1
       AND local_date = $2
       AND run_init = $3
       AND model_version = $4`,
    [stationSlug, localDate, runInit, modelVersion],
  );
  return rows[0] ?? null;
}

async function registerModel() {
  if (modelRegistered) return;
  const model = EXPERIMENTAL_PROBABILITY_MODEL_V1;
  const parameters = {
    windMean: model.windMean,
    windSd: model.windSd,
    lidMean: model.lidMean,
    lidSd: model.lidSd,
    weights: model.weights,
    displayRoundingPercent: 5,
    displayCapPercent: [5, 95],
  };

  await query(
    `INSERT INTO night_before_models
       (model_version, created_at, trained_through, training_size, training_positives,
        target_threshold_mph, target_sustained_minutes, target_description, status, parameters)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (model_version) DO NOTHING`,
    [
      model.modelVersion,
      model.createdAt,
      model.trainedThrough,
      model.trainingSize,
      model.positives,
      model.targetThresholdMph,
      model.targetSustainedMinutes,
      model.target,
      model.status,
      JSON.stringify(parameters),
    ],
  );
  modelRegistered = true;
}

function samePrediction(existing, expected) {
  return (
    existing.call === expected.call
    && existing.call_reason === expected.callReason
    && existing.generation_mode === expected.generationMode
    && Number(existing.success_chance_percent) === expected.successChancePercent
    && Math.abs(Number(existing.success_probability) - expected.successProbability) < 1e-9
    && Math.abs(Number(existing.avg_wind_mph) - expected.avgWindMph) < 0.00051
    && Math.abs(Number(existing.avg_lid_m) - expected.avgLidM) < 0.00051
    && Number(existing.forecast_hours) === expected.forecastHours
  );
}

export async function persistNightBeforePrediction({
  stationSlug,
  localDate,
  runInit,
  forecast,
  generationMode,
  generatedAt = new Date().toISOString(),
}) {
  if (!['forward', 'retrospective'].includes(generationMode)) {
    throw new Error(`Invalid prediction generation mode: ${generationMode}`);
  }

  const prediction = buildExperimentalNightBeforePrediction(forecast);
  if (!prediction) return null;
  await registerModel();

  const expected = {
    ...prediction,
    ...forecast,
    generationMode,
  };
  const { rows } = await query(
    `INSERT INTO night_before_predictions
       (station_slug, local_date, run_init, model_version, generation_mode,
        avg_wind_mph, avg_lid_m, forecast_hours, call, call_reason,
        success_probability, success_chance_percent, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (station_slug, local_date, run_init, model_version) DO NOTHING
     RETURNING *`,
    [
      stationSlug,
      localDate,
      runInit,
      prediction.modelVersion,
      generationMode,
      forecast.avgWindMph,
      forecast.avgLidM,
      forecast.forecastHours,
      prediction.call,
      prediction.callReason,
      prediction.successProbability,
      prediction.successChancePercent,
      generatedAt,
    ],
  );

  if (rows.length) return rows[0];

  const { rows: existingRows } = await query(
    `SELECT *
     FROM night_before_predictions
     WHERE station_slug = $1
       AND local_date = $2
       AND run_init = $3
       AND model_version = $4`,
    [stationSlug, localDate, runInit, prediction.modelVersion],
  );
  const existing = existingRows[0];
  if (!existing || !samePrediction(existing, expected)) {
    throw new Error(
      `Prediction ${prediction.modelVersion} changed for ${localDate}; bump the model version instead of rewriting issued evidence.`,
    );
  }
  return existing;
}
