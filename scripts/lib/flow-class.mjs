/**
 * Exploratory full-morning physical-regime classifier (`flow-class-v1`).
 *
 * This module reads completed outcomes, including post-call observations. Prediction and call-rule
 * modules must never import it.
 */

import { computeFeaturesV5, classifyKatabaticStructureV5 } from './call-rule-v5.mjs';
import { CANOE_THRESHOLD_MPH, MAX_MINUTES_PAST_SUNRISE, parseArchiveDate } from './label.mjs';
import { gateOpenTime } from './season.mjs';
import { calcSunrise, SUNRISE_COORDS } from './sunrise.mjs';
import { SODA_NEIGHBOR_SLUGS } from './stations.mjs';
import { FLOW_CLASS_VERSION_V1 } from './versions.mjs';
import { zonedTimeFrom } from './zone.mjs';

export const FLOW_CLASSES = [
  'katabatic',
  'transition-hybrid',
  'synoptic',
  'absent',
  'unknown',
];

const TARGET_STEP_MIN = 5;
const MAX_NEIGHBOR_STEP_MIN = 30;
const CHECKPOINT_STEP_MIN = 15;
const PULSE_MINUTES = 30;
const IDEAL_MIN_DEG = 270;
const IDEAL_MAX_DEG = 330;
const IDEAL_PCT = 80;
const LOCAL_RATIO = 0.5;
const REGIONAL_RATIO = 0.9;

function cycleMinutes(cycleType) {
  const match = /^(\d+)min$/.exec(cycleType ?? '');
  return match ? Number(match[1]) : null;
}

