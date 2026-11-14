#!/usr/bin/env node

/**
 * Reproduce the gate-aligned night-before model's fixed 2026 train/holdout comparison.
 * This is analysis-only: it reads Neon and writes no predictions or model records.
 */

import { closePool, query } from './lib/db.mjs';
import { readDays } from './lib/archive-store.mjs';
import { labelDay } from './lib/label.mjs';
import {
  EXPERIMENTAL_PROBABILITY_MODEL_V1,
  EXPERIMENTAL_PROBABILITY_MODEL_V2,
  experimentalSuccessChance,
  fitExperimentalProbabilityModel,
  summarizeGateAlignedForecastRows,
} from './lib/night-before-call.mjs';
import { summarizeForecastRows } from './lib/night-before-prediction-store.mjs';

const HOLDOUT_START = '2026-08-11';
const HOLDOUT_END = '2026-10-31';

function auc(labels, probabilities) {
  const pairs = labels
    .map((label, index) => ({ label, probability: probabilities[index] }))
    .sort((a, b) => a.probability - b.probability);
  let positives = 0;
  let negatives = 0;
  let positiveRankSum = 0;
  for (let index = 0; index < pairs.length;) {
    let end = index + 1;
    while (
      end < pairs.length
      && pairs[end].probability === pairs[index].probability
    ) end++;
    const averageRank = ((index + 1) + end) / 2;
    for (let cursor = index; cursor < end; cursor++) {
      if (pairs[cursor].label) {
        positives++;
        positiveRankSum += averageRank;
      } else {
        negatives++;
      }
    }
    index = end;
  }
  if (!positives || !negatives) return null;
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function metrics(samples, probabilityKey) {
  const scored = samples.filter((sample) => Number.isFinite(sample[probabilityKey]));
  const labels = scored.map((sample) => Number(sample.rideable));
  const probabilities = scored.map((sample) => sample[probabilityKey]);
  return {
    n: scored.length,
    rideable: labels.reduce((sum, label) => sum + label, 0),
    brier: probabilities.length
      ? probabilities.reduce((sum, probability, index) => (
        sum + (labels[index] - probability) ** 2
      ), 0) / probabilities.length
      : null,
    auc: auc(labels, probabilities),
  };
}

try {
  const days = await readDays('dp-soda-lakes', {
    from: '2026-03-01',
    to: HOLDOUT_END,
  });
  const outcomes = new Map(
    days.map((day) => [day.date, labelDay(day).label]),
  );
  const { rows } = await query(
    `SELECT
       h.local_date::text AS date,
       h.valid_hour_local AS hr,
       h.wind_mph AS wind,
       h.lid_m AS lid,
       p.success_probability AS v1_probability
     FROM hrrr_forecasts h
     LEFT JOIN night_before_predictions p
       ON p.station_slug = h.station_slug AND p.local_date = h.local_date
       AND p.run_init = h.run_init AND p.model_version = $4
     WHERE h.station_slug = $1 AND h.local_date BETWEEN $2 AND $3
       AND h.run_init = (h.local_date::timestamp AT TIME ZONE 'UTC')
     ORDER BY h.local_date, h.valid_hour_local`,
    [
      'dp-soda-lakes', '2026-03-01', HOLDOUT_END,
      EXPERIMENTAL_PROBABILITY_MODEL_V1.modelVersion,
    ],
  );

  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const samples = [];
  for (const [date, forecastRows] of byDate) {
    const month = Number(date.slice(5, 7));
    const outcome = outcomes.get(date);
    if (month < 3 || month > 10 || outcome === null || outcome === undefined) continue;

    const legacy = summarizeForecastRows(
      forecastRows.filter((row) => row.hr >= 5 && row.hr <= 8),
    );
    const gateAligned = summarizeGateAlignedForecastRows(forecastRows, date);
    if (legacy.forecastHours < 3 || !gateAligned || gateAligned.forecastHours < 3) continue;

    samples.push({
      date,
      rideable: outcome,
      legacy,
      gateAligned,
      v1Probability: forecastRows[0].v1_probability == null
        ? null : Number(forecastRows[0].v1_probability),
    });
  }

  const training = samples
    .filter((sample) => sample.date <= EXPERIMENTAL_PROBABILITY_MODEL_V2.trainedThrough)
    .map((sample) => ({
      ...sample.gateAligned,
      rideable: sample.rideable,
    }));
  const model = fitExperimentalProbabilityModel(training);
  if (!model) throw new Error('Insufficient data to fit the gate-aligned candidate.');

  const holdoutSamples = samples
    .filter((sample) => sample.date >= HOLDOUT_START && sample.date <= HOLDOUT_END);
  const heldout = holdoutSamples
    .filter((sample) => Number.isFinite(sample.v1Probability))
    .map((sample) => ({
      ...sample,
      v2Probability: experimentalSuccessChance(
        EXPERIMENTAL_PROBABILITY_MODEL_V2,
        sample.gateAligned,
      )?.probability,
    }));

  console.log(JSON.stringify({
    training: {
      from: samples.find((sample) => sample.date <= EXPERIMENTAL_PROBABILITY_MODEL_V2.trainedThrough)?.date,
      through: EXPERIMENTAL_PROBABILITY_MODEL_V2.trainedThrough,
      size: model.trainingSize,
      rideable: model.positives,
      refitMatchesFrozenV2: [
        'windMean', 'windSd', 'lidMean', 'lidSd',
      ].every((key) => Math.abs(model[key] - EXPERIMENTAL_PROBABILITY_MODEL_V2[key]) < 1e-10)
        && model.weights.every((weight, index) => (
          Math.abs(weight - EXPERIMENTAL_PROBABILITY_MODEL_V2.weights[index]) < 1e-10
        )),
      coefficients: {
        windMean: model.windMean,
        windSd: model.windSd,
        lidMean: model.lidMean,
        lidSd: model.lidSd,
        weights: model.weights,
      },
    },
    holdout: {
      from: HOLDOUT_START,
      through: HOLDOUT_END,
      excludedMissingV1: holdoutSamples.length - heldout.length,
      v1: metrics(heldout, 'v1Probability'),
      v2: metrics(heldout, 'v2Probability'),
    },
  }, null, 2));
} finally {
  await closePool();
}