function inIdealDirection(direction) {
  return Number.isFinite(direction) && direction >= IDEAL_MIN_DEG && direction <= IDEAL_MAX_DEG;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pointsIn(record, startTs, endTs) {
  return record.points.filter((point) => point.ts >= startTs && point.ts < endTs);
}

function hasCoverage(record, startTs, endTs, stepMin) {
  const points = pointsIn(record, startTs, endTs);
  if (!points.length) return false;
  const maxGapSec = stepMin * 60 * 1.5;
  if (points[0].ts - startTs > maxGapSec || endTs - points[points.length - 1].ts > maxGapSec) {
    return false;
  }
  return points.every((point, index) =>
    index === 0 || point.ts - points[index - 1].ts <= maxGapSec
  );
}

function continuousRuns(points, predicate, stepMin) {
  const runs = [];
  let run = null;
  const maxGapSec = stepMin * 60 * 1.5;

  for (const point of points) {
    const contiguous = run && point.ts - run.lastTs <= maxGapSec;
    if (predicate(point)) {
      if (!run || !contiguous) {
        run = {
          startTs: point.ts,
          endTs: point.ts + stepMin * 60,
          lastTs: point.ts,
          points: [point],
        };
      } else {
        run.lastTs = point.ts;
        run.endTs = point.ts + stepMin * 60;
        run.points.push(point);
      }
    } else {
      if (run) runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs.map(({ lastTs, ...result }) => ({
    ...result,
    minutes: result.points.length * stepMin,
  }));
}

function organizedPulses(points) {
  return continuousRuns(
    points,
    (point) => Number(point.speed) >= CANOE_THRESHOLD_MPH,
    TARGET_STEP_MIN,
  ).filter((run) => {
    if (run.minutes < PULSE_MINUTES) return false;
    const directions = run.points.map((point) => Number(point.dir)).filter(Number.isFinite);
    const inIdeal = directions.filter(inIdealDirection).length;
    run.inIdealPct = directions.length ? (inIdeal / directions.length) * 100 : 0;
    return run.inIdealPct >= IDEAL_PCT;
  });
}

function trailingMean(record, checkpointTs, minutes = 30) {
  return mean(
    record.points
      .filter((point) => point.ts > checkpointTs - minutes * 60 && point.ts <= checkpointTs)
      .map((point) => Number(point.speed))
      .filter(Number.isFinite),
  );
}

function checkpointEvidence(target, neighbors, sunriseTs) {
  const date = parseArchiveDate(target.date);
  const start = Math.floor(zonedTimeFrom(date, 0, 30, 0).getTime() / 1000);
  const checkpoints = [];
  for (let ts = start; ts <= sunriseTs; ts += CHECKPOINT_STEP_MIN * 60) {
    const features = computeFeaturesV5(target.points, ts, {
      station: target.station,
      threshold: CANOE_THRESHOLD_MPH,
      sunriseTs,
      neighborSeries: neighbors.map(({ record }) => record.points),
    });
    const structure = classifyKatabaticStructureV5(features);
    const neighborMeans = neighbors.map(({ record }) => trailingMean(record, ts));
    const localContrast =
      features?.avg30 > 0 &&
      neighborMeans.every((neighborMean) =>
        neighborMean !== null && neighborMean / features.avg30 < LOCAL_RATIO
      );
    checkpoints.push({
      ts,
      structure: structure.status,
      structureScore: structure.score,
      avg30: features?.avg30 ?? null,
      neighborMeans,
      localContrast,
    });
  }
  return checkpoints;
}

function hasRegionalConcurrency(pulse, target, neighbors) {
  for (
    let ts = pulse.startTs + PULSE_MINUTES * 60;
    ts <= pulse.endTs;
    ts += CHECKPOINT_STEP_MIN * 60
  ) {
    const targetMean = trailingMean(target, ts);
    const neighborMeans = neighbors.map(({ record }) => trailingMean(record, ts));
    if (
      targetMean !== null &&
      targetMean >= CANOE_THRESHOLD_MPH &&
      neighborMeans.every((neighborMean) =>
        neighborMean !== null && neighborMean / targetMean >= REGIONAL_RATIO
      )
    ) {
      return true;
    }
  }
  return false;
}

function unknown(reason, evidence = {}) {
  return {
    flowClassVersion: FLOW_CLASS_VERSION_V1,
    flowClass: 'unknown',
    reasons: [reason],
    evidence,
  };
}

/**
 * Classify one completed Soda morning.
 *
 * `neighbors` must be `{ slug, record }` entries for every canonical Soda neighbor.
 */
export function classifyFlow(target, neighbors = []) {
  if (!target || target.status !== 'ok' || !target.points?.length) {
    return unknown('target observations are unavailable');
  }
  if (cycleMinutes(target.cycle_type) !== TARGET_STEP_MIN) {
    return unknown('target observations are not at 5-minute resolution');
  }

  const bySlug = new Map(neighbors.map((neighbor) => [neighbor.slug, neighbor.record]));
  const missingNeighbor = SODA_NEIGHBOR_SLUGS.find((slug) => !bySlug.has(slug));
  if (missingNeighbor) return unknown(`required neighbor ${missingNeighbor} is unavailable`);

  const canonicalNeighbors = SODA_NEIGHBOR_SLUGS.map((slug) => ({
    slug,
    record: bySlug.get(slug),
  }));
  for (const { slug, record } of canonicalNeighbors) {
    const step = cycleMinutes(record?.cycle_type);
    if (
      !record ||
      record.status !== 'ok' ||
      !record.points?.length ||
      step === null ||
      step > MAX_NEIGHBOR_STEP_MIN
    ) {
      return unknown(`required neighbor ${slug} is unavailable or too coarse`);
    }
  }

  const date = parseArchiveDate(target.date);
  const sunrise = calcSunrise(date, SUNRISE_COORDS.lat, SUNRISE_COORDS.lng);
  if (!sunrise) return unknown('sunrise could not be calculated');
  const startTs = Math.floor(zonedTimeFrom(date, 0, 0, 0).getTime() / 1000);
  const sunriseTs = Math.floor(sunrise.getTime() / 1000);
  const endTs = sunriseTs + MAX_MINUTES_PAST_SUNRISE * 60;
  const gateTs = Math.floor(gateOpenTime(date).getTime() / 1000);

  if (!hasCoverage(target, startTs, endTs, TARGET_STEP_MIN)) {
    return unknown('target coverage has a gap in the physical morning');
  }
  for (const { slug, record } of canonicalNeighbors) {
    if (!hasCoverage(record, startTs, endTs, cycleMinutes(record.cycle_type))) {
      return unknown(`neighbor ${slug} coverage has a gap in the physical morning`);
    }
  }

  const targetPoints = pointsIn(target, startTs, endTs);
  const pulses = organizedPulses(targetPoints);
  const collapses = continuousRuns(
    targetPoints,
    (point) => Number(point.speed) < CANOE_THRESHOLD_MPH,
    TARGET_STEP_MIN,
  ).filter((run) => run.minutes >= PULSE_MINUTES);
  const checkpoints = checkpointEvidence(target, canonicalNeighbors, sunriseTs);
  const present = checkpoints.filter((checkpoint) => checkpoint.structure === 'PRESENT');
  const local = present.filter((checkpoint) => checkpoint.localContrast);
  const regionalPulses = pulses.filter((pulse) =>
    hasRegionalConcurrency(pulse, target, canonicalNeighbors)
  );

  let transition = null;
  for (const pulse of pulses.filter((candidate) => candidate.endTs > gateTs)) {
    const collapse = collapses.find((candidate) =>
      candidate.endTs <= pulse.startTs &&
      (
        checkpoints.some((checkpoint) =>
          checkpoint.ts < candidate.startTs && checkpoint.structure === 'PRESENT'
        ) ||
        pulses.some((priorPulse) => priorPulse.endTs <= candidate.startTs)
      )
    );
    if (collapse) {
      transition = { collapse, pulse };
      break;
    }
  }

  const evidence = {
    checkpointCount: checkpoints.length,
    presentCheckpointCount: present.length,
    localContrastCheckpointCount: local.length,
    organizedPulses: pulses.map((pulse) => ({
      startTs: pulse.startTs,
      endTs: pulse.endTs,
      minutes: pulse.minutes,
      inIdealPct: pulse.inIdealPct,
    })),
    regionalPulseCount: regionalPulses.length,
  };

  if (transition) {
    return {
      flowClassVersion: FLOW_CLASS_VERSION_V1,
      flowClass: 'transition-hybrid',
      reasons: [
        'organized pre-sunrise drainage was separated from a later W/NW pulse by a qualifying collapse',
      ],
      evidence: {
        ...evidence,
        collapseStartTs: transition.collapse.startTs,
        collapseEndTs: transition.collapse.endTs,
        secondPulseStartTs: transition.pulse.startTs,
        secondPulseEndTs: transition.pulse.endTs,
      },
    };
  }

  if (local.length && regionalPulses.length) {
    return unknown('local and regional evidence conflict', evidence);
  }
  if (local.length) {
    return {
      flowClassVersion: FLOW_CLASS_VERSION_V1,
      flowClass: 'katabatic',
      reasons: ['pre-sunrise structure was present with both neighbors comparatively calm'],
      evidence,
    };
  }
  if (regionalPulses.length) {
    return {
      flowClassVersion: FLOW_CLASS_VERSION_V1,
      flowClass: 'synoptic',
      reasons: ['an organized W/NW Soda pulse had concurrent wind at both neighbors'],
      evidence,
    };
  }
  if (
    checkpoints.length &&
    checkpoints.every((checkpoint) => checkpoint.structure === 'ABSENT') &&
    !pulses.length
  ) {
    return {
      flowClassVersion: FLOW_CLASS_VERSION_V1,
      flowClass: 'absent',
      reasons: [
        'all pre-sunrise structure checkpoints were absent and no organized W/NW pulse formed',
      ],
      evidence,
    };
  }
  return unknown('available evidence does not distinguish the physical mechanism', evidence);
}
